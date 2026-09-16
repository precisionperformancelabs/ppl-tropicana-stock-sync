const SFTP = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');

const required = ['TROPICANA_SFTP_USER','TROPICANA_SFTP_PASSWORD','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_STORE_DOMAIN'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const apiVersion = '2026-07';
const BUILD_MARKER = 'PPL-STOCK-SYNC-2026-09-16-FINAL-V2';

// PPL's own-stock location. Tropicana-tagged products must NEVER carry sellable stock here.
const ownStockLocationId = 'gid://shopify/Location/120937251150'; // "30"

// All Tropicana/Tropship supplier inventory belongs here.
const tropicanaDropshipLocationId = 'gid://shopify/Location/125063037262'; // "Tropicana Dropship"

// Old Syncee stock must not contribute to Tropicana-tagged products.
const synceeLocationId = 'gid://shopify/Location/124613067086'; // "Syncee"

async function token() {
  const body = new URLSearchParams({
    grant_type:'client_credentials',
    client_id:process.env.SHOPIFY_CLIENT_ID,
    client_secret:process.env.SHOPIFY_CLIENT_SECRET
  });

  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method:'POST',
    headers:{'content-type':'application/x-www-form-urlencoded'},
    body
  });

  if (!r.ok) {
    throw new Error(`Shopify token failed ${r.status}: ${await r.text()}`);
  }

  return (await r.json()).access_token;
}

async function gql(accessToken, query, variables={}) {
  const r = await fetch(
    `https://${shop}/admin/api/${apiVersion}/graphql.json`,
    {
      method:'POST',
      headers:{
        'content-type':'application/json',
        'x-shopify-access-token':accessToken
      },
      body:JSON.stringify({query,variables})
    }
  );

  const j = await r.json();

  if (!r.ok || j.errors) {
    throw new Error(
      `Shopify GraphQL failed: ${JSON.stringify(j.errors || j)}`
    );
  }

  return j.data;
}

function records(node, out=[]) {
  if (Array.isArray(node)) {
    for (const v of node) records(v,out);
  } else if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node,'ProductCode')) {
      out.push(node);
    }

    for (const v of Object.values(node)) records(v,out);
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

  const present = keys.filter(
    k => Object.prototype.hasOwnProperty.call(row,k)
  );

  if (present.length !== 1) {
    throw new Error(
      `Unsafe stock fields for ${row.ProductCode}: ` +
      `${present.join(',') || 'none'}; ` +
      `keys=${Object.keys(row).join(',')}`
    );
  }

  const raw = String(row[present[0]]).trim();

  if (/^(out\s*of\s*stock|no|false|none)$/i.test(raw)) {
    return 0;
  }

  if (!/^-?\d+(?:\.0+)?$/.test(raw)) {
    throw new Error(
      `Invalid quantity for ${row.ProductCode}: ` +
      `field=${present[0]} value=${JSON.stringify(raw)}`
    );
  }

  const n = Number(raw);

  if (!Number.isSafeInteger(n) || n > 1000000) {
    throw new Error(
      `Invalid quantity for ${row.ProductCode}: ` +
      `field=${present[0]} value=${JSON.stringify(raw)}`
    );
  }

  if (n < 0) {
    console.warn(
      `NEGATIVE_STOCK_CLAMPED ${row.ProductCode} ${n}->0`
    );
    return 0;
  }

  return n;
}

async function supplierFeed() {
  const s = new SFTP();

  try {
    await s.connect({
      host:'tropicana.ftp.redtechnology.com',
      port:22,
      username:process.env.TROPICANA_SFTP_USER,
      password:process.env.TROPICANA_SFTP_PASSWORD,
      readyTimeout:30000
    });

    const b = await s.get('DropshipProductFeed.xml');

    const parsed = new XMLParser({
      trimValues:true,
      parseTagValue:false
    }).parse(b.toString());

    const rows = records(parsed);

    const map = new Map();
    const duplicateCodes = new Set();
    const conflictingDuplicates = new Set();

    for (const row of rows) {
      const sku = String(row.ProductCode ?? '').trim();

      if (!sku) continue;

      const qty = feedQuantity(row);

      if (!map.has(sku)) {
        map.set(sku, qty);
        continue;
      }

      duplicateCodes.add(sku);

      if (map.get(sku) !== qty) {
        conflictingDuplicates.add(sku);
      }
    }

    // Tropicana repeats ProductCode rows across categories.
    // Keep duplicates when their stock agrees.
    // Block only genuine stock conflicts.
    for (const sku of conflictingDuplicates) {
      map.delete(sku);
    }

    console.log(
      `FEED_OK rows=${rows.length} ` +
      `unique=${map.size} ` +
      `duplicate_codes_seen=${duplicateCodes.size} ` +
      `conflicting_duplicate_codes_blocked=${conflictingDuplicates.size}`
    );

    return map;

  } finally {
    try {
      await s.end();
    } catch {}
  }
}

