"use strict";

/*
PPL CONTROLLED CATALOGUE WRITER V3

FULL ELIGIBLE CATALOGUE RECONCILIATION

- Genuine flavour variants grouped where safe
- New products created as DRAFT only
- Missing variants may be added to one unambiguous existing parent
- Split-parent families are logged and skipped so the full run can continue
- Existing option-structure mismatches are logged and skipped
- ZERO inventory writes
- ZERO order calls
- ZERO publishing calls
- Exact SKU protection immediately before writes
- Global barcode collision protection
- Hard nicotine / vape / alcohol block
- PPL / Hiro / KMT protected
- Barebells / Natures Aid excluded
- Water / protein water excluded
- Olimp capsules excluded
- Clothing excluded
- Unexpected/uncertain write errors remain fail-closed
*/

const SFTP = require("ssh2-sftp-client");
const { XMLParser } = require("fast-xml-parser");

const SHOPIFY_API_VERSION = "2026-07";

function clean(v) {
  return String(v ?? "").trim();
}

function norm(v) {
  return clean(v)
    .toLowerCase()
    .replace(/\s+/g, " ");
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

  if (
    b === "ppl" ||
    b.includes("precision performance labs") ||
    b === "hiro" ||
    b === "kmt"
  ) {
    return "protected-brand";
  }

  if (
    b === "barebells" ||
    b === "natures aid"
  ) {
    return "excluded-brand";
  }

  if (
    /\bnicotine\b/.test(t) ||
    /\bvapes?\b/.test(t) ||
    /\bvaping\b/.test(t) ||
    /\be[\s-]?cig(?:arette)?s?\b/.test(t)
  ) {
    return "nicotine-vape";
  }

  if (
    /\b(alcohol|beer|wine|cider)\b/.test(t)
  ) {
    return "alcohol";
  }

  return "";
}

function ordinaryExcluded(r) {
  const b = norm(r.Brand);
  const n = norm(r.TranslationName);
  const c = norm(r.FilterByCategory);
  const t = `${b} ${n} ${c}`;

  const singleServing =
    /\b(single[\s-]?serv(e|ing)?|single[\s-]?portion|sample|sample[\s-]?pack|sachet)\b/i.test(
      t
    );

  const multipack =
    /\b\d+\s*[xX×]\s*\d+(?:\.\d+)?\s*(?:g|kg|ml|l)\b/i.test(
      t
    ) ||
    /\b\d+\s*(?:pack|pk|sachets|servings)\b/i.test(
      t
    );

  if (
    singleServing &&
    !multipack
  ) {
    return "single-serving";
  }

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
    if (t.includes(x)) {
      return x;
    }
  }

  /*
  Word boundaries prevent a flavour
  such as Watermelon being blocked.
  */
  if (/\bwater\b/.test(t)) {
    return "water";
  }

  /*
  Olimp allowed, capsules excluded.
  */
  if (
    /\bolimp(?:\s+sport(?:\s+nutrition)?)?\b/.test(
      b
    ) &&
    /\bcaps?(?:ule)?s?\b/.test(t)
  ) {
    return "olimp-capsules";
  }

  /*
  Clothing excluded.
  Accessories and shakers remain allowed.
  */
  if (
    /\b(t[\s-]?shirt|tee|hoodie|sweatshirt|joggers|leggings|shorts|vest|sports[\s-]?bra|tracksuit|clothing|apparel)\b/.test(
      t
    )
  ) {
    return "clothing";
  }

  if (
    /\b(sauce|sauces|syrup|syrups)\b/.test(
      t
    )
  ) {
    return "sauce/syrup";
  }

  if (/\bwipes\b/.test(t)) {
    return "wipes";
  }

  if (
    /\b(chips|crisps)\b/.test(t)
  ) {
    return "chips/crisps";
  }

  if (
    t.includes("cereal bar")
  ) {
    return "cereal-bar";
  }

  if (
    t.includes("single serving") ||
    t.includes("single sachet") ||
    t.includes("1 sachet") ||
    t.includes("1x sachet")
  ) {
    return "single-serving";
  }

  return "";
}

