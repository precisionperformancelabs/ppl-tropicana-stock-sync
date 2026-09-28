const SFTP = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('crypto');

const required = [
  'TROPICANA_SFTP_USER',
  'TROPICANA_SFTP_PASSWORD',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_STORE_DOMAIN'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const apiVersion = '2026-07';

const BUILD_MARKER =
  'PPL-STOCK-SYNC-2026-09-28-V4-THROTTLE-SAFE';

// PPL's own-stock location.
// Tropicana products must NOT remain stocked here.
const ownStockLocationId =
  'gid://shopify/Location/120937251150'; // "30"

// All Tropicana/TropShip supplier inventory belongs here.
const tropicanaDropshipLocationId =
  'gid://shopify/Location/125063037262'; // "Tropicana Dropship"

// Old Syncee stock must not contribute to Tropicana products.
const synceeLocationId =
  'gid://shopify/Location/124613067086'; // "Syncee"

const TARGET_SKUS = [
  'APP486', // Applied Nutrition Black Stak
  'PER458',
  'PER459',
  'PER460'
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normaliseSku(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase();
}

async function token() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.SHOPIFY_CLIENT_ID,
    client_secret: process.env.SHOPIFY_CLIENT_SECRET
  });

  const r = await fetch(
    `https://${shop}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        'content-type':
          'application/x-www-form-urlencoded'
      },
      body
    }
  );

  if (!r.ok) {
    throw new Error(
      `Shopify token failed ${r.status}: ${await r.text()}`
    );
  }

  return (await r.json()).access_token;
}

async function gql(
  accessToken,
  query,
  variables = {}
) {
  const maxAttempts = 8;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const r = await fetch(
      `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-access-token':
            accessToken
        },
        body: JSON.stringify({
          query,
          variables
        })
      }
    );

    const responseText =
      await r.text();

    let j;

    try {
      j = JSON.parse(responseText);
    } catch {
      throw new Error(
        `Shopify returned invalid JSON: ` +
        `${responseText.slice(0, 500)}`
      );
    }

    const throttled =
      r.status === 429 ||
      (
        Array.isArray(j.errors) &&
        j.errors.some(
          e =>
            e?.extensions?.code ===
            'THROTTLED'
        )
      );

    if (throttled) {
      if (
        attempt === maxAttempts
      ) {
        throw new Error(
          `Shopify GraphQL still throttled ` +
          `after ${maxAttempts} attempts`
        );
      }

      const throttle =
        j.extensions?.cost
          ?.throttleStatus;

      const requested =
        j.extensions?.cost
          ?.requestedQueryCost ?? 100;

      const available =
        throttle
          ?.currentlyAvailable ?? 0;

      const restoreRate =
        throttle
          ?.restoreRate ?? 50;

      const deficit =
        Math.max(
          1,
          requested - available
        );

      const calculatedWait =
        Math.ceil(
          (deficit / restoreRate) *
          1000
        ) + 500;

      const waitMs =
        Math.max(
          1000,
          Math.min(
            15000,
            calculatedWait
          )
        );

      console.warn(
        `SHOPIFY_THROTTLED ` +
        `attempt=${attempt}/${maxAttempts} ` +
        `waiting_ms=${waitMs}`
      );

      await sleep(waitMs);

      continue;
    }

    if (!r.ok || j.errors) {
      throw new Error(
        `Shopify GraphQL failed: ` +
        `${JSON.stringify(
          j.errors || j
        )}`
      );
    }

    return j.data;
  }

  throw new Error(
    'Shopify GraphQL retry loop ended unexpectedly'
  );
}

function records(
  node,
  out = []
) {
  if (Array.isArray(node)) {
    for (const v of node) {
      records(v, out);
    }

  } else if (
    node &&
    typeof node === 'object'
  ) {
    if (
      Object.prototype
        .hasOwnProperty.call(
          node,
          'ProductCode'
        )
    ) {
      out.push(node);
    }

    for (
      const v of
      Object.values(node)
    ) {
      records(v, out);
    }
  }

  return out;
}

