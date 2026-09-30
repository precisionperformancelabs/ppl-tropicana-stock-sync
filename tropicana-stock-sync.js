"use strict";

/*
 * PRECISION PERFORMANCE LABS
 * TROPSHIP STOCK SYNC
 *
 * BUILD: V8 - FEED AUTHORITATIVE
 *
 * PURPOSE
 * -------
 * - Download Tropicana / TropShip stock feed by SFTP
 * - Read supplier SKU + stock WITHOUT fast-xml-parser
 * - Treat validated supplier-feed membership as TropShip authority
 * - Match exact Shopify SKU
 * - Process ACTIVE products only
 * - Protect genuine PPL / HIRO / KMT own-stock products
 * - Enable Shopify inventory tracking where required
 * - Ensure supplier inventory is at Tropicana Dropship
 * - Remove TropShip inventory from own-stock location "30"
 * - Remove stale Syncee inventory location
 * - Update Shopify available quantity to supplier quantity
 * - Verify inventory writes by reading Shopify back
 *
 * SAFETY
 * ------
 * - NO product creation
 * - NO publishing
 * - NO pricing writes
 * - NO order calls
 * - NO tax changes
 * - NO invented quantities
 * - NO zeroing products missing from supplier feed
 * - Conflicting duplicate supplier SKUs are blocked
 * - Multiple ACTIVE Shopify matches are blocked
 * - Suspiciously small supplier feeds are blocked
 * - Invalid stock values are blocked
 * - Shopify writes are verified
 * - Own-stock PPL / HIRO / KMT products are protected
 */

const SFTP = require("ssh2-sftp-client");
const crypto = require("crypto");

const REQUIRED = [
  "TROPICANA_SFTP_USER",
  "TROPICANA_SFTP_PASSWORD",
  "SHOPIFY_CLIENT_ID",
  "SHOPIFY_CLIENT_SECRET",
  "SHOPIFY_STORE_DOMAIN"
];

for (const key of REQUIRED) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

const shop = process.env.SHOPIFY_STORE_DOMAIN;
const apiVersion = "2026-07";

const BUILD_MARKER =
  "PPL-STOCK-SYNC-2026-09-30-V8-FEED-AUTHORITATIVE";

/*
 * SHOPIFY LOCATIONS
 */

const OWN_30 =
  "gid://shopify/Location/120937251150";

const TROPSHIP =
  "gid://shopify/Location/125063037262";

const SYNCEE =
  "gid://shopify/Location/124613067086";

/*
 * Brands which this TropShip job must NEVER convert
 * into supplier-stock products.
 */
const PROTECTED_OWN_STOCK_VENDORS = new Set([
  "PRECISION PERFORMANCE LABS",
  "PPL",
  "HIRO",
  "KMT"
]);

/*
 * Diagnostic SKUs.
 */
const TARGET_SKUS = new Set([
  "APP486",
  "APP569",
  "PER458",
  "PER459",
  "PER460"
]);

const STOCK_FIELDS = [
  "StockLevel",
  "StockQuantity",
  "StockQty",
  "FreeStock",
  "AvailableStock",
  "QuantityAvailable",
  "AvailableQuantity",
  "QtyInStock"
];

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const normSku = value =>
  String(value ?? "")
    .trim()
    .toUpperCase();

const normText = value =>
  String(value ?? "")
    .trim()
    .toUpperCase();

/* =========================================================
   OWN-STOCK PROTECTION
   ========================================================= */

function isProtectedOwnStock(v) {
  const vendor =
    normText(v.product?.vendor);

  if (
    PROTECTED_OWN_STOCK_VENDORS.has(vendor)
  ) {
    return true;
  }

  /*
   * Secondary protection using explicit own-stock tags.
   *
   * We deliberately do NOT protect a product merely because
   * it currently has inventory at location 30. Some TropShip
   * products were incorrectly assigned there previously.
   */
  const tags =
    Array.isArray(v.product?.tags)
      ? v.product.tags
      : [];

  return tags.some(tag => {
    const t =
      normText(tag);

    return (
      t === "PPL OWN STOCK" ||
      t === "OWN STOCK" ||
      t === "SUPPLIER:PPL"
    );
  });
}

/* =========================================================
   SHOPIFY AUTH
   ========================================================= */

