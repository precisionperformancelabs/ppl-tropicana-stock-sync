"use strict";

/*
  PPL Tropicana controlled catalogue writer
  TEST MODE:
  - maximum 5 NEW products
  - DRAFT only
  - ZERO inventory writes
  - ZERO order calls
  - exact SKU protection
  - hard nicotine/vape/alcohol block
  - PPL / Hiro / KMT protected
*/

const SFTP = require("ssh2-sftp-client");
const { XMLParser } = require("fast-xml-parser");

const TEST_LIMIT = 5;
const SHOPIFY_API_VERSION = "2026-07";

function clean(v) {
  return String(v ?? "").trim();
}

function norm(v) {
  return clean(v).toLowerCase();
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

  // Never create our own/non-Tropicana protected ranges.
  if (
    b === "ppl" ||
    b.includes("precision performance labs") ||
    b === "hiro" ||
    b === "kmt"
  ) {
    return "protected-brand";
  }

  // Non-negotiable prohibited catalogue items.
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

  if (/\b(sauce|sauces|syrup|syrups)\b/.test(t)) return "sauce/syrup";
  if (/\bwipes\b/.test(t)) return "wipes";
  if (/\b(chips|crisps)\b/.test(t)) return "chips/crisps";
  if (t.includes("cereal bar")) return "cereal bar";

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
        for (const item of v) walk(item);
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

async function loadFeed() {
  const required = ["TROPICANA_SFTP_USER", "TROPICANA_SFTP_PASSWORD"];

  for (const k of required) {
    if (!process.env[k]) throw new Error(`Missing ${k}`);
  }

  const sftp = new SFTP();

  try {
    await sftp.connect({
      host: process.env.TROPICANA_SFTP_HOST || "tropicana.ftp.redtechnology.com",
      port: Number(process.env.TROPICANA_SFTP_PORT || 22),
      username: process.env.TROPICANA_SFTP_USER,
      password: process.env.TROPICANA_SFTP_PASSWORD
    });

    console.log("TROPICANA_LOGIN_OK");

    const file =
      process.env.TROPICANA_SFTP_FILE || "DropshipProductFeed.xml";

    const xml = await sftp.get(file);

    console.log(`FEED_DOWNLOAD_OK bytes=${xml.length}`);

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
  const domain = clean(process.env.SHOPIFY_STORE_DOMAIN)
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!domain || !clientId || !clientSecret) {
    throw new Error("Missing Shopify credentials");
  }

  const res = await fetch(`https://${domain}/admin/oauth/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials"
    })
  });

  if (!res.ok) {
    throw new Error(`Shopify auth failed HTTP ${res.status}`);
  }

  const json = await res.json();

  if (!json.access_token) {
    throw new Error("Shopify auth returned no access token");
  }

  return {
    domain,
    token: json.access_token
  };
}

async function gql(auth, query, variables = {}) {
  const res = await fetch(
    `https://${auth.domain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": auth.token
      },
      body: JSON.stringify({ query, variables })
    }
  );

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  }

  if (json.errors?.length) {
    throw new Error(`Shopify GraphQL: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

async function exactSkuMatches(auth, sku) {
  const query = `
    query ExactSku($query: String!) {
      productVariants(first: 10, query: $query) {
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

  const escaped = sku.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

  const data = await gql(auth, query, {
    query: `sku:"${escaped}"`
  });

  return (data.productVariants.nodes || []).filter(
    v => clean(v.sku) === sku
  );
}

async function createDraft(auth, r) {
  const sku = clean(r.ProductCode);
  const title = clean(r.TranslationName);
  const brand = clean(r.Brand) || "Tropicana";
  const barcode = clean(r.Barcode);
  const flavour = clean(r.Flavour);
  const size = clean(r.Size);
  const net = num(r.ProductPrice);

  if (!sku || !title || net === null || net <= 0) {
    throw new Error(`Unsafe create candidate ${sku || "(blank SKU)"}`);
  }

  const p = pricing(net);

  /*
    productSet lets us create the product and its initial variant together.
    Status is deliberately DRAFT.
    Inventory quantities are deliberately NOT supplied.
  */
  const mutation = `
    mutation CreateControlledDraft($input: ProductSetInput!) {
      productSet(synchronous: true, input: $input) {
        product {
          id
          title
          status
          vendor
          variants(first: 10) {
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

  const optionName = flavour ? "Flavour" : "Title";
  const optionValue = flavour || size || "Default";

  const input = {
    title,
    vendor: brand,
    status: "DRAFT",
    tags: ["Tropicana", "Tropicana Dropship", "PPL controlled import"],
    productOptions: [
      {
        name: optionName,
        values: [{ name: optionValue }]
      }
    ],
    variants: [
      {
        optionValues: [
          {
            optionName,
            name: optionValue
          }
        ],
        sku,
        barcode: barcode || null,
        price: String(p.retail),
        taxable: false
      }
    ]
  };

  const data = await gql(auth, mutation, { input });

  const result = data.productSet;

  if (result.userErrors?.length) {
    throw new Error(
      `CREATE_USER_ERRORS ${sku} ${JSON.stringify(result.userErrors)}`
    );
  }

  const created = result.product;
  const variants = created?.variants?.nodes || [];

  const exact = variants.filter(v => clean(v.sku) === sku);

  if (
    !created ||
    created.status !== "DRAFT" ||
    exact.length !== 1 ||
    clean(exact[0].barcode) !== barcode
  ) {
    throw new Error(`POST_CREATE_VERIFICATION_FAILED ${sku}`);
  }

  console.log(
    `CREATED_VERIFIED ${JSON.stringify({
      sku,
      productId: created.id,
      title: created.title,
      status: created.status,
      barcode,
      retail: p.retail,
      supplierNet: p.net
    })}`
  );

  return created.id;
}

async function main() {
  console.log("BUILD_MARKER PPL-CATALOGUE-WRITER-TEST-5-V1");
  console.log("MODE=CONTROLLED_WRITE_DRAFT_ONLY");
  console.log(`TEST_LIMIT=${TEST_LIMIT}`);
  console.log("INVENTORY_WRITES_ALLOWED=NO");
  console.log("ORDER_CALLS_ALLOWED=NO");

  const rows = await loadFeed();

  console.log(`CATALOGUE_ROWS=${rows.length}`);

  const bySku = new Map();

  for (const r of rows) {
    const sku = clean(r.ProductCode);
    if (!sku) continue;

    if (!bySku.has(sku)) bySku.set(sku, []);
    bySku.get(sku).push(r);
  }

  const safe = new Map();
  let conflicts = 0;

  for (const [sku, group] of bySku) {
    const ids = new Set(group.map(identity));

    if (ids.size !== 1) {
      conflicts++;
      continue;
    }

    safe.set(sku, group[0]);
  }

  console.log(`UNIQUE_PRODUCT_CODES=${bySku.size}`);
  console.log(`CONFLICTING_DUPLICATES_SKIPPED=${conflicts}`);

  const candidates = [];

  for (const [sku, r] of safe) {
    const hard = hardBlocked(r);

    if (hard) {
      console.log(`HARD_BLOCK ${sku} ${hard}`);
      continue;
    }

    if (ordinaryExcluded(r)) continue;

    const net = num(r.ProductPrice);

    if (net === null || net <= 0) continue;

    candidates.push(r);
  }

  console.log(`SAFE_FEED_CANDIDATES=${candidates.length}`);

  const auth = await shopifyAuth();

  let created = 0;
  let existing = 0;
  let collision = 0;
  let failed = 0;

  for (const r of candidates) {
    if (created >= TEST_LIMIT) break;

    const sku = clean(r.ProductCode);

    try {
      // Re-read Shopify immediately before every individual write.
      const before = await exactSkuMatches(auth, sku);

      if (before.length > 1) {
        collision++;
        console.log(`SKIP_SHOPIFY_DUPLICATE_SKU ${sku} matches=${before.length}`);
        continue;
      }

      if (before.length === 1) {
        existing++;
        continue;
      }

      await createDraft(auth, r);

      // Independent post-write exact-SKU verification.
      const after = await exactSkuMatches(auth, sku);

      if (
        after.length !== 1 ||
        after[0].product.status !== "DRAFT"
      ) {
        throw new Error(`FINAL_EXACT_SKU_VERIFY_FAILED ${sku}`);
      }

      created++;
    } catch (err) {
      failed++;
      console.error(
        `WRITE_FAILED sku=${sku} error=${err?.message || String(err)}`
      );

      // Fail closed. Do not keep creating products after an uncertain write.
      break;
    }
  }

  console.log("CONTROLLED_WRITE_COMPLETE");
  console.log(`DRAFTS_CREATED_VERIFIED=${created}`);
  console.log(`EXISTING_EXACT_SKUS_SKIPPED=${existing}`);
  console.log(`SHOPIFY_DUPLICATE_SKUS_SKIPPED=${collision}`);
  console.log(`FAILED=${failed}`);
  console.log("INVENTORY_WRITES=0");
  console.log("ORDER_CALLS=0");

  if (created > TEST_LIMIT) {
    throw new Error("TEST_LIMIT_BREACHED");
  }
}

main().catch(err => {
  console.error("FATAL", err?.stack || err);
  process.exit(1);
});
