const SFTP = require("ssh2-sftp-client");

const { XMLParser } = require("fast-xml-parser");

const required = [

  "TROPICANA_SFTP_USER",

  "TROPICANA_SFTP_PASSWORD",

  "SHOPIFY_CLIENT_ID",

  "SHOPIFY_CLIENT_SECRET",

  "SHOPIFY_STORE_DOMAIN"

];

for (const key of required) {

  if (!process.env[key]) throw new Error(`Missing ${key}`);

}

const shop = process.env.SHOPIFY_STORE_DOMAIN;

const apiVersion = "2026-07";

const locationId = "gid://shopify/Location/125063037262";

async function token() {

  const body = new URLSearchParams({

    grant_type: "client_credentials",

    client_id: process.env.SHOPIFY_CLIENT_ID,

    client_secret: process.env.SHOPIFY_CLIENT_SECRET

  });

  const response = await fetch(

    `https://${shop}/admin/oauth/access_token`,

    {

      method: "POST",

      headers: {

        "content-type": "application/x-www-form-urlencoded"

      },

      body

    }

  );

  if (!response.ok) {

    throw new Error(

      `Shopify token failed ${response.status}: ${await response.text()}`

    );

  }

  return (await response.json()).access_token;

}

async function gql(accessToken, query, variables = {}) {

  const response = await fetch(

    `https://${shop}/admin/api/${apiVersion}/graphql.json`,

    {

      method: "POST",

      headers: {

        "content-type": "application/json",

        "x-shopify-access-token": accessToken

      },

      body: JSON.stringify({ query, variables })

    }

  );

  const result = await response.json();

  if (!response.ok || result.errors) {

    throw new Error(

      `Shopify GraphQL failed: ${JSON.stringify(result.errors || result)}`

    );

  }

  return result.data;

}

function records(node, output = []) {

  if (Array.isArray(node)) {

    for (const value of node) records(value, output);

  } else if (node && typeof node === "object") {

    if (Object.prototype.hasOwnProperty.call(node, "ProductCode")) {

      output.push(node);

    }

    for (const value of Object.values(node)) records(value, output);

  }

  return output;

}

function feedQuantity(row) {

  const keys = [

    "StockLevel",

    "StockQuantity",

    "StockQty",

    "FreeStock",

    "AvailableStock",

    "QuantityAvailable",

    "AvailableQuantity",

    "QtyInStock"

  ];

  const present = keys.filter(key =>

    Object.prototype.hasOwnProperty.call(row, key)

  );

  if (present.length !== 1) {

    throw new Error(

      `Unsafe stock fields for ${row.ProductCode}: ` +

      `${present.join(",") || "none"}; ` +

      `keys=${Object.keys(row).join(",")}`

    );

  }

  const raw = String(row[present[0]]).trim();

  if (/^(out\s*of\s*stock|no|false|none)$/i.test(raw)) return 0;

  if (!/^-?\d+(?:\.0+)?$/.test(raw)) {

    throw new Error(

      `Invalid quantity for ${row.ProductCode}: ` +

      `field=${present[0]} value=${JSON.stringify(raw)}`

    );

  }

  const quantity = Number(raw);

  if (!Number.isSafeInteger(quantity) || quantity > 1000000) {

    throw new Error(

      `Invalid quantity for ${row.ProductCode}: ` +

      `field=${present[0]} value=${JSON.stringify(raw)}`

    );

  }

  if (quantity < 0) {

    console.warn(

      `NEGATIVE_STOCK_CLAMPED ${row.ProductCode} ${quantity}->0`

    );

    return 0;

  }

  return quantity;

}

async function supplierFeed() {

  const sftp = new SFTP();

  try {

    await sftp.connect({

      host: "tropicana.ftp.redtechnology.com",

      port: 22,

      username: process.env.TROPICANA_SFTP_USER,

      password: process.env.TROPICANA_SFTP_PASSWORD,

      readyTimeout: 30000

    });

    const buffer = await sftp.get("DropshipProductFeed.xml");

    const parsed = new XMLParser({

      trimValues: true,

      parseTagValue: false

    }).parse(buffer.toString());

    const rows = records(parsed);

    const stockBySku = new Map();

    const duplicateSkus = new Set();

    for (const row of rows) {

      const sku = String(row.ProductCode ?? "").trim();

      if (!sku) continue;

      const quantity = feedQuantity(row);

      if (stockBySku.has(sku)) {

        duplicateSkus.add(sku);

      } else {

        stockBySku.set(sku, quantity);

      }

    }

    for (const sku of duplicateSkus) {

      stockBySku.delete(sku);

    }

    console.log(

      `FEED_OK rows=${rows.length} ` +

      `unique=${stockBySku.size} ` +

      `duplicate_codes_blocked=${duplicateSkus.size}`

    );

    return stockBySku;

  } finally {

    try {

      await sftp.end();

    } catch {}

  }

}

