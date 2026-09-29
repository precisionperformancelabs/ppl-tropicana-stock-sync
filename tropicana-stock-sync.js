"use strict";

const SFTP = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');
const crypto = require('crypto');

const REQUIRED = [
  'TROPICANA_SFTP_USER',
  'TROPICANA_SFTP_PASSWORD',
  'SHOPIFY_CLIENT_ID',
  'SHOPIFY_CLIENT_SECRET',
  'SHOPIFY_STORE_DOMAIN'
];

for (const key of REQUIRED) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const apiVersion = '2026-07';
const BUILD_MARKER = 'PPL-STOCK-SYNC-2026-09-29-V6-SAFE-XML';

const OWN_30 = 'gid://shopify/Location/120937251150';
const TROPSHIP = 'gid://shopify/Location/125063037262';
const SYNCEE = 'gid://shopify/Location/124613067086';

const TARGET_SKUS = new Set([
  'APP486',
  'PER458',
  'PER459',
  'PER460'
]);

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const normSku = value =>
  String(value ?? '').trim().toUpperCase();

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
        'content-type': 'application/x-www-form-urlencoded'
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

async function gql(accessToken, query, variables = {}) {
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await fetch(
      `https://${shop}/admin/api/${apiVersion}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-shopify-access-token': accessToken
        },
        body: JSON.stringify({
          query,
          variables
        })
      }
    );

    const raw = await r.text();

    let j;

    try {
      j = JSON.parse(raw);
    } catch {
      throw new Error(
        `Shopify returned invalid JSON: ${raw.slice(0, 500)}`
      );
    }

    const throttled =
      r.status === 429 ||
      (
        Array.isArray(j.errors) &&
        j.errors.some(
          e => e?.extensions?.code === 'THROTTLED'
        )
      );

    if (throttled) {
      if (attempt === maxAttempts) {
        throw new Error(
          `Shopify GraphQL still throttled after ${maxAttempts} attempts`
        );
      }

      const ts = j.extensions?.cost?.throttleStatus;

      const requested =
        j.extensions?.cost?.requestedQueryCost ?? 100;

      const available =
        ts?.currentlyAvailable ?? 0;

      const restoreRate =
        ts?.restoreRate ?? 50;

      const deficit =
        Math.max(1, requested - available);

      const waitMs =
        Math.max(
          1000,
          Math.min(
            20000,
            Math.ceil(deficit / restoreRate * 1000) + 750
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
        `Shopify GraphQL failed: ${JSON.stringify(j.errors || j)}`
      );
    }

    return j.data;
  }

  throw new Error(
    'Shopify GraphQL retry loop ended unexpectedly'
  );
}

function records(node, out = []) {
  if (Array.isArray(node)) {
    for (const v of node) {
      records(v, out);
    }
  } else if (node && typeof node === 'object') {
    if (
      Object.prototype.hasOwnProperty.call(
        node,
        'ProductCode'
      )
    ) {
      out.push(node);
    }

    for (const v of Object.values(node)) {
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
        Object.prototype.hasOwnProperty.call(
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
    String(row[present[0]]).trim();

  if (
    /^(out\s*of\s*stock|no|false|none)$/i.test(raw)
  ) {
    return 0;
  }

  if (
    !/^-?\d+(?:\.0+)?$/.test(raw)
  ) {
    throw new Error(
      `Invalid quantity for ` +
      `${row.ProductCode}: ` +
      `field=${present[0]} ` +
      `value=${JSON.stringify(raw)}`
    );
  }

  const n = Number(raw);

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

/*
 * SAFE XML PREPARATION
 *
 * The previous V5 sent the downloaded supplier file directly
 * into fast-xml-parser.
 *
 * V6:
 * - validates the SFTP result
 * - strips UTF-8 BOM
 * - strips illegal XML control characters
 * - rejects empty/non-XML responses
 * - gives useful diagnostics if parsing fails
 *
 * It DOES NOT invent stock or continue with an unparsed feed.
 */
function prepareXml(buffer) {
  if (!buffer) {
    throw new Error(
      'TROPICANA_FEED_DOWNLOAD_RETURNED_NO_DATA'
    );
  }

  let xml;

  if (Buffer.isBuffer(buffer)) {
    xml = buffer.toString('utf8');
  } else {
    xml = String(buffer);
  }

  const originalBytes =
    Buffer.byteLength(xml, 'utf8');

  if (!xml.trim()) {
    throw new Error(
      'TROPICANA_FEED_EMPTY'
    );
  }

  // Remove UTF-8 BOM if present.
  xml = xml.replace(/^\uFEFF/, '');

  // Remove characters XML 1.0 does not permit.
  // Preserve TAB, LF and CR.
  xml = xml.replace(
    /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
    ''
  );

  const trimmed = xml.trim();

  if (!trimmed.startsWith('<')) {
    throw new Error(
      `TROPICANA_FEED_NOT_XML ` +
      `first_chars=${JSON.stringify(trimmed.slice(0, 120))}`
    );
  }

  const cleanedBytes =
    Buffer.byteLength(xml, 'utf8');

  console.log(
    `TROPICANA_XML_RECEIVED ` +
    `original_bytes=${originalBytes} ` +
    `cleaned_bytes=${cleanedBytes}`
  );

  return xml;
}

function parseSupplierXml(xml) {
  const parser =
    new XMLParser({
      trimValues: true,

      // Preserve feed values as strings.
      // feedQuantity performs the safety conversion itself.
      parseTagValue: false,

      parseAttributeValue: false,

      ignoreAttributes: false,

      allowBooleanAttributes: true,

      processEntities: true
    });

  try {
    const parsed =
      parser.parse(xml);

    if (
      !parsed ||
      typeof parsed !== 'object'
    ) {
      throw new Error(
        'Parser returned no usable object'
      );
    }

    console.log(
      'TROPICANA_XML_PARSE_OK'
    );

    return parsed;

  } catch (e) {
    console.error(
      `TROPICANA_XML_PARSE_FAILED ` +
      `${e?.message || e}`
    );

    console.error(
      `TROPICANA_XML_DIAGNOSTICS ` +
      JSON.stringify({
        bytes:
          Buffer.byteLength(
            xml,
            'utf8'
          ),

        firstChars:
          xml.slice(0, 200),

        lastChars:
          xml.slice(-200)
      })
    );

    throw new Error(
      `TROPICANA_FEED_PARSE_FAILED: ` +
      `${e?.message || e}`
    );
  }
}

async function supplierFeed() {
  const s = new SFTP();

  try {
    console.log(
      'TROPICANA_SFTP_CONNECTING'
    );

    await s.connect({
      host:
        'tropicana.ftp.redtechnology.com',
      port: 22,
      username:
        process.env.TROPICANA_SFTP_USER,
      password:
        process.env.TROPICANA_SFTP_PASSWORD,
      readyTimeout: 30000
    });

    console.log(
      'TROPICANA_SFTP_CONNECTED'
    );

    const b =
      await s.get(
        'DropshipProductFeed.xml'
      );

    console.log(
      'TROPICANA_FEED_DOWNLOADED'
    );

    const xml =
      prepareXml(b);

    const parsed =
      parseSupplierXml(xml);

    const rows =
      records(parsed);

    if (!rows.length) {
      throw new Error(
        'TROPICANA_FEED_CONTAINED_ZERO_PRODUCT_ROWS'
      );
    }

    console.log(
      `TROPICANA_PRODUCT_ROWS_FOUND ` +
      `rows=${rows.length}`
    );

    const map =
      new Map();

    const duplicateCodes =
      new Set();

    const conflictingDuplicates =
      new Set();

    for (const row of rows) {
      const sku =
        normSku(
          row.ProductCode
        );

      if (!sku) continue;

      const qty =
        feedQuantity(row);

      if (
        TARGET_SKUS.has(sku)
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
            Object.prototype.hasOwnProperty.call(
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
          JSON.stringify(stockFields)
        );
      }

      if (!map.has(sku)) {
        map.set(
          sku,
          qty
        );
      } else {
        duplicateCodes.add(sku);

        if (
          map.get(sku) !== qty
        ) {
          conflictingDuplicates.add(
            sku
          );
        }
      }
    }

    for (
      const sku of
      conflictingDuplicates
    ) {
      map.delete(sku);
    }

    if (!map.size) {
      throw new Error(
        'TROPICANA_FEED_PRODUCED_ZERO_SAFE_SKUS'
      );
    }

    console.log(
      `FEED_OK ` +
      `rows=${rows.length} ` +
      `unique=${map.size} ` +
      `duplicate_codes_seen=${duplicateCodes.size} ` +
      `conflicting_duplicate_codes_blocked=${conflictingDuplicates.size}`
    );

    return map;

  } finally {
    try {
      await s.end();

      console.log(
        'TROPICANA_SFTP_CLOSED'
      );
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

  return tags.some(
    tag =>
      /^(Supplier:Tropicana|Tropicana Feed|Tropicana Dropship)$/i
        .test(
          String(tag).trim()
        )
  );
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

async function variants(accessToken) {
  const query = `
    query Variants(
      $after:String,
      $own:ID!,
      $drop:ID!,
      $syncee:ID!
    ) {
      productVariants(
        first:25,
        after:$after
      ) {
        nodes {
          id
          sku

          inventoryItem {
            id
            tracked

            ownStock:inventoryLevel(
              locationId:$own
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
              locationId:$drop
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
              locationId:$syncee
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
          own: OWN_30,
          drop: TROPSHIP,
          syncee: SYNCEE
        }
      );

    all.push(
      ...d.productVariants.nodes
    );

    page++;

    if (
      page % 10 === 0 ||
      !d.productVariants.pageInfo.hasNextPage
    ) {
      console.log(
        `SHOPIFY_VARIANTS_PAGE ` +
        `page=${page} ` +
        `total=${all.length}`
      );
    }

    after =
      d.productVariants.pageInfo.hasNextPage
        ? d.productVariants.pageInfo.endCursor
        : null;

    if (after) {
      await sleep(500);
    }

  } while (after);

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
  inventoryItemId
) {
  const mutation = `
    mutation Track(
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
          tracked: true
        }
      }
    );

  const errs =
    d.inventoryItemUpdate
      .userErrors;

  if (errs.length) {
    throw new Error(
      `Tracking update failed: ` +
      JSON.stringify(errs)
    );
  }

  if (
    d.inventoryItemUpdate
      .inventoryItem
      ?.tracked !== true
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

  if (
    actual !== quantity
  ) {
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
          TROPSHIP,

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
      TROPSHIP
    );

  if (
    actual !== quantity
  ) {
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
    mutation Toggle(
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
      JSON.stringify(errs)
    );
  }

  const actual =
    await readAvailable(
      accessToken,
      inventoryItemId,
      locationId
    );

  if (
    actual !== null
  ) {
    throw new Error(
      `${label} still active ` +
      `after deactivation; ` +
      `quantity=${actual}`
    );
  }
}

(async () => {

  console.log(
    `BUILD_MARKER ${BUILD_MARKER}`
  );

  const feed =
    await supplierFeed();

  for (
    const sku of
    TARGET_SKUS
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

  for (
    const sku of
    TARGET_SKUS
  ) {
    const matches =
      all.filter(
        v =>
          normSku(
            v.sku
          ) === sku
      );

    if (
      !matches.length
    ) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${sku} ` +
        `matches=0`
      );
    }

    for (
      const v of
      matches
    ) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${sku} ` +
        `title=${JSON.stringify(
          v.product?.title || ''
        )} ` +
        `status=${v.product?.status} ` +
        `tropicana=${isTropicanaVariant(v)} ` +
        `tracked=${v.inventoryItem?.tracked} ` +
        `dropship=${availableAt(
          v.inventoryItem?.dropship
        )} ` +
        `own30=${availableAt(
          v.inventoryItem?.ownStock
        )} ` +
        `syncee=${availableAt(
          v.inventoryItem?.syncee
        )}`
      );
    }
  }

  const bySku =
    new Map();

  const tropicanaStoreSkus =
    new Set();

  for (
    const v of all
  ) {
    if (
      !isTropicanaVariant(v)
    ) {
      continue;
    }

    const sku =
      normSku(v.sku);

    if (!sku) {
      continue;
    }

    tropicanaStoreSkus.add(sku);

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
          !tropicanaStoreSkus.has(sku)
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
    `tropicana_shopify_skus=${tropicanaStoreSkus.size} ` +
    `matched=${bySku.size} ` +
    `feed_without_shopify=${feedWithoutShopify.length} ` +
    `shopify_without_feed=${shopifyWithoutFeed.length}`
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
    of bySku.entries()
  ) {

    const active =
      list.filter(
        v =>
          v.product &&
          v.product.status ===
          'ACTIVE'
      );

    if (
      active.length !== 1
    ) {
      console.error(
        `BLOCKED ` +
        `sku=${sku} ` +
        `active_matches=${active.length} ` +
        `all_tropicana_matches=${list.length}`
      );

      blocked++;

      continue;
    }

    const v =
      active[0];

    const wanted =
      feed.get(sku);

    let productChanged =
      false;

    try {

      if (
        !v.inventoryItem?.tracked
      ) {
        await setTracking(
          accessToken,
          v.inventoryItem.id
        );

        console.log(
          `TRACKING_ENABLED ` +
          `sku=${sku}`
        );

        trackingEnabled++;
        productChanged = true;

        await sleep(250);
      }

      let dropshipCurrent =
        availableAt(
          v.inventoryItem?.dropship
        );

      if (
        TARGET_SKUS.has(sku)
      ) {
        console.log(
          `TARGET_BEFORE ` +
          `sku=${sku} ` +
          `wanted=${wanted} ` +
          `dropship=${dropshipCurrent} ` +
          `own30=${availableAt(
            v.inventoryItem?.ownStock
          )} ` +
          `syncee=${availableAt(
            v.inventoryItem?.syncee
          )}`
        );
      }

      if (
        dropshipCurrent === null
      ) {
        await activateAtDropship(
          accessToken,
          v.inventoryItem.id,
          wanted
        );

        console.log(
          `DROPSHIP_ACTIVATED ` +
          `sku=${sku} ` +
          `quantity=${wanted}`
        );

        dropshipActivated++;
        changed++;

        productChanged = true;
        dropshipCurrent = wanted;

        await sleep(250);

      } else if (
        dropshipCurrent !== wanted
      ) {

        await setQuantity(
          accessToken,
          v.inventoryItem.id,
          TROPSHIP,
          wanted,
          dropshipCurrent,
          'Tropicana Dropship'
        );

        console.log(
          `VERIFIED ` +
          `sku=${sku} ` +
          `location=Tropicana Dropship ` +
          `from=${dropshipCurrent} ` +
          `to=${wanted}`
        );

        changed++;

        productChanged = true;
        dropshipCurrent = wanted;

        await sleep(250);
      }

      if (
        v.inventoryItem?.ownStock
      ) {
        await deactivateLocation(
          accessToken,
          v.inventoryItem.id,
          OWN_30,
          '30'
        );

        console.log(
          `WRONG_LOCATION_DEACTIVATED ` +
          `sku=${sku} ` +
          `location=30`
        );

        ownStockDeactivated++;

        productChanged = true;

        await sleep(250);
      }

      if (
        v.inventoryItem?.syncee
      ) {
        await deactivateLocation(
          accessToken,
          v.inventoryItem.id,
          SYNCEE,
          'Syncee'
        );

        console.log(
          `STALE_LOCATION_DEACTIVATED ` +
          `sku=${sku} ` +
          `location=Syncee`
        );

        synceeDeactivated++;

        productChanged = true;

        await sleep(250);
      }

      if (
        TARGET_SKUS.has(sku)
      ) {
        const afterDropship =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            TROPSHIP
          );

        await sleep(100);

        const afterOwn30 =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            OWN_30
          );

        await sleep(100);

        const afterSyncee =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            SYNCEE
          );

        console.log(
          `TARGET_AFTER ` +
          `sku=${sku} ` +
          `dropship=${afterDropship} ` +
          `own30=${afterOwn30} ` +
          `syncee=${afterSyncee}`
        );
      }

      if (!productChanged) {
        unchanged++;
      }

    } catch (e) {

      console.error(
        `BLOCKED ` +
        `sku=${sku} ` +
        `update_failed=${e.message}`
      );

      blocked++;
    }
  }

  console.log(
    `SYNC_COMPLETE ` +
    `changed=${changed} ` +
    `unchanged=${unchanged} ` +
    `tracking_enabled=${trackingEnabled} ` +
    `dropship_activated=${dropshipActivated} ` +
    `own_location_deactivated=${ownStockDeactivated} ` +
    `syncee_deactivated=${synceeDeactivated} ` +
    `blocked=${blocked} ` +
    `matched_skus=${bySku.size}`
  );

})().catch(e => {

  console.error(
    'SYNC_FAILED',
    e.stack || e
  );

  process.exit(1);
});