function extractRows(parsed) {
  const rows = [];

  function walk(x) {
    if (
      !x ||
      typeof x !== "object"
    ) {
      return;
    }

    if (
      !Array.isArray(x) &&
      Object.prototype.hasOwnProperty.call(
        x,
        "ProductCode"
      ) &&
      Object.prototype.hasOwnProperty.call(
        x,
        "TranslationName"
      )
    ) {
      rows.push(x);
    }

    for (
      const v
      of Object.values(x)
    ) {
      if (Array.isArray(v)) {
        for (const item of v) {
          walk(item);
        }
      } else if (
        v &&
        typeof v === "object"
      ) {
        walk(v);
      }
    }
  }

  walk(parsed);

  return rows;
}

function identity(r) {
  return JSON.stringify({
    ProductCode:
      clean(r.ProductCode),

    TranslationName:
      clean(r.TranslationName),

    Barcode:
      clean(r.Barcode),

    Brand:
      clean(r.Brand),

    Flavour:
      clean(r.Flavour),

    Size:
      clean(r.Size),

    ProductPrice:
      clean(r.ProductPrice)
  });
}

/*
Only group rows when:
- flavour exists
- flavour is at END of TranslationName
- brand matches
- base title matches
- exact size matches
- category matches
*/
function familyInfo(r) {
  const title =
    clean(r.TranslationName);

  const flavour =
    clean(r.Flavour);

  const size =
    clean(r.Size);

  const brand =
    clean(r.Brand);

  const category =
    clean(r.FilterByCategory);

  if (!flavour) {
    return {
      key:
        `single:${clean(
          r.ProductCode
        )}`,

      title,

      optionName:
        size
          ? "Size"
          : "Title",

      optionValue:
        size || "Default",

      groupable:
        false
    };
  }

  const esc =
    flavour.replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&"
    );

  const endFlavour =
    new RegExp(
      `\\s+${esc}\\s*$`,
      "i"
    );

  if (
    !endFlavour.test(title)
  ) {
    return {
      key:
        `single:${clean(
          r.ProductCode
        )}`,

      title,

      optionName:
        "Flavour",

      optionValue:
        flavour,

      groupable:
        false
    };
  }

  const baseTitle =
    title
      .replace(
        endFlavour,
        ""
      )
      .trim();

  return {
    key:
      `family:${norm(brand)}|` +
      `${norm(baseTitle)}|` +
      `${norm(size)}|` +
      `${norm(category)}`,

    title:
      baseTitle,

    optionName:
      "Flavour",

    optionValue:
      flavour,

    groupable:
      true
  };
}

async function loadFeed() {
  const required = [
    "TROPICANA_SFTP_USER",
    "TROPICANA_SFTP_PASSWORD"
  ];

  for (const k of required) {
    if (!process.env[k]) {
      throw new Error(
        `Missing ${k}`
      );
    }
  }

  const sftp =
    new SFTP();

  try {
    await sftp.connect({
      host:
        process.env
          .TROPICANA_SFTP_HOST ||
        "tropicana.ftp.redtechnology.com",

      port:
        Number(
          process.env
            .TROPICANA_SFTP_PORT ||
          22
        ),

      username:
        process.env
          .TROPICANA_SFTP_USER,

      password:
        process.env
          .TROPICANA_SFTP_PASSWORD
    });

    console.log(
      "TROPICANA_LOGIN_OK"
    );

    const file =
      process.env
        .TROPICANA_SFTP_FILE ||
      "DropshipProductFeed.xml";

    const xml =
      await sftp.get(file);

    console.log(
      `FEED_DOWNLOAD_OK bytes=${xml.length}`
    );

    const parsed =
      new XMLParser({
        ignoreAttributes:
          false,

        trimValues:
          true
      }).parse(
        xml.toString("utf8")
      );

    console.log(
      "FEED_XML_PARSE_OK"
    );

    return extractRows(
      parsed
    );
  } finally {
    try {
      await sftp.end();
    } catch (_) {
      /*
      Ignore disconnect error.
      */
    }
  }
}

