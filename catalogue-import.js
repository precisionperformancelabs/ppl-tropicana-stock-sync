const SFTP = require('ssh2-sftp-client');
const { XMLParser } = require('fast-xml-parser');

const required = [
  'TROPICANA_SFTP_USER',
  'TROPICANA_SFTP_PASSWORD'
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing ${key}`);
  }
}

const BUILD_MARKER =
  'PPL-CATALOGUE-IMPORT-READONLY-2026-09-18-V1';

function records(node, out = []) {
  if (Array.isArray(node)) {
    for (const value of node) {
      records(value, out);
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

    for (const value of Object.values(node)) {
      records(value, out);
    }
  }

  return out;
}

function clean(value) {
  if (
    value === undefined ||
    value === null
  ) {
    return '';
  }

  return String(value).trim();
}

async function loadFeed() {
  const sftp = new SFTP();

  try {
    console.log('TROPICANA_CONNECTING');

    await sftp.connect({
      host: 'tropicana.ftp.redtechnology.com',
      port: 22,
      username:
        process.env.TROPICANA_SFTP_USER,
      password:
        process.env.TROPICANA_SFTP_PASSWORD,
      readyTimeout: 30000
    });

    console.log('TROPICANA_LOGIN_OK');

    const buffer = await sftp.get(
      'DropshipProductFeed.xml'
    );

    console.log(
      `FEED_DOWNLOAD_OK bytes=${buffer.length}`
    );

    const parsed = new XMLParser({
      trimValues: true,
      parseTagValue: false
    }).parse(buffer.toString());

    console.log('FEED_XML_PARSE_OK');

    return records(parsed);

  } finally {
    try {
      await sftp.end();
    } catch {}
  }
}

(async () => {
  console.log(
    `BUILD_MARKER ${BUILD_MARKER}`
  );

  console.log(
    'MODE=READ_ONLY_NO_SHOPIFY_WRITES'
  );

  const rows = await loadFeed();

  console.log(
    `CATALOGUE_ROWS=${rows.length}`
  );

  const unique = new Map();
  const duplicates = new Map();

  for (const row of rows) {
    const sku = clean(row.ProductCode);

    if (!sku) {
      continue;
    }

    if (!unique.has(sku)) {
      unique.set(sku, row);
    } else {
      duplicates.set(
        sku,
        (duplicates.get(sku) || 1) + 1
      );
    }
  }

  console.log(
    `UNIQUE_PRODUCT_CODES=${unique.size}`
  );

  console.log(
    `DUPLICATE_PRODUCT_CODES=${duplicates.size}`
  );

  const sample =
    [...unique.entries()].slice(0, 20);

    for (const [sku, row] of sample) {
    console.log(
      'FEED_SAMPLE ' +
      JSON.stringify({
        ProductCode: sku,
        Description:
          clean(row.Description) ||
          clean(row.ProductName) ||
          clean(row.Name),
        Barcode:
          clean(row.Barcode) ||
          clean(row.EAN) ||
          clean(row.EAN13),
        Price:
          clean(row.Price) ||
          clean(row.CostPrice) ||
          clean(row.TradePrice),
        Stock:
          clean(row.StockLevel) ||
          clean(row.StockQuantity) ||
          clean(row.StockQty) ||
          clean(row.FreeStock)
      })
    );
  }

  console.log(
    'CATALOGUE_AUDIT_COMPLETE'
  );

  console.log(
    'NO_SHOPIFY_CHANGES_MADE'
  );

})().catch(error => {
  console.error(
    'CATALOGUE_AUDIT_FAILED',
    error.stack || error
  );

  process.exit(1);
});