function isTropicanaVariant(v) {
  const tags = Array.isArray(v.product?.tags)
    ? v.product.tags
    : [];

  return tags.some(
    tag =>
      /^(Supplier:Tropicana|Tropicana Feed)$/i.test(
        String(tag).trim()
      )
  );
}

function availableAt(level) {
  if (!level) return null;

  const q = level.quantities?.find(
    x => x.name === 'available'
  )?.quantity;

  return Number.isInteger(q) ? q : null;
}

async function variants(accessToken) {
  const query = `
    query Variants(
      $after:String,
      $ownStockLocationId:ID!,
      $tropicanaDropshipLocationId:ID!,
      $synceeLocationId:ID!
    ) {
      productVariants(first:100,after:$after) {
        nodes {
          id
          sku

          inventoryItem {
            id
            tracked

            ownStock:inventoryLevel(
              locationId:$ownStockLocationId
            ) {
              quantities(names:["available"]) {
                name
                quantity
              }
            }

            dropship:inventoryLevel(
              locationId:$tropicanaDropshipLocationId
            ) {
              quantities(names:["available"]) {
                name
                quantity
              }
            }

            syncee:inventoryLevel(
              locationId:$synceeLocationId
            ) {
              quantities(names:["available"]) {
                name
                quantity
              }
            }
          }

          product {
            id
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

  const all=[];
  let after=null;

  do {
    const d = await gql(
      accessToken,
      query,
      {
        after,
        ownStockLocationId,
        tropicanaDropshipLocationId,
        synceeLocationId
      }
    );

    all.push(...d.productVariants.nodes);

    after = d.productVariants.pageInfo.hasNextPage
      ? d.productVariants.pageInfo.endCursor
      : null;

  } while(after);

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
      inventoryItem(id:$id) {
        inventoryLevel(locationId:$locationId) {
          quantities(names:["available"]) {
            name
            quantity
          }
        }
      }
    }
  `;

  const d = await gql(
    accessToken,
    query,
    {
      id:inventoryItemId,
      locationId
    }
  );

  return availableAt(
    d.inventoryItem?.inventoryLevel
  );
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
      $input:InventorySetQuantitiesInput!,
      $key:String!
    ) {
      inventorySetQuantities(input:$input)
        @idempotent(key:$key) {

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
    name:'available',
    reason:'correction',
    referenceDocumentUri:
      `gid://ppl-tropicana-sync/StockSync/${Date.now()}`,

    quantities:[
      {
        inventoryItemId,
        locationId,
        quantity,
        changeFromQuantity:compareQuantity
      }
    ]
  };

  const d = await gql(
    accessToken,
    mutation,
    {
      input,
      key:crypto.randomUUID()
    }
  );

  const errs = d.inventorySetQuantities.userErrors;

  if (errs.length) {
    throw new Error(JSON.stringify(errs));
  }

  const actual = await readAvailable(
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
        inventoryItemId:$inventoryItemId,
        locationId:$locationId,
        available:$available
      )
      @idempotent(key:$key) {

        inventoryLevel {
          id

          quantities(names:["available"]) {
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

  const d = await gql(
    accessToken,
    mutation,
    {
      inventoryItemId,
      locationId:tropicanaDropshipLocationId,
      available:quantity,
      key:crypto.randomUUID()
    }
  );

  const errs = d.inventoryActivate.userErrors;

  if (errs.length) {
    throw new Error(JSON.stringify(errs));
  }

  const actual = await readAvailable(
    accessToken,
    inventoryItemId,
    tropicanaDropshipLocationId
  );

  if (actual !== quantity) {
    throw new Error(
      `Dropship activation read-back mismatch ` +
      `expected=${quantity} got=${actual}`
    );
  }
}

(async()=>{

  console.log(
    `BUILD_MARKER ${BUILD_MARKER}`
  );

  const feed = await supplierFeed();

  for (const sku of [
    'PER458',
    'PER459',
    'PER460'
  ]) {
    console.log(
      `TARGET_FEED sku=${sku} ` +
      `quantity=${
        feed.has(sku)
          ? feed.get(sku)
          : 'MISSING_OR_CONFLICT'
      }`
    );
  }

  const accessToken = await token();

  const all = await variants(accessToken);

  const bySku = new Map();

  for (const v of all) {

    const sku = (v.sku || '').trim();

    if (
      !sku ||
      !feed.has(sku) ||
      !isTropicanaVariant(v)
    ) {
      continue;
    }

    if (!bySku.has(sku)) {
      bySku.set(sku,[]);
    }

    bySku.get(sku).push(v);
  }

  let changed = 0;
  let unchanged = 0;
  let blocked = 0;
  let dropshipActivated = 0;
  let ownStockCleared = 0;
  let synceeCleared = 0;

  for (const [sku,list] of bySku) {

    const active = list.filter(
      v => v.product.status === 'ACTIVE'
    );

    if (active.length !== 1) {
      console.error(
        `BLOCKED sku=${sku} ` +
        `active_matches=${active.length}`
      );

      blocked++;
      continue;
    }

    const v = active[0];

    if (!v.inventoryItem?.tracked) {
      console.error(
        `BLOCKED sku=${sku} ` +
        `inventory_not_tracked`
      );

      blocked++;
      continue;
    }

    const wanted = feed.get(sku);

    const dropshipCurrent =
      availableAt(v.inventoryItem.dropship);

    const ownStockCurrent =
      availableAt(v.inventoryItem.ownStock);

    const synceeCurrent =
      availableAt(v.inventoryItem.syncee);

    if (
      ['PER458','PER459','PER460'].includes(sku)
    ) {
      console.log(
        `TARGET_BEFORE sku=${sku} ` +
        `wanted=${wanted} ` +
        `dropship=${dropshipCurrent} ` +
        `own30=${ownStockCurrent} ` +
        `syncee=${synceeCurrent}`
      );
    }

    let productChanged = false;

    try {

      // Tropicana stock ALWAYS lives at the
      // Tropicana Dropship location.
      if (dropshipCurrent === null) {

        await activateAtDropship(
          accessToken,
          v.inventoryItem.id,
          wanted
        );

        console.log(
          `DROPSHIP_ACTIVATED ` +
          `sku=${sku} quantity=${wanted}`
        );

        dropshipActivated++;
        changed++;
        productChanged = true;

      } else if (dropshipCurrent !== wanted) {

        await setQuantity(
          accessToken,
          v.inventoryItem.id,
          tropicanaDropshipLocationId,
          wanted,
          dropshipCurrent,
          'Tropicana Dropship'
        );

        console.log(
          `VERIFIED sku=${sku} ` +
          `location=Tropicana Dropship ` +
          `from=${dropshipCurrent} ` +
          `to=${wanted}`
        );

        changed++;
        productChanged = true;
      }

      // Location "30" is reserved for PPL's
      // own stock.
      //
      // If a Tropicana-tagged SKU has stock
      // there from an old/bad sync, clear it
      // only AFTER Dropship has been made valid.
      if (
        ownStockCurrent !== null &&
        ownStockCurrent !== 0
      ) {

        await setQuantity(
          accessToken,
          v.inventoryItem.id,
          ownStockLocationId,
          0,
          ownStockCurrent,
          '30'
        );

        console.log(
          `WRONG_LOCATION_CLEARED ` +
          `sku=${sku} ` +
          `location=30 ` +
          `from=${ownStockCurrent} ` +
          `to=0`
        );

        ownStockCleared++;
        productChanged = true;
      }

      // These SKUs were previously fed by Syncee.
      //
      // For a product positively tagged as
      // Tropicana AND present in the current
      // Tropicana feed, Syncee must not add
      // additional sellable stock.
      if (
        synceeCurrent !== null &&
        synceeCurrent !== 0
      ) {

        await setQuantity(
          accessToken,
          v.inventoryItem.id,
          synceeLocationId,
          0,
          synceeCurrent,
          'Syncee'
        );

        console.log(
          `STALE_LOCATION_CLEARED ` +
          `sku=${sku} ` +
          `location=Syncee ` +
          `from=${synceeCurrent} ` +
          `to=0`
        );

        synceeCleared++;
        productChanged = true;
      }

      if (
        ['PER458','PER459','PER460'].includes(sku)
      ) {

        const afterDropship =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            tropicanaDropshipLocationId
          );

        const afterOwn30 =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            ownStockLocationId
          );

        const afterSyncee =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            synceeLocationId
          );

        console.log(
          `TARGET_AFTER sku=${sku} ` +
          `dropship=${afterDropship} ` +
          `own30=${afterOwn30} ` +
          `syncee=${afterSyncee}`
        );
      }

      if (!productChanged) {
        unchanged++;
      }

    } catch(e) {

      console.error(
        `BLOCKED sku=${sku} ` +
        `update_failed=${e.message}`
      );

      blocked++;
    }
  }

  console.log(
    `SYNC_COMPLETE ` +
    `changed=${changed} ` +
    `unchanged=${unchanged} ` +
    `dropship_activated=${dropshipActivated} ` +
    `own_stock_cleared=${ownStockCleared} ` +
    `syncee_cleared=${synceeCleared} ` +
    `blocked=${blocked} ` +
    `matched_skus=${bySku.size}`
  );

})().catch(e=>{

  console.error(
    'SYNC_FAILED',
    e.stack || e
  );

  process.exit(1);
});