async function shopifyAuth() {
  const domain =
    clean(
      process.env
        .SHOPIFY_STORE_DOMAIN
    )
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /\/$/,
        ""
      );

  const clientId =
    process.env
      .SHOPIFY_CLIENT_ID;

  const clientSecret =
    process.env
      .SHOPIFY_CLIENT_SECRET;

  if (
    !domain ||
    !clientId ||
    !clientSecret
  ) {
    throw new Error(
      "Missing Shopify credentials"
    );
  }

  const res =
    await fetch(
      `https://${domain}/admin/oauth/access_token`,
      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            client_id:
              clientId,

            client_secret:
              clientSecret,

            grant_type:
              "client_credentials"
          })
      }
    );

  if (!res.ok) {
    throw new Error(
      `Shopify auth failed HTTP ${res.status}`
    );
  }

  const json =
    await res.json();

  if (
    !json.access_token
  ) {
    throw new Error(
      "Shopify auth returned no access token"
    );
  }

  return {
    domain,
    token:
      json.access_token
  };
}

async function gql(
  auth,
  query,
  variables = {}
) {
  const res =
    await fetch(
      `https://${auth.domain}` +
        `/admin/api/` +
        `${SHOPIFY_API_VERSION}` +
        `/graphql.json`,

      {
        method:
          "POST",

        headers: {
          "Content-Type":
            "application/json",

          "X-Shopify-Access-Token":
            auth.token
        },

        body:
          JSON.stringify({
            query,
            variables
          })
      }
    );

  const json =
    await res.json();

  if (!res.ok) {
    throw new Error(
      `Shopify GraphQL HTTP ${res.status}`
    );
  }

  if (
    json.errors?.length
  ) {
    throw new Error(
      `Shopify GraphQL: ` +
        `${JSON.stringify(
          json.errors
        )}`
    );
  }

  return json.data;
}

function searchEscape(v) {
  return clean(v)
    .replace(
      /\\/g,
      "\\\\"
    )
    .replace(
      /"/g,
      '\\"'
    );
}

async function exactSkuMatches(
  auth,
  sku
) {
  const query = `
    query ExactSku(
      $query: String!
    ) {
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

  const data =
    await gql(
      auth,
      query,
      {
        query:
          `sku:"${searchEscape(
            sku
          )}"`
      }
    );

  return (
    data
      .productVariants
      .nodes || []
  ).filter(
    v =>
      clean(v.sku) ===
      sku
  );
}

async function exactBarcodeMatches(
  auth,
  barcode
) {
  if (
    !clean(barcode)
  ) {
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

  const data =
    await gql(
      auth,
      query,
      {
        query:
          `barcode:"${searchEscape(
            barcode
          )}"`
      }
    );

  return (
    data
      .productVariants
      .nodes || []
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
  const existing = [];
  const missing = [];

  for (
    const item
    of family.items
  ) {
    const sku =
      clean(
        item.row
          .ProductCode
      );

    const barcode =
      clean(
        item.row.Barcode
      );

    const skuMatches =
      await exactSkuMatches(
        auth,
        sku
      );

    if (
      skuMatches.length > 1
    ) {
      return {
        ok:
          false,

        reason:
          `duplicate-shopify-sku:${sku}`,

        existing,
        missing
      };
    }

    if (
      skuMatches.length === 1
    ) {
      const match =
        skuMatches[0];

      if (
        barcode &&
        clean(
          match.barcode
        ) &&
        clean(
          match.barcode
        ) !== barcode
      ) {
        return {
          ok:
            false,

          reason:
            `existing-sku-barcode-mismatch:${sku}`,

          existing,
          missing
        };
      }

      existing.push({
        item,
        match
      });

      continue;
    }

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
          ok:
            false,

          reason:
            `barcode-collision:` +
            `${barcode}:` +
            barcodeMatches
              .map(
                x =>
                  clean(
                    x.sku
                  )
              )
              .join(","),

          existing,
          missing
        };
      }
    }

    missing.push(
      item
    );
  }

  if (
    existing.length ===
    family.items.length
  ) {
    return {
      ok:
        true,

      mode:
        "ALL_EXISTING",

      existing,
      missing
    };
  }

  if (
    existing.length === 0
  ) {
    return {
      ok:
        true,

      mode:
        "ALL_NEW",

      existing,
      missing
    };
  }

  return {
    ok:
      true,

    mode:
      "PARTIAL_EXISTING",

    existing,
    missing
  };
}

