const SFTP = require('ssh2-sftp-client');

const { XMLParser } = require('fast-xml-parser');

const required = ['TROPICANA_SFTP_USER','TROPICANA_SFTP_PASSWORD','SHOPIFY_CLIENT_ID','SHOPIFY_CLIENT_SECRET','SHOPIFY_STORE_DOMAIN'];

for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key}`);

const shop = process.env.SHOPIFY_STORE_DOMAIN;

const apiVersion = '2026-07';

const locationId = 'gid://shopify/Location/120937251150';

async function token() {

  const body = new URLSearchParams({grant_type:'client_credentials',client_id:process.env.SHOPIFY_CLIENT_ID,client_secret:process.env.SHOPIFY_CLIENT_SECRET});

  const r = await fetch(`https://${shop}/admin/oauth/access_token`, {method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});

  if (!r.ok) throw new Error(`Shopify token failed ${r.status}: ${await r.text()}`);

  return (await r.json()).access_token;

}

async function gql(accessToken, query, variables={}) {

  const r = await fetch(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {method:'POST',headers:{'content-type':'application/json','x-shopify-access-token':accessToken},body:JSON.stringify({query,variables})});

  const j = await r.json();

  if (!r.ok || j.errors) throw new Error(`Shopify GraphQL failed: ${JSON.stringify(j.errors || j)}`);

  return j.data;

}

function records(node, out=[]) {

  if (Array.isArray(node)) for (const v of node) records(v,out);

  else if (node && typeof node === 'object') {

    if (Object.prototype.hasOwnProperty.call(node,'ProductCode')) out.push(node);

    for (const v of Object.values(node)) records(v,out);

  }

  return out;

}

function feedQuantity(row) {

  const keys = ['StockLevel','StockQuantity','StockQty','FreeStock','AvailableStock','QuantityAvailable','AvailableQuantity','QtyInStock'];

  const present = keys.filter(k => Object.prototype.hasOwnProperty.call(row,k));

  if (present.length !== 1) throw new Error(`Unsafe stock fields for ${row.ProductCode}: ${present.join(',') || 'none'}; keys=${Object.keys(row).join(',')}`);

  const raw = String(row[present[0]]).trim();

  if (/^(out\s*of\s*stock|no|false|none)$/i.test(raw)) return 0;

  if (!/^-?\d+(?:\.0+)?$/.test(raw)) throw new Error(`Invalid quantity for ${row.ProductCode}: field=${present[0]} value=${JSON.stringify(raw)}`);

  const n = Number(raw);

  if (!Number.isSafeInteger(n) || n > 1000000) throw new Error(`Invalid quantity for ${row.ProductCode}: field=${present[0]} value=${JSON.stringify(raw)}`);

  if (n < 0) {

    console.warn(`NEGATIVE_STOCK_CLAMPED ${row.ProductCode} ${n}->0`);

    return 0;

  }

  return n;

}

async function supplierFeed() {

  const s = new SFTP();

  try {

    await s.connect({host:'tropicana.ftp.redtechnology.com',port:22,username:process.env.TROPICANA_SFTP_USER,password:process.env.TROPICANA_SFTP_PASSWORD,readyTimeout:30000});

    const b = await s.get('DropshipProductFeed.xml');

    const parsed = new XMLParser({trimValues:true,parseTagValue:false}).parse(b.toString());

    const rows = records(parsed);

    const map = new Map(), duplicates = new Set();

    for (const row of rows) {

      const sku = String(row.ProductCode ?? '').trim();

      if (!sku) continue;

      const qty = feedQuantity(row);

      if (map.has(sku)) duplicates.add(sku); else map.set(sku,qty);

    }

    for (const sku of duplicates) map.delete(sku);

    console.log(`FEED_OK rows=${rows.length} unique=${map.size} duplicate_codes_blocked=${duplicates.size}`);

    return map;

  } finally { try { await s.end(); } catch {} }

}

async function variants(accessToken) {

  const query = `query Variants($after:String){productVariants(first:100,after:$after){nodes{id sku inventoryQuantity inventoryItem{id} product{id status}} pageInfo{hasNextPage endCursor}}}`;

  const all=[]; let after=null;

  do {

    const d=await gql(accessToken,query,{after});

    all.push(...d.productVariants.nodes);

    after=d.productVariants.pageInfo.hasNextPage?d.productVariants.pageInfo.endCursor:null;

  } while(after);

  return all;

}

async function setQuantity(accessToken, item, quantity, compareQuantity) {

  const mutation=`mutation SetInventory($input:InventorySetQuantitiesInput!,$key:String!){inventorySetQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{changes{name delta quantityAfterChange}} userErrors{field message}}}`;

  const input={name:'available',reason:'correction',referenceDocumentUri:`gid://ppl-tropicana-sync/StockSync/${Date.now()}`,quantities:[{inventoryItemId:item,locationId,quantity,changeFromQuantity:compareQuantity}]};

  const d=await gql(accessToken,mutation,{input,key:crypto.randomUUID()});

  const errs=d.inventorySetQuantities.userErrors;

  if(errs.length) throw new Error(JSON.stringify(errs));

  const check=`query ReadBack($id:ID!){inventoryItem(id:$id){variants(first:1){nodes{inventoryQuantity}}}}`;

  const read=await gql(accessToken,check,{id:item});

  const actual=read.inventoryItem.variants.nodes[0]?.inventoryQuantity;

  if(actual!==quantity) throw new Error(`Read-back mismatch expected=${quantity} got=${actual}`);

}

(async()=>{

  const feed=await supplierFeed();

  const accessToken=await token();

  const all=await variants(accessToken);

  const bySku=new Map();

  for(const v of all){

    const sku=(v.sku||'').trim();

    if(!sku||!feed.has(sku))continue;

    if(!bySku.has(sku))bySku.set(sku,[]);

    bySku.get(sku).push(v);

  }

  let changed=0,unchanged=0,blocked=0;

  for(const [sku,list] of bySku){

    const active=list.filter(v=>v.product.status==='ACTIVE');

    if(active.length!==1){

      console.error(`BLOCKED sku=${sku} active_matches=${active.length}`);

      blocked++;

      continue;

    }

    const v=active[0], current=v.inventoryQuantity;

    const wanted=feed.get(sku);

    if(current===wanted){

      unchanged++;

      continue;

    }

    await setQuantity(accessToken,v.inventoryItem.id,wanted,current);

    console.log(`VERIFIED sku=${sku} from=${current} to=${wanted}`);

    changed++;

  }

  console.log(`SYNC_COMPLETE changed=${changed} unchanged=${unchanged} blocked=${blocked} matched_skus=${bySku.size}`);

})().catch(e=>{

  console.error('SYNC_FAILED',e.stack||e);

  process.exit(1);

});
