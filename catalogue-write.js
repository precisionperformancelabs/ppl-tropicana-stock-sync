"use strict";

/*
  PPL Tropicana controlled catalogue writer V2
  FIRST V2 TEST:
  - maximum 20 NEW SKUs
  - genuine flavour variants grouped into one product where safe
  - DRAFT only
  - ZERO inventory writes
  - ZERO order calls
  - exact SKU protection immediately before writes
  - global barcode collision protection
  - hard nicotine/vape/alcohol block
  - PPL / Hiro / KMT protected
  - fail closed on uncertainty
*/

const SFTP = require("ssh2-sftp-client");
const { XMLParser } = require("fast-xml-parser");

const TEST_SKU_LIMIT = 20;
const SHOPIFY_API_VERSION = "2026-07";

function clean(v) {
  return String(v ?? "").trim();
}

function norm(v) {
  return clean(v).toLowerCase().replace(/\s+/g, " ");
}

function num(v) {
  const n = Number.parseFloat(clean(v));
  return Number.isFinite(n) ? n : null;
}

function money(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function pricing(net) {
  const vat = net * 1.2;
  const landed = vat + 6;
  const rate = landed < 20 ? 1.175 : 1.125;

  return {
    net: money(net),
    vatCost: money(vat),
    landed: money(landed),
    rule: landed < 20 ? "17.5%" : "12.5%",
    retail: money(landed * rate)
  };
}

function hardBlocked(r) {
  const b = norm(r.Brand);
  const n = norm(r.TranslationName);
  const c = norm(r.FilterByCategory);
  const t = `${b} ${n} ${c}`;

  // Never create protected/non-Tropicana ranges.
  if (
    b === "ppl" ||
    b.includes("precision performance labs") ||
    b === "hiro" ||
    b === "kmt"
  ) {
    return "protected-brand";
  }

  // Non-negotiable nicotine/vape block.
  if (
    t.includes("nicotine") ||
    t.includes("vape") ||
    t.includes("vaping") ||
    t.includes("e-cig") ||
    t.includes("e cigarette") ||
    t.includes("e-cigarette")
  ) {
    return "nicotine-vape";
  }

  // Non-negotiable alcohol block.
  if (/\b(alcohol|beer|wine|cider)\b/.test(t)) {
    return "alcohol";
  }

  return "";
}

function ordinaryExcluded(r) {
  const b = norm(r.Brand);
  const n = norm(r.TranslationName);
  const c = norm(r.FilterByCategory);
  const t = `${b} ${n} ${c}`;
// Exclude single-serving products.
// Multipacks such as 12x55g are NOT blocked by this rule.
const singleServing =
  /\b(single[\s-]?serv(e|ing)?|single[\s-]?portion|sample|sample[\s-]?pack|sachet)\b/i.test(t);

const multipack =
  /\b\d+\s*[xX×]\s*\d+(?:\.\d+)?\s*(?:g|kg|ml|l)\b/i.test(t) ||
  /\b\d+\s*(?:pack|pk|sachets|servings)\b/i.test(t);

if (singleServing && !multipack) return true;

  
  const blocked = [
    "irn bru",
    "kellogg",
    "red bull",
    "peperami",
    "nature valley",
    "lucozade",
    "monster",
    "mars",
    "m and ms",
    "nutry nuts",
    "powerade",
    "ribena",
    "savvy sweets",
    "shaken udder",
    "snickers",
    "top g",
    "the curators",
    "trek",
    "grill master"
  ];

  for (const x of blocked) {
    if (t.includes(x)) return x;
  }

  if (/\b(sauce|sauces|syrup|syrups)\b/.test(t)) {
    return "sauce/syrup";
  }

  if (/\bwipes\b/.test(t)) {
    return "wipes";
  }

  if (/\b(chips|crisps)\b/.test(t)) {
    return "chips/crisps";
  }

  if (t.includes("cereal bar")) {
    return "cereal bar";
  }

  if (
    t.includes("single serving") ||
    t.includes("single sachet") ||
    t.includes("1 sachet") ||
    t.includes("1x sachet")
  ) {
    return "single serving";
  }

  return "";
}

function extractRows(parsed) {
  const rows = [];

  function walk(x) {
    if (!x || typeof x !== "object") return;

    if (
      !Array.isArray(x) &&
      Object.prototype.hasOwnProperty.call(x, "ProductCode") &&
      Object.prototype.hasOwnProperty.call(x, "TranslationName")
    ) {
      rows.push(x);
    }

    for (const v of Object.values(x)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          walk(item);
        }
      } else if (v && typeof v === "object") {
        walk(v);
      }
    }
  }

  walk(parsed);

  return rows;
}