function resolveExistingParent(
  preflight
) {
  const productIds = [
    ...new Set(
      preflight
        .existing
        .map(
          x =>
            clean(
              x.match
                ?.product
                ?.id
            )
        )
        .filter(Boolean)
    )
  ];

  if (
    preflight.mode ===
    "ALL_NEW"
  ) {
    return {
      ok:
        true,

      productId:
        null,

      productIds:
        []
    };
  }

  if (
    productIds.length !== 1
  ) {
    return {
      ok:
        false,

      reason:
        `ambiguous-existing-parent:` +
        productIds.join(","),

      productIds
    };
  }

  return {
    ok:
      true,

    productId:
      productIds[0],

    productIds
  };
}

async function createDraftFamily(
  auth,
  family
) {
  if (
    !family.items.length
  ) {
    throw new Error(
      "EMPTY_FAMILY"
    );
  }

  /*
  Re-check immediately before
  any write.
  */
  const finalCheck =
    await preflightFamily(
      auth,
      family
    );

  if (!finalCheck.ok) {
    return {
      action:
        "SKIPPED_COLLISION_OR_UNSAFE",

      reason:
        finalCheck.reason,

      createdSkus:
        []
    };
  }

  const parentCheck =
    resolveExistingParent(
      finalCheck
    );

  /*
  IMPORTANT CHANGE:

  Old split families are cleanup
  work.

  They must NOT stop the full
  catalogue reconciliation and
  must NOT create another duplicate.
  */
  if (!parentCheck.ok) {
    return {
      action:
        "SKIPPED_SPLIT_PARENT",

      reason:
        parentCheck.reason,

      productIds:
        parentCheck.productIds,

      createdSkus:
        []
    };
  }

  if (
    finalCheck.mode ===
    "ALL_EXISTING"
  ) {
    return {
      action:
        "SKIPPED_ALL_EXISTING",

      createdSkus:
        [],

      productId:
        parentCheck.productId
    };
  }

  const brand =
    clean(
      family.items[0]
        .row.Brand
    ) || "Unknown";

  const optionName =
    family.optionName;

  /*
  PARTIAL EXISTING FAMILY
  */
  if (
    finalCheck.mode ===
    "PARTIAL_EXISTING"
  ) {
    const missingItems =
      finalCheck.missing;

    if (
      !parentCheck.productId
    ) {
      throw new Error(
        "PARTIAL_EXISTING_WITHOUT_PARENT"
      );
    }

    if (
      !missingItems.length
    ) {
      throw new Error(
        "PARTIAL_EXISTING_WITHOUT_MISSING_ITEMS"
      );
    }

    const missingVariants =
      [];

    for (
      const item
      of missingItems
    ) {
      const r =
        item.row;

      const sku =
        clean(
          r.ProductCode
        );

      const barcode =
        clean(
          r.Barcode
        );

      const net =
        num(
          r.ProductPrice
        );

      const value =
        clean(
          item.optionValue
        );

      if (
        !sku ||
        !(net > 0) ||
        !value
      ) {
        throw new Error(
          `UNSAFE_MISSING_VARIANT ${sku}`
        );
      }

      missingVariants.push({
        optionValues: [
          {
            optionName,
            name:
              value
          }
        ],

        inventoryItem: {
          sku
        },

        barcode:
          barcode ||
          null,

        price:
          String(
            pricing(
              net
            ).retail
          ),

        taxable:
          false
      });
    }

    const partialMutation = `
      mutation AddMissingVariants(
        $productId: ID!,
        $variants: [ProductVariantsBulkInput!]!
      ) {
        productVariantsBulkCreate(
          productId: $productId,
          variants: $variants,
          strategy: REMOVE_STANDALONE_VARIANT
        ) {
          productVariants {
            id
            sku
            barcode
            price
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    const partialResult =
      await gql(
        auth,
        partialMutation,
        {
          productId:
            parentCheck
              .productId,

          variants:
            missingVariants
        }
      );

    const payload =
      partialResult
        ?.productVariantsBulkCreate;

    const errors =
      payload
        ?.userErrors ||
      [];

    if (
      errors.length
    ) {
      const optionMismatch =
        errors.some(
          e =>
            clean(
              e.message
            ) ===
            "Option does not exist"
        );

      if (
        optionMismatch
      ) {
        return {
          action:
            "SKIPPED_OPTION_MISMATCH",

          reason:
            JSON.stringify(
              errors
            ),

          productId:
            parentCheck
              .productId,

          createdSkus:
            []
        };
      }

      throw new Error(
        `PARTIAL_VARIANT_WRITE_FAILED ` +
          `${JSON.stringify(
            errors
          )}`
      );
    }

    const created =
      payload
        ?.productVariants ||
      [];

    if (
      created.length !==
      missingVariants.length
    ) {
      throw new Error(
        `PARTIAL_VARIANT_COUNT_MISMATCH ` +
          `expected=${missingVariants.length} ` +
          `created=${created.length}`
      );
    }

    /*
    Verify every new SKU.
    */
    for (
      const item
      of missingItems
    ) {
      const sku =
        clean(
          item.row
            .ProductCode
        );

      const matches =
        await exactSkuMatches(
          auth,
          sku
        );

      if (
        matches.length !== 1
      ) {
        throw new Error(
          `PARTIAL_VERIFY_SKU_COUNT ` +
            `${sku}:${matches.length}`
        );
      }

      if (
        clean(
          matches[0]
            ?.product
            ?.id
        ) !==
        parentCheck
          .productId
      ) {
        throw new Error(
          `PARTIAL_VERIFY_WRONG_PARENT ${sku}`
        );
      }

      const supplierBarcode =
        clean(
          item.row
            .Barcode
        );

      if (
        supplierBarcode &&
        clean(
          matches[0]
            .barcode
        ) !==
        supplierBarcode
      ) {
        throw new Error(
          `PARTIAL_VERIFY_BARCODE_FAILED ${sku}`
        );
      }
    }

    return {
      action:
        "ADDED_MISSING_VARIANTS",

      productId:
        parentCheck.productId,

      createdSkus:
        missingItems.map(
          item =>
            clean(
              item.row
                .ProductCode
            )
        )
    };
  }

  /*
  ALL NEW FAMILY

  Create one DRAFT product only.
  */
  const seenOptions =
    new Set();

  const variants =
    [];

  const optionValues =
    [];

  for (
    const item
    of family.items
  ) {
    const r =
      item.row;

    const sku =
      clean(
        r.ProductCode
      );

    const barcode =
      clean(
        r.Barcode
      );

    const net =
      num(
        r.ProductPrice
      );

    const value =
      clean(
        item.optionValue
      ) ||
      "Default";

    if (
      !sku ||
      net === null ||
      net <= 0
    ) {
      throw new Error(
        `UNSAFE_VARIANT ${sku}`
      );
    }

    const normalizedValue =
      norm(value);

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
      name:
        value
    });

    variants.push({
      optionValues: [
        {
          optionName,
          name:
            value
        }
      ],

      sku,

      barcode:
        barcode ||
        null,

      price:
        String(
          pricing(
            net
          ).retail
        ),

      taxable:
        false
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

    /*
    Internal PPL tags only.
    Supplier name is NOT added.
    */
    tags: [
      "PPL controlled import",
      "PPL V3 family import"
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
      {
        input
      }
    );

  const result =
    data.productSet;

  if (
    result
      .userErrors
      ?.length
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
    product.status !==
      "DRAFT"
  ) {
    throw new Error(
      "POST_CREATE_PRODUCT_VERIFY_FAILED"
    );
  }

  const createdVariants =
    product
      .variants
      ?.nodes ||
    [];

  /*
  Verify every created variant.
  */
  for (
    const item
    of family.items
  ) {
    const sku =
      clean(
        item.row
          .ProductCode
      );

    const barcode =
      clean(
        item.row
          .Barcode
      );

    const matches =
      createdVariants.filter(
        v =>
          clean(
            v.sku
          ) ===
          sku
      );

    if (
      matches.length !== 1
    ) {
      throw new Error(
        `POST_CREATE_VARIANT_VERIFY_FAILED ${sku}`
      );
    }

    if (
      clean(
        matches[0]
          .barcode
      ) !==
      barcode
    ) {
      throw new Error(
        `POST_CREATE_BARCODE_VERIFY_FAILED ${sku}`
      );
    }
  }

  /*
  Independent Shopify verification.
  */
  for (
    const item
    of family.items
  ) {
    const sku =
      clean(
        item.row
          .ProductCode
      );

    const after =
      await exactSkuMatches(
        auth,
        sku
      );

    if (
      after.length !== 1 ||
      after[0]
        .product
        .id !==
        product.id ||
      after[0]
        .product
        .status !==
        "DRAFT"
    ) {
      throw new Error(
        `FINAL_EXACT_SKU_VERIFY_FAILED ${sku}`
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
          family.items
            .length,

        skus:
          family.items.map(
            x =>
              clean(
                x.row
                  .ProductCode
              )
          )
      })}`
  );

  return {
    action:
      "CREATED_NEW_FAMILY",

    productId:
      product.id,

    createdSkus:
      family.items.map(
        item =>
          clean(
            item.row
              .ProductCode
          )
      )
  };
}