async function token() {
  const body =
    new URLSearchParams({
      grant_type:
        "client_credentials",

      client_id:
        process.env.SHOPIFY_CLIENT_ID,

      client_secret:
        process.env.SHOPIFY_CLIENT_SECRET
    });

  const r =
    await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",

        headers: {
          "content-type":
            "application/x-www-form-urlencoded"
        },

        body
      }
    );

  if (!r.ok) {
    throw new Error(
      `Shopify token failed ${r.status}: ` +
      `${await r.text()}`
    );
  }

  const json =
    await r.json();

  if (!json.access_token) {
    throw new Error(
      "Shopify token response contained no access_token"
    );
  }

  return json.access_token;
}

/* =========================================================
   SHOPIFY GRAPHQL WITH THROTTLE RETRY
   ========================================================= */

async function gql(
  accessToken,
  query,
  variables = {}
) {
  const maxAttempts = 10;

  for (
    let attempt = 1;
    attempt <= maxAttempts;
    attempt++
  ) {
    const r =
      await fetch(
        `https://${shop}/admin/api/${apiVersion}/graphql.json`,
        {
          method: "POST",

          headers: {
            "content-type":
              "application/json",

            "x-shopify-access-token":
              accessToken
          },

          body:
            JSON.stringify({
              query,
              variables
            })
        }
      );

    const raw =
      await r.text();

    let json;

    try {
      json =
        JSON.parse(raw);
    } catch {
      throw new Error(
        `Shopify returned invalid JSON: ` +
        `${raw.slice(0, 500)}`
      );
    }

    const throttled =
      r.status === 429 ||
      (
        Array.isArray(json.errors) &&
        json.errors.some(
          e =>
            e?.extensions?.code ===
            "THROTTLED"
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

      const throttleStatus =
        json.extensions
          ?.cost
          ?.throttleStatus;

      const requested =
        json.extensions
          ?.cost
          ?.requestedQueryCost ??
        100;

      const available =
        throttleStatus
          ?.currentlyAvailable ??
        0;

      const restoreRate =
        throttleStatus
          ?.restoreRate ??
        50;

      const deficit =
        Math.max(
          1,
          requested - available
        );

      const waitMs =
        Math.max(
          1000,
          Math.min(
            20000,
            Math.ceil(
              deficit /
              restoreRate *
              1000
            ) + 750
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

    if (
      !r.ok ||
      json.errors
    ) {
      throw new Error(
        `Shopify GraphQL failed: ` +
        JSON.stringify(
          json.errors || json
        )
      );
    }

    return json.data;
  }

  throw new Error(
    "Shopify GraphQL retry loop ended unexpectedly"
  );
}

/* =========================================================
   SUPPLIER FEED READER
   ========================================================= */

function decodeXml(value) {
  return String(value ?? "")
    .replace(
      /<!\[CDATA\[([\s\S]*?)\]\]>/gi,
      "$1"
    )
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#39;/gi, "'")
    .replace(
      /&#x([0-9a-f]+);/gi,
      (whole, hex) => {
        const n =
          parseInt(hex, 16);

        if (!Number.isFinite(n)) {
          return whole;
        }

        try {
          return String.fromCodePoint(n);
        } catch {
          return whole;
        }
      }
    )
    .replace(
      /&#([0-9]+);/g,
      (whole, dec) => {
        const n =
          parseInt(dec, 10);

        if (!Number.isFinite(n)) {
          return whole;
        }

        try {
          return String.fromCodePoint(n);
        } catch {
          return whole;
        }
      }
    )
    .replace(/&amp;/gi, "&")
    .trim();
}

function escapeRegex(value) {
  return String(value)
    .replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );
}

function extractTag(
  block,
  tagName
) {
  const safe =
    escapeRegex(tagName);

  const re =
    new RegExp(
      `<${safe}(?:\\s[^>]*)?>` +
      `([\\s\\S]*?)` +
      `<\\/${safe}\\s*>`,
      "i"
    );

  const match =
    String(block).match(re);

  if (!match) {
    return null;
  }

  return decodeXml(match[1]);
}

function prepareSupplierXml(
  downloaded
) {
  if (
    downloaded === null ||
    downloaded === undefined
  ) {
    throw new Error(
      "TROPICANA_FEED_DOWNLOAD_RETURNED_NO_DATA"
    );
  }

  let xml;

  if (Buffer.isBuffer(downloaded)) {
    xml =
      downloaded.toString("utf8");
  } else {
    xml =
      String(downloaded);
  }

  const originalBytes =
    Buffer.byteLength(
      xml,
      "utf8"
    );

  if (!xml.trim()) {
    throw new Error(
      "TROPICANA_FEED_EMPTY"
    );
  }

  xml =
    xml.replace(
      /^\uFEFF/,
      ""
    );

  xml =
    xml.replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,
      ""
    );

  const cleanedBytes =
    Buffer.byteLength(
      xml,
      "utf8"
    );

  const trimmed =
    xml.trim();

  if (!trimmed.startsWith("<")) {
    throw new Error(
      `TROPICANA_FEED_NOT_XML ` +
      `first_chars=` +
      `${JSON.stringify(
        trimmed.slice(0, 120)
      )}`
    );
  }

  console.log(
    `TROPICANA_FEED_RECEIVED ` +
    `original_bytes=${originalBytes} ` +
    `cleaned_bytes=${cleanedBytes}`
  );

  return xml;
}

function productCodePositions(
  xml
) {
  const regex =
    /<ProductCode(?:\s[^>]*)?>([\s\S]*?)<\/ProductCode\s*>/gi;

  const found = [];

  let match;

  while (
    (match = regex.exec(xml)) !== null
  ) {
    const sku =
      normSku(
        decodeXml(match[1])
      );

    if (!sku) {
      continue;
    }

    found.push({
      sku,
      start:
        match.index,

      afterCode:
        regex.lastIndex
    });
  }

  return found;
}

function stockFromSegment(
  sku,
  segment
) {
  const found = [];

  for (
    const field of
    STOCK_FIELDS
  ) {
    const value =
      extractTag(
        segment,
        field
      );

    if (value !== null) {
      found.push({
        field,
        value
      });
    }
  }

  if (found.length === 0) {
    throw new Error(
      `Unsafe stock fields for ${sku}: none`
    );
  }

  if (found.length > 1) {
    throw new Error(
      `Unsafe stock fields for ${sku}: ` +
      `${found
        .map(x => x.field)
        .join(",")}`
    );
  }

  const {
    field,
    value
  } = found[0];

  const raw =
    String(value)
      .trim();

  if (
    /^(out\s*of\s*stock|no|false|none)$/i
      .test(raw)
  ) {
    return {
      field,
      quantity: 0,
      raw
    };
  }

  if (
    !/^-?\d+(?:\.0+)?$/
      .test(raw)
  ) {
    throw new Error(
      `Invalid quantity for ${sku}: ` +
      `field=${field} ` +
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
      `Invalid quantity for ${sku}: ` +
      `field=${field} ` +
      `value=${JSON.stringify(raw)}`
    );
  }

  if (n < 0) {
    console.warn(
      `NEGATIVE_STOCK_CLAMPED ` +
      `${sku} ${n}->0`
    );

    return {
      field,
      quantity: 0,
      raw
    };
  }

  return {
    field,
    quantity: n,
    raw
  };
}

function buildSupplierMap(
  xml
) {
  const positions =
    productCodePositions(xml);

  console.log(
    `TROPICANA_PRODUCT_CODES_FOUND ` +
    `count=${positions.length}`
  );

  if (
    positions.length < 100
  ) {
    throw new Error(
      `TROPICANA_FEED_SUSPICIOUSLY_SMALL ` +
      `product_codes=${positions.length}`
    );
  }

  const map =
    new Map();

  const duplicateCodes =
    new Set();

  const conflictingDuplicates =
    new Set();

  let validRows = 0;
  let blockedRows = 0;

  for (
    let i = 0;
    i < positions.length;
    i++
  ) {
    const current =
      positions[i];

    const next =
      positions[i + 1];

    const end =
      next
        ? next.start
        : xml.length;

    const segment =
      xml.slice(
        current.afterCode,
        end
      );

    let stock;

    try {
      stock =
        stockFromSegment(
          current.sku,
          segment
        );
    } catch (e) {
      console.error(
        `FEED_ROW_BLOCKED ` +
        `sku=${current.sku} ` +
        `reason=${e.message}`
      );

      blockedRows++;
      throw e;
    }

    validRows++;

    if (
      TARGET_SKUS.has(
        current.sku
      )
    ) {
      console.log(
        `TARGET_FEED_ROW ` +
        `sku=${current.sku} ` +
        `stock_field=${stock.field} ` +
        `raw=${JSON.stringify(stock.raw)} ` +
        `quantity=${stock.quantity}`
      );
    }

    if (
      !map.has(
        current.sku
      )
    ) {
      map.set(
        current.sku,
        stock.quantity
      );

      continue;
    }

    duplicateCodes.add(
      current.sku
    );

    if (
      map.get(
        current.sku
      ) !== stock.quantity
    ) {
      conflictingDuplicates.add(
        current.sku
      );
    }
  }

  for (
    const sku of
    conflictingDuplicates
  ) {
    map.delete(sku);

    console.error(
      `CONFLICTING_DUPLICATE_BLOCKED ` +
      `sku=${sku}`
    );
  }

  if (!validRows) {
    throw new Error(
      "TROPICANA_FEED_CONTAINED_ZERO_VALID_ROWS"
    );
  }

  if (!map.size) {
    throw new Error(
      "TROPICANA_FEED_PRODUCED_ZERO_SAFE_SKUS"
    );
  }

  console.log(
    `FEED_OK ` +
    `product_codes=${positions.length} ` +
    `valid_rows=${validRows} ` +
    `blocked_rows=${blockedRows} ` +
    `unique_safe_skus=${map.size} ` +
    `duplicate_codes_seen=${duplicateCodes.size} ` +
    `conflicting_duplicate_codes_blocked=` +
    `${conflictingDuplicates.size}`
  );

  return map;
}

async function supplierFeed() {
  const s =
    new SFTP();

  try {
    console.log(
      "TROPICANA_SFTP_CONNECTING"
    );

    await s.connect({
      host:
        "tropicana.ftp.redtechnology.com",

      port:
        22,

      username:
        process.env
          .TROPICANA_SFTP_USER,

      password:
        process.env
          .TROPICANA_SFTP_PASSWORD,

      readyTimeout:
        30000
    });

    console.log(
      "TROPICANA_SFTP_CONNECTED"
    );

    const downloaded =
      await s.get(
        "DropshipProductFeed.xml"
      );

    console.log(
      "TROPICANA_FEED_DOWNLOADED"
    );

    const xml =
      prepareSupplierXml(
        downloaded
      );

    const feedHash =
      crypto
        .createHash("sha256")
        .update(xml)
        .digest("hex")
        .slice(0, 16);

    console.log(
      `TROPICANA_FEED_FINGERPRINT ` +
      `sha256=${feedHash}`
    );

    return buildSupplierMap(
      xml
    );

  } finally {
    try {
      await s.end();

      console.log(
        "TROPICANA_SFTP_CLOSED"
      );
    } catch {}
  }
}

/* =========================================================
   INVENTORY HELPERS
   ========================================================= */

function availableAt(level) {
  if (!level) {
    return null;
  }

  const q =
    level.quantities
      ?.find(
        x =>
          x.name ===
          "available"
      )
      ?.quantity;

  return Number.isInteger(q)
    ? q
    : null;
}

/* =========================================================
   LOAD SHOPIFY VARIANTS
   ========================================================= */

async function variants(
  accessToken
) {
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
            vendor
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
    const data =
      await gql(
        accessToken,
        query,
        {
          after,
          own:
            OWN_30,
          drop:
            TROPSHIP,
          syncee:
            SYNCEE
        }
      );

    if (
      !data?.productVariants
    ) {
      throw new Error(
        "Shopify productVariants response missing"
      );
    }

    all.push(
      ...data
        .productVariants
        .nodes
    );

    page++;

    if (
      page % 10 === 0 ||
      !data
        .productVariants
        .pageInfo
        .hasNextPage
    ) {
      console.log(
        `SHOPIFY_VARIANTS_PAGE ` +
        `page=${page} ` +
        `total=${all.length}`
      );
    }

    after =
      data
        .productVariants
        .pageInfo
        .hasNextPage
        ? data
            .productVariants
            .pageInfo
            .endCursor
        : null;

    if (after) {
      await sleep(500);
    }

  } while (after);

  return all;
}

/* =========================================================
   INVENTORY READ-BACK
   ========================================================= */

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

  const data =
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
    data
      .inventoryItem
      ?.inventoryLevel
  );
}

