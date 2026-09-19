'use strict';

const SFTP = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');

const BUILD = 'PPL-CATALOGUE-RECON-READONLY-2026-09-19-V3';
const API = '2026-07';

for (const k of ['TROPICANA_SFTP_USER', 'TROPICANA_SFTP_PASSWORD']) {
  if (!process.env[k]) throw new Error(`Missing ${k}`);
}

const clean = v => v == null ? '' : String(v).trim();

const norm = v => clean(v)
  .toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

const num = v => {
  if (!clean(v)) return null;
  const n = Number(clean(v).replace(/[^0-9.-]/g, ''));
  return Number.isFinite(n) && n >= 0 ? n : null;
};

const money = n => Math.round(n * 100) / 100;

function findRows(node, out = []) {
  if (Array.isArray(node)) {
    for (const x of node) findRows(x, out);
  } else if (node && typeof node === 'object') {
    if (Object.prototype.hasOwnProperty.call(node, 'ProductCode')) {
      out.push(node);
    }
    for (const x of Object.values(node)) findRows(x, out);
  }
  return out;
}

function row(r) {
  return {
    ProductCode: clean(r.ProductCode),
    TranslationName: clean(r.TranslationName),
    Tax: clean(r.Tax),
    StockLevel: clean(r.StockLevel),
    Barcode: clean(r.Barcode),
    Brand: clean(r.Brand),
    Flavour: clean(r.Flavour),
    FilterByCategory: clean(r.FilterByCategory),
    NutritionalInformation: clean(r.NutritionalInformation),
    Size: clean(r.Size),
    ProductFlag: clean(r.ProductFlag),
    ProductFlagDate: clean(r.ProductFlagDate),
    ProductPrice: clean(r.ProductPrice),
    ExpiryDate: clean(r.ExpiryDate)
  };
}

function identity(r) {
  const x = { ...r };
  delete x.StockLevel;
  return JSON.stringify(x);
}

function pricing(net) {
  const vat = net * 1.2;
  const landed = vat + 6;
  const rate = landed < 20 ? 1.175 : 1.125;

  return {
    net: money(net),
    vatCost: money(vat),
    landed: money(landed),
    rule: landed < 20 ? '17.5%' : '12.5%',
    retail: money(landed * rate)
  };
}

function excluded(r) {
  const b = norm(r.Brand);
  const n = norm(r.TranslationName);
  const c = norm(r.FilterByCategory);
  const t = `${b} ${n} ${c}`;

  const blocked = [
    'irn bru', 'kellogg', 'red bull', 'peperami',
    'nature valley', 'lucozade', 'monster', 'mars',
    'm and ms', 'nutry nuts', 'powerade', 'ribena',
    'savvy sweets', 'shaken udder', 'snickers',
    'top g', 'the curators', 'trek', 'grill master'
  ];

  for (const x of blocked) {
    if (t.includes(x)) return x;
  }

  if (t.includes('nicotine') || t.includes('vape')) return 'nicotine';
  if (/\b(alcohol|beer|wine|cider)\b/.test(t)) return 'alcohol';
  if (/\b(sauce|sauces|syrup|syrups)\b/.test(t)) return 'sauce/syrup';
  if (/\bwipes\b/.test(t)) return 'wipes';
  if (t.includes('protein water')) return 'protein water';
  if (c === 'water' || n === 'water' || t.includes('bottled water')) return 'water';
  if (t.includes('cereal bar')) return 'cereal bar';
  if (/\b(chips|crisps)\b/.test(t)) return 'chips/crisps';

  if (
    t.includes('single serving') ||
    t.includes('single sachet') ||
    t.includes('1 sachet') ||
    t.includes('1x sachet')
  ) return 'single serving';

  return '';
}

function family(r) {
  let name = clean(r.TranslationName);
  const flavour = clean(r.Flavour);

  if (flavour) {
    const e = flavour.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    name = name.replace(new RegExp(`\\s+${e}\\s*$`, 'i'), '');
  }

  return [
    norm(r.Brand),
    norm(name),
    norm(r.Size),
    norm(r.FilterByCategory)
  ].join('|');
}

async function feed() {
  const s = new SFTP();

  try {
    console.log('TROPICANA_CONNECTING');

    await s.connect({
      host: 'tropicana.ftp.redtechnology.com',
      port: 22,
      username: process.env.TROPICANA_SFTP_USER,
      password: process.env.TROPICANA_SFTP_PASSWORD,
      readyTimeout: 30000
    });

    console.log('TROPICANA_LOGIN_OK');

    const b = await s.get('DropshipProductFeed.xml');
    console.log(`FEED_DOWNLOAD_OK bytes=${b.length}`);

    const xml = new XMLParser({
      trimValues: true,
      parseTagValue: false
    }).parse(b.toString());

    console.log('FEED_XML_PARSE_OK');
    return findRows(xml);
  } finally {
    try { await s.end(); } catch {}
  }
}

