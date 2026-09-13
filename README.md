# PPL Tropicana hourly stock sync

Runs at minute 0 every hour in Render (UTC).

Safeguards:

- Matches the Tropicana `ProductCode` to Shopify `SKU` exactly.
- Ignores products that do not occur in the supplier feed.
- Blocks duplicate supplier codes.
- Blocks zero or multiple active Shopify variants with the same SKU.
- Uses compare-and-set inventory writes.
- Reads inventory back after every changed quantity.
- Exits with an error if the supplier feed uses an unrecognised stock field.

Secrets are supplied only through the existing Render environment group
`ppl-tropicana-sync-secrets`; this repository contains no credentials.