/* =========================================================
   ENABLE TRACKING
   ========================================================= */

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

  const data =
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

  const errors =
    data
      .inventoryItemUpdate
      .userErrors;

  if (errors.length) {
    throw new Error(
      `Tracking update failed: ` +
      JSON.stringify(errors)
    );
  }

  if (
    data
      .inventoryItemUpdate
      .inventoryItem
      ?.tracked !== true
  ) {
    throw new Error(
      "Tracking read-back mismatch"
    );
  }
}

/* =========================================================
   SET INVENTORY QUANTITY
   ========================================================= */

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
      "available",

    reason:
      "correction",

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

  const data =
    await gql(
      accessToken,
      mutation,
      {
        input,

        key:
          crypto.randomUUID()
      }
    );

  const errors =
    data
      .inventorySetQuantities
      .userErrors;

  if (errors.length) {
    throw new Error(
      `Inventory quantity update failed: ` +
      JSON.stringify(errors)
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

/* =========================================================
   ACTIVATE INVENTORY AT TROPSHIP
   ========================================================= */

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

  const data =
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

  const errors =
    data
      .inventoryActivate
      .userErrors;

  if (errors.length) {
    throw new Error(
      `Dropship activation failed: ` +
      JSON.stringify(errors)
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
      `Dropship activation read-back mismatch ` +
      `expected=${quantity} ` +
      `got=${actual}`
    );
  }
}

/* =========================================================
   DEACTIVATE WRONG INVENTORY LOCATION
   ========================================================= */

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

  const data =
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

  const errors =
    data
      .inventoryBulkToggleActivation
      .userErrors;

  if (errors.length) {
    throw new Error(
      `Failed to deactivate ${label}: ` +
      JSON.stringify(errors)
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
      `${label} still active after deactivation; ` +
      `quantity=${actual}`
    );
  }
}