async function auth() {
  const domain = clean(process.env.SHOPIFY_STORE_DOMAIN)
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '');

  const id = clean(process.env.SHOPIFY_CLIENT_ID);
  const secret = clean(process.env.SHOPIFY_CLIENT_SECRET);

  if (!domain || !id || !secret) return null;

  const res = await fetch(
    `https://${domain}/admin/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: id,
        client_secret: secret
      })
    }
  );

  if (!res.ok) throw new Error(`SHOPIFY_AUTH_${res.status}`);

  const j = await res.json();
  if (!j.access_token) throw new Error('SHOPIFY_AUTH_NO_TOKEN');

  console.log('SHOPIFY_AUTH_OK');
  return { domain, token: j.access_token };
}

async function gql(a, query, variables = {}) {
  if (/\bmutation\b/i.test(query)) {
    throw new Error('MUTATION_BLOCKED');
  }

  const res = await fetch(
    `https://${a.domain}/admin/api/${API}/graphql.json`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': a.token
      },
      body: JSON.stringify({ query, variables })
    }
  );

  if (!res.ok) throw new Error(`SHOPIFY_HTTP_${res.status}`);

  const j = await res.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));

  return j.data;
}

async function allVariants(a, id, first) {
  const out = [...first.nodes];
  let p = first.pageInfo;

  const q = `
    query($id:ID!,$after:String){
      product(id:$id){
        variants(first:100,after:$after){
          nodes{id title sku barcode price}
          pageInfo{hasNextPage endCursor}
        }
      }
    }`;

  while (p.hasNextPage) {
    const d = await gql(a, q, {
      id,
      after: p.endCursor
    });

    out.push(...d.product.variants.nodes);
    p = d.product.variants.pageInfo;
  }

  return out;
}

async function shopify(a) {
  const out = [];
  let after = null;

  const q = `
    query($after:String){
      products(first:100,after:$after,sortKey:ID){
        nodes{
          id title status vendor tags
          featuredMedia{
            ... on MediaImage{image{url}}
          }
          variants(first:100){
            nodes{id title sku barcode price}
            pageInfo{hasNextPage endCursor}
          }
        }
        pageInfo{hasNextPage endCursor}
      }
    }`;

  while (true) {
    const d = await gql(a, q, { after });

    for (const p of d.products.nodes) {
      out.push({
        ...p,
        variants: await allVariants(a, p.id, p.variants)
      });
    }

    console.log(`SHOPIFY_PRODUCTS_READ=${out.length}`);

    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }

  console.log(
    `SHOPIFY_VARIANTS_READ=${out.reduce((n, p) => n + p.variants.length, 0)}`
  );

  return out;
}