async function main() {
  console.log(
    "BUILD_MARKER " +
      "PPL-CATALOGUE-WRITER-V3-FULL-SPLIT-SKIP"
  );

  console.log(
    "MODE=" +
      "FULL_ELIGIBLE_CATALOGUE_RECONCILIATION_DRAFT_ONLY"
  );

  console.log(
    "SKU_LIMIT=NONE"
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
  Group duplicate XML rows by SKU.
  */
  const bySku =
    new Map();

  for (const r of rows) {
    const sku =
      clean(
        r.ProductCode
      );

    if (!sku) {
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
      .push(r);
  }

  /*
  Retain only consistent duplicates.
  */
  const safe =
    new Map();

  let conflicts = 0;

  for (
    const [
      sku,
      group
    ]
    of bySku
  ) {
    const ids =
      new Set(
        group.map(
          identity
        )
      );

    if (
      ids.size !== 1
    ) {
      conflicts++;
      continue;
    }

    safe.set(
      sku,
      group[0]
    );
  }

  console.log(
    `UNIQUE_PRODUCT_CODES=${bySku.size}`
  );

  console.log(
    `CONFLICTING_DUPLICATES_SKIPPED=${conflicts}`
  );

  const candidates =
    [];

  let hardBlockedCount =
    0;

  let ordinaryExcludedCount =
    0;

  let invalidPriceCount =
    0;

  for (
    const [
      sku,
      r
    ]
    of safe
  ) {
    const hard =
      hardBlocked(r);

    if (hard) {
      hardBlockedCount++;

      console.log(
        `HARD_BLOCK ` +
          `${sku} ${hard}`
      );

      continue;
    }

    const excluded =
      ordinaryExcluded(r);

    if (excluded) {
      ordinaryExcludedCount++;

      console.log(
        `EXCLUDED ` +
          `${sku} ${excluded}`
      );

      continue;
    }

    const net =
      num(
        r.ProductPrice
      );

    if (
      net === null ||
      net <= 0
    ) {
      invalidPriceCount++;
      continue;
    }

    candidates.push(r);
  }

  console.log(
    `HARD_BLOCKED=${hardBlockedCount}`
  );

  console.log(
    `ORDINARY_EXCLUDED=${ordinaryExcludedCount}`
  );

  console.log(
    `INVALID_PRICE_SKIPPED=${invalidPriceCount}`
  );

  console.log(
    `SAFE_FEED_CANDIDATES=${candidates.length}`
  );

  /*
  Build conservative product families.
  */
  const familyMap =
    new Map();

  for (
    const r
    of candidates
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

          items:
            []
        }
      );
    }

    familyMap
      .get(
        info.key
      )
      .items
      .push({
        row:
          r,

        optionValue:
          info.optionValue
      });
  }

  const families =
    [
      ...familyMap.values()
    ];

  console.log(
    `SAFE_FAMILIES=${families.length}`
  );

  console.log(
    `MULTI_VARIANT_FAMILIES=` +
      `${
        families.filter(
          f =>
            f.items.length >
            1
        ).length
      }`
  );

  const auth =
    await shopifyAuth();

  let createdSkus =
    0;

  let createdProducts =
    0;

  let completedExistingFamilies =
    0;

  let skippedCollisionFamily =
    0;

  let skippedSplitParent =
    0;

  let skippedOptionMismatch =
    0;

  let failed =
    0;

  for (
    const family
    of families
  ) {
    try {
      const result =
        await createDraftFamily(
          auth,
          family
        );

      const writtenSkus =
        Array.isArray(
          result
            ?.createdSkus
        )
          ? result
              .createdSkus
          : [];

      createdSkus +=
        writtenSkus.length;

      if (
        result?.action ===
        "CREATED_NEW_FAMILY"
      ) {
        createdProducts++;
        continue;
      }

      if (
        result?.action ===
        "ADDED_MISSING_VARIANTS"
      ) {
        console.log(
          `MISSING_VARIANTS_ADDED ` +
            `family=${family.title} ` +
            `product=${result.productId} ` +
            `skus=${writtenSkus.join(",")}`
        );

        continue;
      }

      if (
        result?.action ===
        "SKIPPED_ALL_EXISTING"
      ) {
        completedExistingFamilies++;

        console.log(
          `FAMILY_ALREADY_COMPLETE ` +
            `family=${family.title}`
        );

        continue;
      }

      if (
        result?.action ===
        "SKIPPED_COLLISION_OR_UNSAFE"
      ) {
        skippedCollisionFamily++;

        console.log(
          `SKIP_FAMILY ` +
            `family=${family.title} ` +
            `reason=${result.reason}`
        );

        continue;
      }

      if (
        result?.action ===
        "SKIPPED_SPLIT_PARENT"
      ) {
        skippedSplitParent++;

        console.log(
          `SKIP_SPLIT_PARENT ` +
            `family=${family.title} ` +
            `reason=${result.reason}`
        );

        continue;
      }

      if (
        result?.action ===
        "SKIPPED_OPTION_MISMATCH"
      ) {
        skippedOptionMismatch++;

        console.log(
          `SKIP_OPTION_MISMATCH ` +
            `family=${family.title} ` +
            `error=${result.reason}`
        );

        continue;
      }

      throw new Error(
        `UNKNOWN_WRITE_RESULT ` +
          `${JSON.stringify(
            result
          )}`
      );
    } catch (err) {
      const errorMessage =
        err?.message ||
        String(err);

      failed++;

      console.error(
        `WRITE_FAILED ` +
          `family=${family.title} ` +
          `error=${errorMessage}`
      );

      console.error(
        "FAIL_CLOSED_STOPPING_RUN"
      );

      break;
    }
  }

  console.log(
    "CONTROLLED_V3_WRITE_COMPLETE"
  );

  console.log(
    `DRAFT_PRODUCTS_CREATED_VERIFIED=${createdProducts}`
  );

  console.log(
    `SKUS_CREATED_VERIFIED=${createdSkus}`
  );

  console.log(
    `EXISTING_FAMILIES_COMPLETE=${completedExistingFamilies}`
  );

  console.log(
    `COLLISION_OR_UNSAFE_FAMILIES_SKIPPED=${skippedCollisionFamily}`
  );

  console.log(
    `SPLIT_PARENT_FAMILIES_SKIPPED=${skippedSplitParent}`
  );

  console.log(
    `OPTION_MISMATCH_FAMILIES_SKIPPED=${skippedOptionMismatch}`
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
}

main()
  .catch(
    err => {
      console.error(
        "FATAL",
        err?.stack ||
          err
      );

      process.exit(1);
    }
  );