function feedQuantity(row) {
  const keys = [
    'StockLevel',
    'StockQuantity',
    'StockQty',
    'FreeStock',
    'AvailableStock',
    'QuantityAvailable',
    'AvailableQuantity',
    'QtyInStock'
  ];

  const present =
    keys.filter(
      k =>
        Object.prototype
          .hasOwnProperty.call(
            row,
            k
          )
    );

  if (present.length !== 1) {
    throw new Error(
      `Unsafe stock fields for ` +
      `${row.ProductCode}: ` +
      `${present.join(',') || 'none'}; ` +
      `keys=${Object.keys(row).join(',')}`
    );
  }

  const raw =
    String(
      row[present[0]]
    ).trim();

  if (
    /^(out\s*of\s*stock|no|false|none)$/i
      .test(raw)
  ) {
    return 0;
  }

  if (
    !/^-?\d+(?:\.0+)?$/
      .test(raw)
  ) {
    throw new Error(
      `Invalid quantity for ` +
      `${row.ProductCode}: ` +
      `field=${present[0]} ` +
      `value=${JSON.stringify(raw)}`
    );
  }

  const n =
    Number(raw);

  if (
    !Number.isSafeInteger(n) ||
    n > 1000000
  ) {
    throw new Error(
      `Invalid quantity for ` +
      `${row.ProductCode}: ` +
      `field=${present[0]} ` +
      `value=${JSON.stringify(raw)}`
    );
  }

  if (n < 0) {
    console.warn(
      `NEGATIVE_STOCK_CLAMPED ` +
      `${row.ProductCode} ${n}->0`
    );

    return 0;
  }

  return n;
}

async function supplierFeed() {
  const s =
    new SFTP();

  try {
    await s.connect({
      host:
        'tropicana.ftp.redtechnology.com',
      port: 22,
      username:
        process.env
          .TROPICANA_SFTP_USER,
      password:
        process.env
          .TROPICANA_SFTP_PASSWORD,
      readyTimeout: 30000
    });

    const b =
      await s.get(
        'DropshipProductFeed.xml'
      );

    const parsed =
      new XMLParser({
        trimValues: true,
        parseTagValue: false
      }).parse(
        b.toString()
      );

    const rows =
      records(parsed);

    const map =
      new Map();

    const duplicateCodes =
      new Set();

    const conflictingDuplicates =
      new Set();

    for (const row of rows) {
      const sku =
        normaliseSku(
          row.ProductCode
        );

      if (!sku) {
        continue;
      }

      const qty =
        feedQuantity(row);

      /*
       * Diagnostic:
       * show the actual stock field
       * Tropicana supplies for our
       * test SKUs, including APP486.
       */
      if (
        TARGET_SKUS.includes(sku)
      ) {
        const stockFields = {};

        for (
          const key of [
            'StockLevel',
            'StockQuantity',
            'StockQty',
            'FreeStock',
            'AvailableStock',
            'QuantityAvailable',
            'AvailableQuantity',
            'QtyInStock'
          ]
        ) {
          if (
            Object.prototype
              .hasOwnProperty.call(
                row,
                key
              )
          ) {
            stockFields[key] =
              row[key];
          }
        }

        console.log(
          `TARGET_FEED_ROW ` +
          `sku=${sku} ` +
          `stock_fields=` +
          `${JSON.stringify(
            stockFields
          )}`
        );
      }

      if (!map.has(sku)) {
        map.set(
          sku,
          qty
        );

        continue;
      }

      duplicateCodes.add(sku);

      if (
        map.get(sku) !== qty
      ) {
        conflictingDuplicates
          .add(sku);
      }
    }

    /*
     * Tropicana repeats ProductCode
     * rows across categories.
     *
     * Keep duplicate rows where
     * stock agrees.
     *
     * Block only genuine conflicts.
     */
    for (
      const sku of
      conflictingDuplicates
    ) {
      map.delete(sku);
    }

    console.log(
      `FEED_OK ` +
      `rows=${rows.length} ` +
      `unique=${map.size} ` +
      `duplicate_codes_seen=` +
      `${duplicateCodes.size} ` +
      `conflicting_duplicate_codes_blocked=` +
      `${conflictingDuplicates.size}`
    );

    return map;

  } finally {
    try {
      await s.end();
    } catch {}
  }
}