/* =========================================================
   MAIN
   ========================================================= */

(async () => {

  console.log(
    `BUILD_MARKER ${BUILD_MARKER}`
  );

  /*
   * STEP 1:
   * Download and validate supplier feed.
   */
  const feed =
    await supplierFeed();

  console.log(
    `SUPPLIER_FEED_READY ` +
    `safe_skus=${feed.size}`
  );

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
          : "MISSING_OR_CONFLICT"
      }`
    );
  }

  /*
   * STEP 2:
   * Authenticate only after supplier feed is safe.
   */
  const accessToken =
    await token();

  console.log(
    "SHOPIFY_AUTH_OK"
  );

  /*
   * STEP 3:
   * Load every Shopify variant.
   */
  const all =
    await variants(
      accessToken
    );

  console.log(
    `SHOPIFY_VARIANTS_LOADED ` +
    `count=${all.length}`
  );

  /*
   * Diagnostics.
   */
  for (
    const sku of
    TARGET_SKUS
  ) {
    const matches =
      all.filter(
        v =>
          normSku(v.sku) ===
          sku
      );

    if (!matches.length) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${sku} ` +
        `matches=0`
      );
    }

    for (
      const v of matches
    ) {
      console.log(
        `TARGET_SHOPIFY ` +
        `sku=${sku} ` +
        `title=${JSON.stringify(
          v.product?.title || ""
        )} ` +
        `vendor=${JSON.stringify(
          v.product?.vendor || ""
        )} ` +
        `status=${v.product?.status} ` +
        `protected=${isProtectedOwnStock(v)} ` +
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

  /*
   * =====================================================
   * V8 CRITICAL FIX
   * =====================================================
   *
   * V7 required Shopify Tropicana tags.
   *
   * That was wrong because valid Tropicana-feed SKUs could
   * exist in Shopify without one of those exact tags.
   *
   * V8 therefore uses:
   *
   *     VALIDATED SUPPLIER FEED SKU
   *              +
   *     EXACT SHOPIFY SKU
   *
   * as the TropShip inventory authority.
   *
   * Genuine PPL / HIRO / KMT own-stock products remain
   * protected and are excluded.
   */

  const bySku =
    new Map();

  const shopifySkus =
    new Set();

  const protectedSkus =
    new Set();

  let blankShopifySkus = 0;

  for (
    const v of all
  ) {
    const sku =
      normSku(v.sku);

    if (!sku) {
      blankShopifySkus++;
      continue;
    }

    shopifySkus.add(
      sku
    );

    /*
     * Missing supplier SKU = DO NOTHING.
     *
     * We never interpret absence from the feed as zero.
     */
    if (
      !feed.has(sku)
    ) {
      continue;
    }

    /*
     * Protect genuine PPL own-stock products.
     */
    if (
      isProtectedOwnStock(v)
    ) {
      protectedSkus.add(
        sku
      );

      console.log(
        `PROTECTED_OWN_STOCK ` +
        `sku=${sku} ` +
        `vendor=${JSON.stringify(
          v.product?.vendor || ""
        )} ` +
        `title=${JSON.stringify(
          v.product?.title || ""
        )}`
      );

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
          !shopifySkus.has(sku)
      );

  const shopifyFeedMatches =
    [...feed.keys()]
      .filter(
        sku =>
          shopifySkus.has(sku)
      );

  console.log(
    `MATCH_AUDIT ` +
    `feed=${feed.size} ` +
    `shopify_unique_skus=${shopifySkus.size} ` +
    `feed_shopify_matches=${shopifyFeedMatches.length} ` +
    `eligible_sync_skus=${bySku.size} ` +
    `protected_own_stock_skus=${protectedSkus.size} ` +
    `feed_without_shopify=${feedWithoutShopify.length} ` +
    `blank_shopify_skus=${blankShopifySkus}`
  );

  let quantityChanged = 0;
  let unchanged = 0;
  let blocked = 0;

  let trackingEnabled = 0;
  let dropshipActivated = 0;
  let ownStockDeactivated = 0;
  let synceeDeactivated = 0;

  let inactiveOnly = 0;
  let duplicateActiveBlocked = 0;
  let missingInventoryItem = 0;

  /*
   * STEP 4:
   * Synchronise every safe supplier-feed SKU which has
   * exactly one ACTIVE, non-protected Shopify match.
   */
  for (
    const [sku, list]
    of bySku.entries()
  ) {

    const active =
      list.filter(
        v =>
          v.product &&
          v.product.status ===
          "ACTIVE"
      );

    /*
     * No ACTIVE product:
     * do not write inventory.
     */
    if (
      active.length === 0
    ) {
      console.log(
        `SKIPPED_INACTIVE ` +
        `sku=${sku} ` +
        `shopify_matches=${list.length}`
      );

      inactiveOnly++;
      continue;
    }

    /*
     * More than one ACTIVE Shopify variant with same SKU:
     * unsafe, so block rather than guessing.
     */
    if (
      active.length > 1
    ) {
      console.error(
        `BLOCKED_DUPLICATE_ACTIVE_SKU ` +
        `sku=${sku} ` +
        `active_matches=${active.length} ` +
        `all_matches=${list.length}`
      );

      duplicateActiveBlocked++;
      blocked++;
      continue;
    }

    const v =
      active[0];

    if (
      !v.inventoryItem?.id
    ) {
      console.error(
        `BLOCKED ` +
        `sku=${sku} ` +
        `reason=MISSING_INVENTORY_ITEM`
      );

      missingInventoryItem++;
      blocked++;
      continue;
    }

    const wanted =
      feed.get(sku);

    if (
      !Number.isSafeInteger(wanted) ||
      wanted < 0 ||
      wanted > 1000000
    ) {
      console.error(
        `BLOCKED ` +
        `sku=${sku} ` +
        `reason=UNSAFE_WANTED_QUANTITY ` +
        `quantity=${wanted}`
      );

      blocked++;
      continue;
    }

    let productChanged =
      false;

    try {

      /*
       * Tracking must be enabled.
       */
      if (
        !v.inventoryItem.tracked
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
          v.inventoryItem
            ?.dropship
        );

      const ownCurrent =
        availableAt(
          v.inventoryItem
            ?.ownStock
        );

      const synceeCurrent =
        availableAt(
          v.inventoryItem
            ?.syncee
        );

      if (
        TARGET_SKUS.has(sku)
      ) {
        console.log(
          `TARGET_BEFORE ` +
          `sku=${sku} ` +
          `wanted=${wanted} ` +
          `dropship=${dropshipCurrent} ` +
          `own30=${ownCurrent} ` +
          `syncee=${synceeCurrent}`
        );
      }

      /*
       * Activate Tropicana Dropship if necessary.
       */
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
        quantityChanged++;

        productChanged = true;
        dropshipCurrent = wanted;

        await sleep(250);

      } else if (
        dropshipCurrent !== wanted
      ) {

        /*
         * Correct stale Tropicana quantity.
         */
        await setQuantity(
          accessToken,
          v.inventoryItem.id,
          TROPSHIP,
          wanted,
          dropshipCurrent,
          "Tropicana Dropship"
        );

        console.log(
          `VERIFIED ` +
          `sku=${sku} ` +
          `location=Tropicana Dropship ` +
          `from=${dropshipCurrent} ` +
          `to=${wanted}`
        );

        quantityChanged++;

        productChanged = true;
        dropshipCurrent = wanted;

        await sleep(250);
      }

      /*
       * Because this SKU is present in the validated supplier
       * feed and has passed own-stock protection, it is a
       * TropShip item.
       *
       * It must therefore not remain active at location 30.
       */
      if (
        v.inventoryItem
          ?.ownStock
      ) {
        await deactivateLocation(
          accessToken,
          v.inventoryItem.id,
          OWN_30,
          "30"
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

      /*
       * Remove stale Syncee location.
       */
      if (
        v.inventoryItem
          ?.syncee
      ) {
        await deactivateLocation(
          accessToken,
          v.inventoryItem.id,
          SYNCEE,
          "Syncee"
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

      /*
       * FINAL READ-BACK.
       *
       * Unlike V7, this is performed for EVERY changed SKU,
       * not merely the diagnostic target SKUs.
       */
      if (productChanged) {
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

        if (
          afterDropship !== wanted
        ) {
          throw new Error(
            `FINAL_VERIFY_DROPSHIP_FAILED ` +
            `sku=${sku} ` +
            `wanted=${wanted} ` +
            `actual=${afterDropship}`
          );
        }

        if (
          afterOwn30 !== null
        ) {
          throw new Error(
            `FINAL_VERIFY_LOCATION_30_FAILED ` +
            `sku=${sku} ` +
            `actual=${afterOwn30}`
          );
        }

        if (
          afterSyncee !== null
        ) {
          throw new Error(
            `FINAL_VERIFY_SYNCEE_FAILED ` +
            `sku=${sku} ` +
            `actual=${afterSyncee}`
          );
        }

        console.log(
          `FINAL_VERIFIED ` +
          `sku=${sku} ` +
          `dropship=${afterDropship} ` +
          `own30=${afterOwn30} ` +
          `syncee=${afterSyncee}`
        );
      }

      if (!productChanged) {
        unchanged++;
      }

      if (
        TARGET_SKUS.has(sku)
      ) {
        const finalDropship =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            TROPSHIP
          );

        const finalOwn =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            OWN_30
          );

        const finalSyncee =
          await readAvailable(
            accessToken,
            v.inventoryItem.id,
            SYNCEE
          );

        console.log(
          `TARGET_AFTER ` +
          `sku=${sku} ` +
          `wanted=${wanted} ` +
          `dropship=${finalDropship} ` +
          `own30=${finalOwn} ` +
          `syncee=${finalSyncee}`
        );
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

  /*
   * STEP 5:
   * Final run summary.
   */
  console.log(
    `SYNC_COMPLETE ` +
    `quantity_changed=${quantityChanged} ` +
    `unchanged=${unchanged} ` +
    `tracking_enabled=${trackingEnabled} ` +
    `dropship_activated=${dropshipActivated} ` +
    `own_location_deactivated=${ownStockDeactivated} ` +
    `syncee_deactivated=${synceeDeactivated} ` +
    `inactive_only=${inactiveOnly} ` +
    `duplicate_active_blocked=${duplicateActiveBlocked} ` +
    `missing_inventory_item=${missingInventoryItem} ` +
    `protected_own_stock=${protectedSkus.size} ` +
    `blocked=${blocked} ` +
    `eligible_sync_skus=${bySku.size}`
  );

})().catch(e => {

  console.error(
    "SYNC_FAILED",
    e.stack || e
  );

  process.exit(1);
});