function identity(r) {
  return JSON.stringify({
    ProductCode: clean(r.ProductCode),
    TranslationName: clean(r.TranslationName),
    Barcode: clean(r.Barcode),
    Brand: clean(r.Brand),
    Flavour: clean(r.Flavour),
    Size: clean(r.Size),
    ProductPrice: clean(r.ProductPrice)
  });
}

/*
  Conservative family grouping.

  We only group rows where:
  - a real Flavour exists
  - the flavour occurs at the END of TranslationName
  - brand matches
  - base title matches
  - exact size matches
  - supplier category matches

  Anything ambiguous stays as its own product.
*/
function familyInfo(r) {
  const title = clean(r.TranslationName);
  const flavour = clean(r.Flavour);
  const size = clean(r.Size);
  const brand = clean(r.Brand);
  const category = clean(r.FilterByCategory);

  if (!flavour) {
    return {
      key: `single:${clean(r.ProductCode)}`,
      title,
      optionName: size ? "Size" : "Title",
      optionValue: size || "Default",
      groupable: false
    };
  }

  const esc = flavour.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const endFlavour = new RegExp(
    `\\s+${esc}\\s*$`,
    "i"
  );

  if (!endFlavour.test(title)) {
    return {
      key: `single:${clean(r.ProductCode)}`,
      title,
      optionName: "Flavour",
      optionValue: flavour,
      groupable: false
    };
  }

  const baseTitle = title
    .replace(endFlavour, "")
    .trim();

  return {
    key:
      `family:${norm(brand)}|` +
      `${norm(baseTitle)}|` +
      `${norm(size)}|` +
      `${norm(category)}`,

    title: baseTitle,
    optionName: "Flavour",
    optionValue: flavour,
    groupable: true
  };
}

async function loadFeed() {
  const required = [
    "TROPICANA_SFTP_USER",
    "TROPICANA_SFTP_PASSWORD"
  ];

  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(`Missing ${k}`);
    }
  }

  const sftp = new SFTP();

  try {
    await sftp.connect({
      host:
        process.env.TROPICANA_SFTP_HOST ||
        "tropicana.ftp.redtechnology.com",

      port: Number(
        process.env.TROPICANA_SFTP_PORT || 22
      ),

      username:
        process.env.TROPICANA_SFTP_USER,

      password:
        process.env.TROPICANA_SFTP_PASSWORD
    });

    console.log("TROPICANA_LOGIN_OK");

    const file =
      process.env.TROPICANA_SFTP_FILE ||
      "DropshipProductFeed.xml";

    const xml = await sftp.get(file);

    console.log(
      `FEED_DOWNLOAD_OK bytes=${xml.length}`
    );

    const parsed = new XMLParser({
      ignoreAttributes: false,
      trimValues: true
    }).parse(xml.toString("utf8"));

    console.log("FEED_XML_PARSE_OK");

    return extractRows(parsed);

  } finally {

    try {
      await sftp.end();
    } catch (_) {}
  }
}

async function shopifyAuth() {
  const domain = clean(
    process.env.SHOPIFY_STORE_DOMAIN
  )
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const clientId =
    process.env.SHOPIFY_CLIENT_ID;

  const clientSecret =
    process.env.SHOPIFY_CLIENT_SECRET;

  if (
    !domain ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      "Missing Shopify credentials"
    );
  }

  const res = await fetch(
    `https://${domain}/admin/oauth/access_token`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json"
      },

      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "client_credentials"
      })
    }
  );

  if (!res.ok) {
    throw new Error(
      `Shopify auth failed HTTP ${res.status}`
    );
  }

  const json = await res.json();

  if (!json.access_token) {
    throw new Error(
      "Shopify auth returned no access token"
    );
  }

  return {
    domain,
    token: json.access_token
  };
}

