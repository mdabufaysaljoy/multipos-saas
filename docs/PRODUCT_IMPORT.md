# Bulk product import (Clothing POS)

Scope: **Clothing POS only.** Restaurant, Pharmacy and Super Shop are untouched.

Availability: **every subscription plan — Starter, Professional and Enterprise.** Import is how a shop
gets its catalogue in; it is not a paid upgrade. It is deliberately **separate from Data export**, which
stays Professional and above (`docs/DATA_EXPORT.md`).

---

## 1. Audit — what it was built on

| Area | Finding |
|---|---|
| Product export | `export.datasets.ts` → dataset `products`, one row per **variant**, columns: Product, Brand, Category, Variant, Attributes, SKU, Barcode, Cost price, Selling price, Stock, Active. **No ids are exported.** |
| Product model | `Product` (name, base `sku`, `categoryId` + `categoryNameSnapshot`, description, `brand` **free text**, images, `options[]`, `hasVariants`, `isActive`) |
| Variant model | `ProductVariant` (name, `attributes[{name,value}]`, `sku`, `barcode`, `sellingPriceMinor`, `costPriceMinor`, `stock`, `lowStockThreshold`, `isActive`) |
| Uniqueness | variant SKU unique per branch; product base SKU unique per branch; **barcode unique per branch** among live variants (partial indexes, `deletedAt: null`) |
| Creation logic | `productService.create()` — plan product limit, SKU generation, barcode checks, category resolution, opening-stock ledger entry, one transaction per product, limit-race rollback |
| Stock | opening balances go through `inventoryService.recordInitialStock` (an `INITIAL_STOCK` ledger row), never a raw field write |
| Brand | a string on the product — there is **no Brand collection**, so no cross-workspace brand reference is possible |
| Categories | `Category` per branch, unique by slug; the manual product form picks an EXISTING category and never creates one |
| VAT / unit / status | VAT is a **store** setting (`store.tax`), there is no per-product tax or unit field. Product state is `isActive` only |
| Images | product images are uploaded files with storage quota accounting; the export does not include them |
| Queue / worker | none in this stack (no Redis, no worker) |
| Upload handling | `multer` memory storage with a size limit and a type allow-list (`uploads.routes.ts`) |

---

## 2. Export → import compatibility

```
Data export  →  products-2026-09-23.xlsx / .csv  →  edit prices, stock, barcodes  →  Import products
```

The import reads the export's own file as-is:

- the export's **title block** (workspace, dataset, generated-at, filters, blank line) is skipped — the
  header row is found by looking for the row that names the most known columns (first 20 rows);
- the export's headers **are** the import headers (`Product`, `Variant`, `Selling price`, …);
- the export's spreadsheet-injection guard is undone: a cell written as `'=1+1` is imported as the text
  `=1+1` (only a leading apostrophe before `= + - @` tab CR is removed), and exporting it again
  neutralises it again;
- CSV is parsed with a real parser (ExcelJS/fast-csv): UTF-8 with or without BOM, quoted values, commas
  and newlines inside fields, Bengali and other Unicode.

---

## 3. Columns

| Column (header) | Required | Maps to | Notes |
|---|---|---|---|
| `Product` | **yes** | `product.name` | Rows with the same name (case-insensitive) become ONE product |
| `Variant` | **yes** | `variant.name` | e.g. `Black / M`, or `Default` for a single-variant product |
| `Selling price` | **yes** | `variant.sellingPriceMinor` | Parsed to minor units with string arithmetic - never `parseFloat * 100` |
| `Cost price` | no | `variant.costPriceMinor` | Defaults to 0 |
| `SKU` | no | `variant.sku` | Uppercased; `A-Z 0-9 . _ -`; generated when blank |
| `Barcode` | no | `variant.barcode` | Stays blank when blank; generate one later from the product page |
| `Category` | no | `product.categoryId` + snapshot | Matched by name within THIS branch |
| `Brand` | no | `product.brand` | Free text |
| `Attributes` | no | `variant.attributes[]` | The export format: `Color: Black; Size: M` |
| `Stock` | no | opening stock | Whole number; recorded as an inventory movement |
| `Low stock threshold` | no | `variant.lowStockThreshold` | Defaults to 0 |
| `Description` | no | `product.description` | |
| `Active` | no | `isActive` | `Yes/No`, `Active/Inactive`, `true/false`, `1/0`; defaults to Yes |

Accepted aliases (documented, never guessed by similarity): `Product name`, `Name`, `Price`,
`Purchase price`, `Cost`, `Quantity`, `Qty`, `EAN`, `UPC`, `Status`, … Header matching ignores case,
surrounding spaces and a BOM. `Price`, `Cost price` and `Selling price` are three distinct things and are
never merged; **two columns mapping to the same field abort the import** rather than picking one.

**Ignored columns** (present in some sheets, never trusted): `Product ID`, `Variant ID`, `ID`,
`Tenant ID`, `Workspace ID`, `Store ID`, `Branch ID`, `Category ID`, `Brand ID`, `Supplier ID`,
`Created`, `Updated`. They do not make a file invalid and they never reach the database.

**Not importable:** VAT/tax and unit (store-level settings, not product fields), images (see §8),
suppliers, purchases and expenses (no such models).

---

## 4. Rows → products

```
T-Shirt | Black / M | 990          T-Shirt
T-Shirt | Black / L | 990    →      ├── Black / M
T-Shirt | White / M | 990           ├── Black / L
                                    └── White / M