function isTropicanaVariant(v) {
  const tags =
    Array.isArray(
      v.product?.tags
    )
      ? v.product.tags
      : [];

  return tags.some(tag => {
    const t =
      String(tag).trim();

    return (
      /^Supplier:Tropicana$/i
        .test(t) ||

      /^Tropicana Feed$/i
        .test(t) ||

      /^Tropicana Dropship$/i
        .test(t)
    );
  });
}

function availableAt(level) {
  if (!level) {
    return null;
  }

  const q =
    level.quantities
      ?.find(
        x =>
          x.name ===
          'available'
      )
      ?.quantity;

  return Number.isInteger(q)
    ? q
    : null;
}

async function variants(
  accessToken
) {
  const query = `
    query Variants(
      $after:String,
      $ownStockLocationId:ID!,
      $tropicanaDropshipLocationId:ID!,
      $synceeLocationId:ID!
    ) {
      productVariants(
        first:50,
        after:$after
      ) {
        nodes {
          id
          sku

          inventoryItem {
            id
            tracked

            ownStock:inventoryLevel(
              locationId:
                $ownStockLocationId
            ) {
              id

              quantities(
                names:["available"]
              ) {
                name
                quantity
              }
            }

            dropship:inventoryLevel(
              locationId:
                $tropicanaDropshipLocationId
            ) {
              id

              quantities(
                names:["available"]
              ) {
                name
                quantity
              }
            }

            syncee:inventoryLevel(
              locationId:
                $synceeLocationId
            ) {
              id

              quantities(
                names:["available"]
              ) {
                name
                quantity
              }
            }
          }

          product {
            id
            title
            status
            tags
          }
        }

        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const all = [];
  let after = null;
  let page = 0;

  do {
    const d =
      await gql(
        accessToken,
        query,
        {
          after,
          ownStockLocationId,
          tropicanaDropshipLocationId,
          synceeLocationId
        }
      );

    all.push(
      ...d.productVariants.nodes
    );

    page++;

    console.log(
      `SHOPIFY_VARIANTS_PAGE ` +
      `page=${page} ` +
      `fetched=` +
      `${d.productVariants.nodes.length} ` +
      `total=${all.length}`
    );

    after =
      d.productVariants
        .pageInfo
        .hasNextPage
        ? d.productVariants
            .pageInfo
            .endCursor
        : null;

    /*
     * Give Shopify breathing room
     * between catalogue pages.
     */
    if (after) {
      await sleep(300);
    }

  } while (after);

  console.log(
    `SHOPIFY_VARIANTS_COMPLETE ` +
    `total=${all.length}`
  );

  return all;
}

async function readAvailable(
  accessToken,
  inventoryItemId,
  locationId
) {
  const query = `
    query ReadBack(
      $id:ID!,
      $locationId:ID!
    ) {
      inventoryItem(
        id:$id
      ) {
        inventoryLevel(
          locationId:$locationId
        ) {
          quantities(
            names:["available"]
          ) {
            name
            quantity
          }
        }
      }
    }
  `;

  const d =
    await gql(
      accessToken,
      query,
      {
        id:
          inventoryItemId,

        locationId
      }
    );

  return availableAt(
    d.inventoryItem
      ?.inventoryLevel
  );
}

async function setTracking(
  accessToken,
  inventoryItemId,
  tracked
) {
  const mutation = `
    mutation InventoryTracking(
      $id:ID!,
      $input:InventoryItemInput!
    ) {
      inventoryItemUpdate(
        id:$id,
        input:$input
      ) {
        inventoryItem {
          id
          tracked
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const d =
    await gql(
      accessToken,
      mutation,
      {
        id:
          inventoryItemId,

        input: {
          tracked
        }
      }
    );

  const errs =
    d.inventoryItemUpdate
      .userErrors;

  if (errs.length) {
    throw new Error(
      `Tracking update failed: ` +
      `${JSON.stringify(errs)}`
    );
  }

  if (
    d.inventoryItemUpdate
      .inventoryItem
      ?.tracked !== tracked
  ) {
    throw new Error(
      'Tracking read-back mismatch'
    );
  }
}

async function setQuantity(
  accessToken,
  inventoryItemId,
  locationId,
  quantity,
  compareQuantity,
  label
) {
  const mutation = `
    mutation SetInventory(
      $input:
        InventorySetQuantitiesInput!,
      $key:String!
    ) {
      inventorySetQuantities(
        input:$input
      )
      @idempotent(
        key:$key
      ) {
        inventoryAdjustmentGroup {
          changes {
            name
            delta
            quantityAfterChange
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const input = {
    name:
      'available',

    reason:
      'correction',

    referenceDocumentUri:
      `gid://ppl-tropicana-sync/` +
      `StockSync/${Date.now()}`,

    quantities: [
      {
        inventoryItemId,
        locationId,
        quantity,

        changeFromQuantity:
          compareQuantity
      }
    ]
  };

  const d =
    await gql(
      accessToken,
      mutation,
      {
        input,

        key:
          crypto.randomUUID()
      }
    );

  const errs =
    d.inventorySetQuantities
      .userErrors;

  if (errs.length) {
    throw new Error(
      JSON.stringify(errs)
    );
  }

  const actual =
    await readAvailable(
      accessToken,
      inventoryItemId,
      locationId
    );

  if (actual !== quantity) {
    throw new Error(
      `Read-back mismatch ` +
      `location=${label} ` +
      `expected=${quantity} ` +
      `got=${actual}`
    );
  }
}

async function activateAtDropship(
  accessToken,
  inventoryItemId,
  quantity
) {
  const mutation = `
    mutation Activate(
      $inventoryItemId:ID!,
      $locationId:ID!,
      $available:Int,
      $key:String!
    ) {
      inventoryActivate(
        inventoryItemId:
          $inventoryItemId,

        locationId:
          $locationId,

        available:
          $available
      )
      @idempotent(
        key:$key
      ) {
        inventoryLevel {
          id

          quantities(
            names:["available"]
          ) {
            name
            quantity
          }
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const d =
    await gql(
      accessToken,
      mutation,
      {
        inventoryItemId,

        locationId:
          tropicanaDropshipLocationId,

        available:
          quantity,

        key:
          crypto.randomUUID()
      }
    );

  const errs =
    d.inventoryActivate
      .userErrors;

  if (errs.length) {
    throw new Error(
      JSON.stringify(errs)
    );
  }

  const actual =
    await readAvailable(
      accessToken,
      inventoryItemId,
      tropicanaDropshipLocationId
    );

  if (actual !== quantity) {
    throw new Error(
      `Dropship activation ` +
      `read-back mismatch ` +
      `expected=${quantity} ` +
      `got=${actual}`
    );
  }
}

async function deactivateLocation(
  accessToken,
  inventoryItemId,
  locationId,
  label
) {
  const mutation = `
    mutation ToggleLocation(
      $inventoryItemId:ID!,
      $updates:
        [InventoryBulkToggleActivationInput!]!
    ) {
      inventoryBulkToggleActivation(
        inventoryItemId:
          $inventoryItemId,

        inventoryItemUpdates:
          $updates
      ) {
        inventoryItem {
          id
        }

        userErrors {
          field
          message
        }
      }
    }
  `;

  const d =
    await gql(
      accessToken,
      mutation,
      {
        inventoryItemId,

        updates: [
          {
            locationId,
            activate: false
          }
        ]
      }
    );

  const errs =
    d.inventoryBulkToggleActivation
      .userErrors;

  if (errs.length) {
    throw new Error(
      `Failed to deactivate ` +
      `${label}: ` +
      `${JSON.stringify(errs)}`
    );
  }

  const actual =
    await readAvailable(
      accessToken,
      inventoryItemId,
      locationId
    );

  if (actual !== null) {
    throw new Error(
      `${label} still active ` +
      `after deactivation; ` +
      `quantity=${actual}`
    );
  }
}

(async () => {
  console.log(
    `BUILD_MARKER ` +
    `${BUILD_MARKER}`
  );

  const feed =
    await supplierFeed();

  /*
   * Always report exactly what
   * Tropicana's feed says for
   * our diagnostic SKUs.
   */
  for (
    const sku of TARGET_SKUS
  ) {
    console.log(
      `TARGET_FEED ` +
      `sku=${sku} ` +
      `quantity=${
        feed.has(sku)
          ? feed.get(sku)
          : 'MISSING_OR_CONFLICT'
      }`
    );
  }

  const accessToken =
    await token();

  const all =
    await variants(
      accessToken
    );

  /*
   * Show Shopify state for the
   * same diagnostic SKUs.
   */
  for (
    const targetSku
      of TARGET_SKUS
  ) {
    const targetMatches =
      all.filter(
        v =>
          normaliseSku(
            v.sku
          ) === targetSku
      );

    if (
      !targetMatches.length
    ) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${targetSku} ` +
        `matches=0`
      );
    }

    for (
      const v
      of targetMatches
    ) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${targetSku} ` +

        `title=${JSON.stringify(
          v.product?.title || ''
        )} ` +

        `status=` +
        `${v.product?.status} ` +

        `tropicana=` +
        `${isTropicanaVariant(v)} ` +

        `tracked=` +
        `${v.inventoryItem?.tracked} ` +

        `dropship=` +
        `${availableAt(
          v.inventoryItem
            ?.dropship
        )} ` +

        `own30=` +
        `${availableAt(
          v.inventoryItem
            ?.ownStock
        )} ` +

        `syncee=` +
        `${availableAt(
          v.inventoryItem
            ?.syncee
        )}`
      );
    }
  }

  const bySku =
    new Map();

  const tropicanaStoreSkus =
    new Set();

  for (const v of all) {
    /*
     * CRITICAL:
     * Never touch a non-Tropicana
     * product merely because its
     * SKU exists in the Tropicana
     * supplier feed.
     */
    if (
      !isTropicanaVariant(v)
    ) {
      continue;
    }

    const sku =
      normaliseSku(
        v.sku
      );

    if (!sku) {
      continue;
    }

    tropicanaStoreSkus
      .add(sku);

    if (
      !feed.has(sku)
    ) {
      continue;
    }

    if (
      !bySku.has(sku)
    ) {
      bySku.set(
        sku,
        []
      );
    }

    bySku
      .get(sku)
      .push(v);
  }

  const feedWithoutShopify =
    [...feed.keys()]
      .filter(
        sku =>
          !tropicanaStoreSkus
            .has(sku)
      );

  const shopifyWithoutFeed =
    [...tropicanaStoreSkus]
      .filter(
        sku =>
          !feed.has(sku)
      );

  console.log(
    `MATCH_AUDIT ` +
    `feed=${feed.size} ` +
    `tropicana_shopify_skus=` +
    `${tropicanaStoreSkus.size} ` +
    `matched=${bySku.size} ` +
    `feed_without_shopify=` +
    `${feedWithoutShopify.length} ` +
    `shopify_without_feed=` +
    `${shopifyWithoutFeed.length}`
  );

  let changed = 0;
  let unchanged = 0;
  let blocked = 0;

  let trackingEnabled = 0;
  let dropshipActivated = 0;

  let ownStockDeactivated = 0;
  let synceeDeactivated = 0;

  for (
    const [sku, list]
      of bySku
  ) {
    const active =
      list.filter(
        v =>
          v.product.status