async function gql(
  auth,
  query,
  variables = {}
) {
  const res = await fetch(
    `https://${auth.domain}` +
    `/admin/api/${SHOPIFY_API_VERSION}` +
    `/graphql.json`,
    {
      method: "POST",

      headers: {
        "Content-Type":
          "application/json",

        "X-Shopify-Access-Token":
          auth.token
      },

      body: JSON.stringify({
        query,
        variables
      })
    }
  );

  const json = await res.json();

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}`
    );
  }

  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL: ` +
      `${JSON.stringify(json.errors)}`
    );
  }

  return json.data;
}

function searchEscape(v) {
  return clean(v)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"');
}

async function exactSkuMatches(
  auth,
  sku
) {
  const query = `
    query ExactSku($query: String!) {
      productVariants(
        first: 10,
        query: $query
      ) {
        nodes {
          id
          sku
          barcode

          product {
            id
            title
            vendor
            status
          }
        }
      }
    }
  `;

  const data = await gql(
    auth,
    query,
    {
      query:
        `sku:"${searchEscape(sku)}"`
    }
  );

  return (
    data.productVariants.nodes || []
  ).filter(
    v => clean(v.sku) === sku
  );
}

async function exactBarcodeMatches(
  auth,
  barcode
) {
  if (!clean(barcode)) {
    return [];
  }

  const query = `
    query ExactBarcode(
      $query: String!
    ) {
      productVariants(
        first: 20,
        query: $query
      ) {
        nodes {
          id
          sku
          barcode

          product {
            id
            title
            status
          }
        }
      }
    }
  `;

  const data = await gql(
    auth,
    query,
    {
      query:
        `barcode:"${searchEscape(barcode)}"`
    }
  );

  return (
    data.productVariants.nodes || []
  ).filter(
    v =>
      clean(v.barcode) ===
      clean(barcode)
  );
}

async function preflightFamily(
  auth,
  family
) {
  for (const item of family.items) {
    const sku =
      clean(item.row.ProductCode);

    const barcode =
      clean(item.row.Barcode);

    /*
      Exact SKU protection.
    */
    const skuMatches =
      await exactSkuMatches(
        auth,
        sku
      );

    if (skuMatches.length > 1) {
      return {
        ok: false,
        reason:
          `duplicate-shopify-sku:${sku}`
      };
    }

    if (skuMatches.length === 1) {
      return {
        ok: false,
        reason:
          `existing-sku:${sku}`
      };
    }

    /*
      Global barcode collision
      protection.
    */
    if (barcode) {
      const barcodeMatches =
        await exactBarcodeMatches(
          auth,
          barcode
        );

      if (
        barcodeMatches.length > 0
      ) {
        return {
          ok: false,
          reason:
            `barcode-collision:` +
            `${barcode}:` +
            barcodeMatches
              .map(
                x => clean(x.sku)
              )
              .join(",")
        };
      }
    }
  }

  return {
    ok: true
  };
}