async function variants(accessToken) {

  const query = `

    query Variants($after: String, $locationId: ID!) {

      productVariants(first: 100, after: $after) {

        nodes {

          id

          sku

          inventoryItem {

            id

            inventoryLevel(locationId: $locationId) {

              quantities(names: ["available"]) {

                name

                quantity

              }

            }

          }

          product {

            id

            status

          }

        }

        pageInfo {

          hasNextPage

          endCursor

        }

      }

    }

  `;

  const allVariants = [];

  let after = null;

  do {

    const data = await gql(accessToken, query, {

      after,

      locationId

    });

    allVariants.push(...data.productVariants.nodes);

    after = data.productVariants.pageInfo.hasNextPage

      ? data.productVariants.pageInfo.endCursor

      : null;

  } while (after);

  return allVariants;

}

async function setQuantity(

  accessToken,

  inventoryItemId,

  quantity,

  currentQuantity

) {

  const mutation = `

    mutation SetInventory(

      $input: InventorySetQuantitiesInput!,

      $key: String!

    ) {

      inventorySetQuantities(input: $input)

        @idempotent(key: $key) {

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

    name: "available",

    reason: "correction",

    referenceDocumentUri:

      `gid://ppl-tropicana-sync/StockSync/${Date.now()}`,

    quantities: [

      {

        inventoryItemId,

        locationId,

        quantity,

        changeFromQuantity: currentQuantity

      }

    ]

  };

  const data = await gql(accessToken, mutation, {

    input,

    key: crypto.randomUUID()

  });

  const errors = data.inventorySetQuantities.userErrors;

  if (errors.length) {

    throw new Error(JSON.stringify(errors));

  }

  const checkQuery = `

    query ReadBack($id: ID!, $locationId: ID!) {

      inventoryItem(id: $id) {

        inventoryLevel(locationId: $locationId) {

          quantities(names: ["available"]) {

            name

            quantity

          }

        }

      }

    }

  `;

  const readBack = await gql(accessToken, checkQuery, {

    id: inventoryItemId,

    locationId

  });

  const actualQuantity =

    readBack.inventoryItem.inventoryLevel?.quantities?.find(

      value => value.name === "available"

    )?.quantity;

  if (actualQuantity !== quantity) {

    throw new Error(

      `Read-back mismatch expected=${quantity} got=${actualQuantity}`

    );

  }

}

(async () => {

  const feed = await supplierFeed();

  const accessToken = await token();

  const allVariants = await variants(accessToken);

  const variantsBySku = new Map();

  for (const variant of allVariants) {

    const sku = (variant.sku || "").trim();

    if (!sku || !feed.has(sku)) continue;

    if (!variantsBySku.has(sku)) {

      variantsBySku.set(sku, []);

    }

    variantsBySku.get(sku).push(variant);

  }

  let changed = 0;

  let unchanged = 0;

  let blocked = 0;

  for (const [sku, matchingVariants] of variantsBySku) {

    const activeVariants = matchingVariants.filter(

      variant => variant.product.status === "ACTIVE"

    );

    if (activeVariants.length !== 1) {

      console.error(

        `BLOCKED sku=${sku} active_matches=${activeVariants.length}`

      );

      blocked++;

      continue;

    }

    const variant = activeVariants[0];

    const currentQuantity =

      variant.inventoryItem.inventoryLevel?.quantities?.find(

        value => value.name === "available"

      )?.quantity;

    if (!Number.isInteger(currentQuantity)) {

      console.error(

        `BLOCKED sku=${sku} location_quantity_unreadable`

      );

      blocked++;

      continue;

    }

    const wantedQuantity = feed.get(sku);

    if (currentQuantity === wantedQuantity) {

      unchanged++;

      continue;

    }

    await setQuantity(

      accessToken,

      variant.inventoryItem.id,

      wantedQuantity,

      currentQuantity

    );

    console.log(

      `VERIFIED sku=${sku} ` +

      `from=${currentQuantity} to=${wantedQuantity}`

    );

    changed++;

  }

  console.log(

    `SYNC_COMPLETE changed=${changed} ` +

    `unchanged=${unchanged} ` +

    `blocked=${blocked} ` +

    `matched_skus=${variantsBySku.size}`

  );

})().catch(error => {

  console.error("SYNC_FAILED", error.stack || error);

  process.exit(1);

});