(async () => {
  console.log(`BUILD_MARKER ${BUILD}`);
  console.log('MODE=READ_ONLY_NO_SHOPIFY_WRITES');

  const raw = await feed();
  console.log(`CATALOGUE_ROWS=${raw.length}`);

  const groups = new Map();

  for (const x of raw) {
    const r = row(x);
    if (!r.ProductCode) continue;

    if (!groups.has(r.ProductCode)) groups.set(r.ProductCode, []);
    groups.get(r.ProductCode).push(r);
  }

  console.log(`UNIQUE_PRODUCT_CODES=${groups.size}`);

  const safe = new Map();
  let duplicate = 0;
  let identical = 0;
  let conflict = 0;

  for (const [sku, rows] of groups) {
    if (rows.length === 1) {
      safe.set(sku, rows[0]);
      continue;
    }

    duplicate++;

    const ids = new Set(rows.map(identity));

    if (ids.size === 1) {
      identical++;
      safe.set(sku, rows[0]);
    } else {
      conflict++;

      console.log(
        'DUPLICATE_CONFLICT ' +
        JSON.stringify({
          sku,
          rows: rows.map(r => ({
            name: r.TranslationName,
            barcode: r.Barcode,
            price: r.ProductPrice,
            stock: r.StockLevel
          }))
        })
      );
    }
  }

  console.log(`DUPLICATE_PRODUCT_CODES=${duplicate}`);
  console.log(`IDENTICAL_DUPLICATES=${identical}`);
  console.log(`CONFLICTING_DUPLICATES=${conflict}`);
  console.log(`SAFE_CANONICAL_SKUS=${safe.size}`);

  const eligible = new Map();
  const excludedCounts = new Map();

  let excludedTotal = 0;
  let invalidPrice = 0;

  for (const [sku, r] of safe) {
    const reason = excluded(r);

    if (reason) {
      excludedTotal++;
      excludedCounts.set(
        reason,
        (excludedCounts.get(reason) || 0) + 1
      );
      continue;
    }

    const net = num(r.ProductPrice);

    if (net === null) {
      invalidPrice++;
      continue;
    }

    eligible.set(sku, {
      ...r,
      Pricing: pricing(net)
    });
  }

  console.log(`ELIGIBLE_FEED_SKUS=${eligible.size}`);
  console.log(`EXCLUDED_FEED_SKUS=${excludedTotal}`);
  console.log(`INVALID_PRICE_SKUS=${invalidPrice}`);

  for (const [reason, count] of excludedCounts) {
    console.log(`EXCLUSION ${reason}=${count}`);
  }

  const families = new Map();

  for (const [sku, r] of eligible) {
    const k = family(r);

    if (!families.has(k)) families.set(k, []);

    families.get(k).push({
      sku,
      name: r.TranslationName,
      flavour: r.Flavour,
      size: r.Size
    });
  }

  const flavourGroups = [...families.values()]
    .filter(x => x.length > 1);

  console.log(`CANDIDATE_FLAVOUR_GROUPS=${flavourGroups.length}`);
  console.log(
    `CANDIDATE_FLAVOUR_SKUS=${flavourGroups.reduce((n, x) => n + x.length, 0)}`
  );

  const a = await auth();

  if (!a) {
    console.log('SHOPIFY_RECONCILIATION_SKIPPED=NO_CREDENTIALS');
    console.log('NO_SHOPIFY_CHANGES_MADE');
    return;
  }

  const products = await shopify(a);
  const skuMap = new Map();

  for (const p of products) {
    for (const v of p.variants) {
      const sku = clean(v.sku);
      if (!sku) continue;

      if (!skuMap.has(sku)) skuMap.set(sku, []);

      skuMap.get(sku).push({
        product: p.title,
        status: p.status,
        vendor: p.vendor,
        tags: p.tags || [],
        image: Boolean(
          p.featuredMedia &&
          p.featuredMedia.image &&
          p.featuredMedia.image.url
        ),
        variant: v.title,
        barcode: clean(v.barcode),
        price: num(v.price)
      });
    }
  }

  console.log(`SHOPIFY_UNIQUE_SKUS=${skuMap.size}`);

  let existing = 0;
  let missing = 0;
  let duplicateShopify = 0;
  let barcodeMismatch = 0;
  let noImage = 0;
  let higherPrice = 0;
  let lowerPrice = 0;

  const missingRows = [];

  for (const [sku, r] of eligible) {
    const matches = skuMap.get(sku);

    if (!matches) {
      missing++;

      missingRows.push({
        sku,
        name: r.TranslationName,
        brand: r.Brand,
        flavour: r.Flavour,
        size: r.Size,
        category: r.FilterByCategory,
        barcode: r.Barcode,
        stock: r.StockLevel,
        supplierNet: r.Pricing.net,
        retail: r.Pricing.retail
      });

      continue;
    }

    existing++;

    if (matches.length !== 1) {
      duplicateShopify++;
      continue;
    }

    const m = matches[0];

    if (!m.image) noImage++;

    if (
      r.Barcode &&
      m.barcode &&
      clean(r.Barcode) !== m.barcode
    ) {
      barcodeMismatch++;
    }

    if (m.price !== null) {
      if (m.price > r.Pricing.retail) higherPrice++;
      if (m.price < r.Pricing.retail) lowerPrice++;
    }
  }

  console.log(`EXISTING_EXACT_ELIGIBLE_SKUS=${existing}`);
  console.log(`MISSING_ELIGIBLE_SKUS=${missing}`);
  console.log(`SHOPIFY_DUPLICATE_SKU_COLLISIONS=${duplicateShopify}`);
  console.log(`BARCODE_MISMATCHES=${barcodeMismatch}`);
  console.log(`EXISTING_WITHOUT_FEATURED_IMAGE=${noImage}`);
  console.log(`EXISTING_PRICE_HIGHER_THAN_RULE=${higherPrice}`);
  console.log(`EXISTING_PRICE_LOWER_THAN_RULE=${lowerPrice}`);

  for (const x of missingRows.slice(0, 50)) {
    console.log('MISSING_SAMPLE ' + JSON.stringify(x));
  }

  console.log('RECONCILIATION_COMPLETE');
  console.log('IMPORTS_CREATED=0');
  console.log('PRODUCTS_UPDATED=0');
  console.log('INVENTORY_WRITES=0');
  console.log('ORDER_CALLS=0');
  console.log('NO_SHOPIFY_CHANGES_MADE');

})().catch(err => {
  console.error(
    'CATALOGUE_RECONCILIATION_FAILED',
    err.stack || err
  );

  console.log('NO_SHOPIFY_MUTATIONS_ATTEMPTED');
  process.exit(1);
});