async function createDraftFamily(
  auth,
  family
) {
  if (!family.items.length) {
    throw new Error(
      "EMPTY_FAMILY"
    );
  }

  /*
    Re-check every SKU/barcode
    immediately before writing.
  */
  const finalCheck =
    await preflightFamily(
      auth,
      family
    );

  if (!finalCheck.ok) {
    throw new Error(
      `PREFLIGHT_FAILED ` +
      `${finalCheck.reason}`
    );
  }

  const brand =
    clean(
      family.items[0].row.Brand
    ) || "Tropicana";

  const optionName =
    family.optionName;

  const seenOptions =
    new Set();

  const variants = [];
  const optionValues = [];

  for (
    const item of family.items
  ) {
    const r = item.row;

    const sku =
      clean(r.ProductCode);

    const barcode =
      clean(r.Barcode);

    const net =
      num(r.ProductPrice);

    if (
      !sku ||
      net === null ||
      net <= 0
    ) {
      throw new Error(
        `UNSAFE_VARIANT ${sku}`
      );
    }

    const value =
      clean(item.optionValue) ||
      "Default";

    const normalizedValue =
      norm(value);

    /*
      Shopify cannot safely create
      two variants with identical
      option values in this model.
    */
    if (
      seenOptions.has(
        normalizedValue
      )
    ) {
      throw new Error(
        `DUPLICATE_OPTION_VALUE ` +
        `family=${family.title} ` +
        `value=${value}`
      );
    }

    seenOptions.add(
      normalizedValue
    );

    optionValues.push({
      name: value
    });

    variants.push({
      optionValues: [
        {
          optionName,
          name: value
        }
      ],

      sku,

      barcode:
        barcode || null,

      price:
        String(
          pricing(net).retail
        ),

      taxable: false
    });
  }

  const mutation = `
    mutation CreateControlledFamily(
      $input: ProductSetInput!
    ) {
      productSet(
        synchronous: true,
        input: $input
      ) {
        product {
          id
          title
          status
          vendor

          variants(first: 100) {
            nodes {
              id
              sku
              barcode
              price
            }
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
    title:
      family.title,

    vendor:
      brand,

    status:
      "DRAFT",

    tags: [
      "Tropicana",
      "Tropicana Dropship",
      "PPL controlled import",
      "PPL V2 family import"
    ],

    productOptions: [
      {
        name:
          optionName,

        values:
          optionValues
      }
    ],

    variants
  };

  const data =
    await gql(
      auth,
      mutation,
      { input }
    );

  const result =
    data.productSet;

  if (
    result.userErrors?.length
  ) {
    throw new Error(
      `CREATE_USER_ERRORS ` +
      `${JSON.stringify(
        result.userErrors
      )}`
    );
  }

  const product =
    result.product;

  if (
    !product ||
    product.status !== "DRAFT"
  ) {
    throw new Error(
      "POST_CREATE_PRODUCT_VERIFY_FAILED"
    );
  }

  const createdVariants =
    product.variants?.nodes || [];

  /*
    Verify every created variant
    against the supplier SKU and
    barcode.
  */
  for (
    const item of family.items
  ) {
    const sku =
      clean(item.row.ProductCode);

    const barcode =
      clean(item.row.Barcode);

    const matches =
      createdVariants.filter(
        v =>
          clean(v.sku) === sku
      );

    if (
      matches.length !== 1 ||
      clean(
        matches[0].barcode
      ) !== barcode
    ) {
      throw new Error(
        `POST_CREATE_VARIANT_VERIFY_FAILED ` +
        `${sku}`
      );
    }
  }

  /*
    Independent Shopify search
    verification after creation.
  */
  for (
    const item of family.items
  ) {
    const sku =
      clean(item.row.ProductCode);

    const after =
      await exactSkuMatches(
        auth,
        sku
      );

    if (
      after.length !== 1 ||
      after[0].product.id !==
        product.id ||
      after[0].product.status !==
        "DRAFT"
    ) {
      throw new Error(
        `FINAL_EXACT_SKU_VERIFY_FAILED ` +
        `${sku}`
      );
    }
  }

  console.log(
    `FAMILY_CREATED_VERIFIED ` +
    `${JSON.stringify({
      productId:
        product.id,

      title:
        product.title,

      status:
        product.status,

      variantCount:
        family.items.length,

      skus:
        family.items.map(
          x =>
            clean(
              x.row.ProductCode
            )
        )
    })}`
  );

  return product.id;
}

async function main() {
  console.log(
    "BUILD_MARKER " +
    "PPL-CATALOGUE-WRITER-V2-20SKU"
  );

  console.log(
    "MODE=" +
    "CONTROLLED_FAMILY_WRITE_DRAFT_ONLY"
  );

  console.log(
    `TEST_SKU_LIMIT=${TEST_SKU_LIMIT}`
  );

  console.log(
    "INVENTORY_WRITES_ALLOWED=NO"
  );

  console.log(
    "ORDER_CALLS_ALLOWED=NO"
  );

  console.log(
    "PUBLISHING_ALLOWED=NO"
  );

  const rows =
    await loadFeed();

  console.log(
    `CATALOGUE_ROWS=${rows.length}`
  );

  /*
    Group duplicate XML rows
    by exact ProductCode.
  */
  const bySku =
    new Map();

  for (const r of rows) {
    const sku =
      clean(r.ProductCode);

    if (!sku) continue;

    if (!bySku.has(sku)) {
      bySku.set(
        sku,
        []
      );
    }

    bySku
      .get(sku)
      .push(r);
  }

  /*
    Only retain ProductCodes whose
    sellable identity is consistent
    across duplicate XML rows.
  */
  const safe =
    new Map();

  let conflicts = 0;

  for (
    const [sku, group]
    of bySku
  ) {
    const ids =
      new Set(
        group.map(identity)
      );

    if (ids.size !== 1) {
      conflicts++;
      continue;
    }

    safe.set(
      sku,
      group[0]
    );
  }

  console.log(
    `UNIQUE_PRODUCT_CODES=` +
    `${bySku.size}`
  );

  console.log(
    `CONFLICTING_DUPLICATES_SKIPPED=` +
    `${conflicts}`
  );

  /*
    Apply hard safety blocks,
    ordinary exclusions and
    price validation.
  */
  const candidates = [];

  for (
    const [sku, r]
    of safe
  ) {
    const hard =
      hardBlocked(r);

    if (hard) {
      console.log(
        `HARD_BLOCK ` +
        `${sku} ${hard}`
      );

      continue;
    }

    if (
      ordinaryExcluded(r)
    ) {
      continue;
    }

    const net =
      num(r.ProductPrice);

    if (
      net === null ||
      net <= 0
    ) {
      continue;
    }

    candidates.push(r);
  }

  console.log(
    `SAFE_FEED_CANDIDATES=` +
    `${candidates.length}`
  );

  /*
    Build conservative product
    families.
  */
  const familyMap =
    new Map();

  for (
    const r of candidates
  ) {
    const info =
      familyInfo(r);

    if (
      !familyMap.has(
        info.key
      )
    ) {
      familyMap.set(
        info.key,
        {
          key:
            info.key,

          title:
            info.title,

          optionName:
            info.optionName,

          groupable:
            info.groupable,

          items: []
        }
      );
    }

    familyMap
      .get(info.key)
      .items.push({
        row: r,
        optionValue:
          info.optionValue
      });
  }

  const families =
    [...familyMap.values()];

  console.log(
    `SAFE_FAMILIES=` +
    `${families.length}`
  );

  console.log(
    `MULTI_VARIANT_FAMILIES=` +
    `${
      families.filter(
        f =>
          f.items.length > 1
      ).length
    }`
  );

  const auth =
    await shopifyAuth();

  let createdSkus = 0;
  let createdProducts = 0;

  let skippedExistingFamily = 0;
  let skippedCollisionFamily = 0;
  let skippedLimit = 0;

  let failed = 0;

  for (
    const family
    of families
  ) {
    if (
      createdSkus >=
      TEST_SKU_LIMIT
    ) {
      break;
    }

    /*
      Never create only part of
      a family.
    */
    if (
      createdSkus +
      family.items.length >
      TEST_SKU_LIMIT
    ) {
      skippedLimit++;
      continue;
    }

    try {
      const check =
        await preflightFamily(
          auth,
          family
        );

      if (!check.ok) {
        if (
          check.reason.startsWith(
            "existing-sku:"
          )
        ) {
          skippedExistingFamily++;
        } else {
          skippedCollisionFamily++;

          console.log(
            `SKIP_FAMILY ` +
            `${family.title} ` +
            `${check.reason}`
          );
        }

        continue;
      }

      await createDraftFamily(
        auth,
        family
      );

      createdSkus +=
        family.items.length;

      createdProducts++;

    } catch (err) {
      failed++;

      console.error(
        `WRITE_FAILED ` +
        `family=${family.title} ` +
        `error=${
          err?.message ||
          String(err)
        }`
      );

      /*
        Fail closed after any
        uncertain write.
      */
      break;
    }
  }

  console.log(
    "CONTROLLED_V2_WRITE_COMPLETE"
  );

  console.log(
    `DRAFT_PRODUCTS_CREATED_VERIFIED=` +
    `${createdProducts}`
  );

  console.log(
    `DRAFT_SKUS_CREATED_VERIFIED=` +
    `${createdSkus}`
  );

  console.log(
    `EXISTING_FAMILIES_SKIPPED=` +
    `${skippedExistingFamily}`
  );

  console.log(
    `COLLISION_FAMILIES_SKIPPED=` +
    `${skippedCollisionFamily}`
  );

  console.log(
    `LIMIT_FAMILIES_SKIPPED=` +
    `${skippedLimit}`
  );

  console.log(
    `FAILED=${failed}`
  );

  console.log(
    "INVENTORY_WRITES=0"
  );

  console.log(
    "ORDER_CALLS=0"
  );

  console.log(
    "PUBLISHED_PRODUCTS=0"
  );

  if (
    createdSkus >
    TEST_SKU_LIMIT
  ) {
    throw new Error(
      "TEST_SKU_LIMIT_BREACHED"
    );
  }
}

main().catch(err => {
  console.error(
    "FATAL",
    err?.stack || err
  );

  process.exit(1);
});