```

- Grouping is by product name, case-insensitively, **not** by row position.
- Product-level fields (brand, category, description, active) come from the group's FIRST row. A later
  row of the same product that disagrees is reported as an error rather than silently overwriting.
- `Attributes` become the product's `options[]` (`Color: [Black, White]`, `Size: [M, L]`) and set
  `hasVariants`, exactly as the manual form does. At most 3 option types and 50 values each.
- A variant name repeated inside one product is an error.

---

## 5. Create, never update

Import **creates**. It never updates or overwrites an existing product, and there is no upsert mode:

- a product whose name already exists in the branch is reported as an error (`already exists`);
- a SKU or barcode that already exists in the branch is reported as an error;
- a SKU or barcode repeated inside the file is reported as an error;
- database ids in the file are ignored, so re-importing an exported file into the SAME workspace is
  refused per row by the name check rather than quietly rewriting products.

New products get NEW ids. Business identifiers (SKU, barcode) are preserved where they are valid and free.

---

## 6. Categories and brands

**Category:** matched by name (slug) inside the caller's branch.

- Default: an unknown category is a **row error** — the same rule the New product form follows, which
  only offers existing categories.
- Optional, explicit: ticking **"Create categories that do not exist yet"** creates them through the
  ordinary `categoryService.create()` in the caller's branch. Never silent, never automatic.

**Brand:** free text on the product; nothing is looked up, so no cross-workspace reference exists.

A category id from a file is never used, so a category belonging to another workspace can never be
attached.

---

## 7. Two steps: preview, then confirm

```
POST /api/products/import/preview   (multipart file)   → validate, store the plan, create NOTHING
POST /api/products/import/:id/commit                    → create the products
```

The preview reports total / valid / invalid rows, products and variants to create, categories to create,
the mapped columns and the row errors (with the **file's own row numbers**).

**Partial import is explicit.** A file with invalid rows is refused (`400`, `details.reason =
INVALID_ROWS`) unless the caller confirms `skipInvalidRows: true` — which is what the page's
"Import N valid rows" button sends. Nothing is imported by accident.

**Atomicity.** Each product (with all its variants and their opening-stock ledger entries) is created in
one `withTransaction` unit, so a half-built product cannot be left behind. Products are separate units:
if the 40th product fails, the first 39 exist and the summary says exactly which failed and why. Hitting
the plan's product limit stops the run immediately (everything after it would fail identically) and the
reason is reported once.

A pending preview expires after 60 minutes (TTL index) or when cancelled; its stored plan is dropped as
soon as it is committed.

---

## 8. Limits and security

| Control | Value / how |
|---|---|
| Formats | `.xlsx` and `.csv` only — extension **and** content type checked. `.xlsm` is refused; nothing in a workbook is executed, only cell values are read (a formula cell yields its stored result) |
| File size | 5 MB (multer, in memory - the upload is never written to disk) |
| Rows | 2,000 product rows per file; a larger file is refused with the limit and the advice to split it |
| Rate limit | 5 imports per minute per user, plus the global API limiter |
| Entitlement | `productImport` — its own plan flag, on for every plan; **never** `dataExport` |
| Permission | `products.import` (new). Being able to create one product is not being able to import thousands |
| Tenant isolation | `tenantId`, `storeId` and `userId` come from the session; the file cannot carry them |
| Branch isolation | The import writes into the caller's current branch only; a branch the caller cannot reach is a 403 before any parsing |
| No arbitrary ids | Id columns are dropped by the parser; categories are resolved by name inside the branch |
| Business rules | Every product goes through `createProductSchema` and then `productService.create` - the same validation, SKU, barcode, category and inventory rules as the New product form |
| Money | `parseMajorToMinor` (string arithmetic, integer minor units) |
| Injection | Imported values are stored as plain data; the export re-neutralises anything a spreadsheet could execute |
| Images | **Not imported.** No URL from a spreadsheet is ever fetched (that would be an SSRF hole). Add photos from the product page |
| History | `ProductImportJob`: filename, counts, status, who, when. The uploaded file is never stored |
| Audit | `products.imported` with counts only |

---

## 9. After the import

Imported products are ordinary products: they appear in the catalogue and the POS grid, they are found
by SKU and barcode search, they sell, they return and exchange, their stock is ledgered from the opening
balance, and their labels and receipts print like any other product. Nothing about them is special-cased.

---

## 10. API

| Route | Purpose |
|---|---|
| `GET /api/products/import/columns` | The column contract and the limits, as the page documents them |
| `POST /api/products/import/preview` | multipart `file` + `createMissingCategories`; validates and returns the preview |
| `POST /api/products/import/:id/commit` | `{ skipInvalidRows }`; creates the products |
| `POST /api/products/import/:id/cancel` | Discards an unconfirmed preview |
| `GET /api/products/import` | Import history (paginated) |

All of them: authenticated → workspace + branch → Clothing → usable subscription → `productImport`
entitlement → `products.import` permission.

---

## 11. Rollout

`npm run migrate:product-import -w server` (also part of `npm run migrate`; idempotent):

1. sets `features.productImport: true` on plans that predate the flag;
2. backfills the same on subscription snapshots;
3. grants `products.import` to existing built-in **Store Manager** roles, once (never re-granting a
   permission an admin has removed).

Before it runs nobody is locked out: a missing `productImport` in a snapshot resolves to **on** (see
`entitlement.service.ts`), because import is part of every plan. A plan that explicitly stores `false` is
still refused, so the flag stays genuinely enforceable.

---

## 12. Limitations

- **Create only.** No update/upsert mode, by design (see §5).
- **No background queue.** Imports run in the request, bounded by the row cap; there is no queue in this
  stack to reuse.
- **No image import**, deliberately (SSRF).
- **No supplier, purchase, expense or VAT columns** — those models/fields do not exist.
- **Duplicate detection is by exact product name** (case-insensitive) within the branch; two genuinely
  different products that share a name cannot both be imported.
- A file over 2,000 rows must be split.

---

## Import in the other three POS types (task 11)

Scope changed: import is no longer Clothing-only. Super Shop, Pharmacy and Restaurant import their
catalogues through the **same engine**, at `POST /api/<vertical>/imports/preview` and
`/imports/:id/commit`, with the same two steps — validate & preview writes nothing, confirm creates
each item through that vertical's **own create service**, so plan limits, name and barcode
uniqueness, the category list and the opening-stock ledger behave exactly as they do for an item
typed in by hand. Ownership never comes from the file: id columns are ignored, and tenant and branch
come from the authenticated context.

The entitlement `productImport` is now on every vertical, on every plan, for the same reason it was
always on every Clothing plan: import is how a catalogue gets in, not an upgrade.

### What is shared, and what is not

| Shared (`services/import/`) | Per vertical |
|---|---|
| `sheet.parse.ts` — finding the header row inside an export's title block, formula-guard unwrapping, duplicate-column refusal, the row ceiling | the **column registry** |
| `sheet.columns.ts` — header normalising, alias lookup, ignored/ownership columns | what a row *means* |
| `posImport.service.ts` — the pending job, the preview, the commit loop, per-row failures, the history | how an item is **created** |

Clothing's own module now uses the shared parser too; its columns (products **and** variants,
attributes, SKUs) stay where they were.

### The columns

- **Super Shop** — `Product`*, `Price`*, Barcode, Department, Brand, Sold by (Piece/Weight), VAT
  rate, Reorder level, Opening stock, Cost price, Active. Opening stock is received into the current
  branch as a movement, and needs a cost price — without one the shop could not report profit.
- **Pharmacy** — `Medicine`*, `Price`*, Generic name, Strength, Form, Manufacturer, Category,
  Barcode, Prescription, Reorder level, Batch, Expiry, Quantity, Cost price, Active. Opening stock
  is **all-or-nothing**: units must be attributable to a real, dated, unexpired batch, exactly as the
  Receive stock form insists, so a row with a batch but no expiry is an error rather than a silent
  medicine with no stock.
- **Restaurant** — `Dish`*, `Price`*, Section, Description, Order, Available.

(* required.)

A category the file names that the workspace does not have is created with the item, through the
shared catalogue (`docs/CATEGORIES.md`) — which is why task 11 waited for task 10. A hidden category
is refused, as it is everywhere else.

### Errors belong to rows

A row that cannot be imported is reported with its **line number in the uploaded file** and the
column at fault, and the file still imports if the user confirms "import the valid rows only". The
same name twice inside one file is caught at preview, pointing at the row that claimed it first; a
name that already exists in the catalogue fails as one row at commit, with the vertical's own
message ("A product with this name and brand already exists").
