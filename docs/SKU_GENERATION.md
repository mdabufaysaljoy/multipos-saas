# SKU Generation (Clothing POS)

Scope: Clothing POS products and variants (`server/src/modules/products`). Super Shop, Pharmacy and
Restaurant have their own catalogues and are not affected.

## 1. Audit — before this change

| # | Item | Finding |
|---|---|---|
| 1 | Product model | `models/Product.ts`: `sku` (required, uppercase, max 64) is a *base/parent* code. |
| 2–3 | Variant model / SKU field | `models/ProductVariant.ts`: `sku` (required, trimmed, **uppercase setter**, **max 64**). |
| 4 | Validation | `products.validators.ts` `skuField`: optional, uppercased, 1–64 chars, `[A-Z0-9._-]`. |
| 5 | Unique indexes | Unique on `{tenantId, storeId, sku}` with `partialFilterExpression: { deletedAt: null }` on **both** products and variants. Verified present in the working database; 0 live duplicates; 0 lowercase SKUs. |
| 6 | Product create | `productService.create`. The base SKU came from `codeFromName(name, 6)`, e.g. `OVERSI`. |
| 7 | Product update | Keeps the SKU unless the request sends a different one; a clash threw "SKU … is already used". |
| 8 | Variant create | `addVariant`: `productSku-XXX-YY` from 3-letter attribute codes (`BLA-XL`), or `-STD` for a default variant. |
| 9 | Variant update | Keeps the SKU unless a new one is sent; a clash threw an error. |
| 10–11 | UI | `ProductFormDialog` has an optional **Base SKU** field; `VariantMatrixEditor` has an optional SKU per variant ("leave blank to generate"). The client blocked duplicate SKUs within one form. |
| 12 | Existing generation | Base: first 6 letters of the name, with a retry for the product only (`OVERSI`, `OVERSI2`…). Variant SKUs had **no conflict resolution**: a clash failed the whole save. |
| 13–15 | Barcode / search / POS scan | `barcode` is a **separate** field (EAN-13 generator, `200` range). POS search and scan match `barcode` or `sku`, so SKU format changes do not affect scanning by barcode. |
| 16 | Inventory | Variants by `_id`; the ledger stores an `skuSnapshot`. |
| 17 | Sales / returns / exchanges | Store `skuSnapshot` per line; reports read snapshots. History never depends on the current SKU. |
| 18 | Duplicate handling | Pre-check (`findOne`) then insert. It raced, and a clash was a user-facing 409. |
| 19 | Transactions | `withTransaction` (replica set only); a standalone server has no transaction, so a failure part-way needed a hard rollback. |

**Uniqueness scope (preserved): per branch, `tenantId + storeId`, live records only.** Two workspaces, or
two branches, may use the same SKU. A soft-deleted variant frees its SKU (existing index semantics).

## 2. The new behaviour

### Format

```
<PRODUCT NAME>-<VARIANT NAME>[-n]
OVERSIZED-GRAPHIC-TEE-BLACK-XL
OVERSIZED-GRAPHIC-TEE-BLACK-XL-2
```

- **Variant name:** the variant's attribute values joined (`Black / XL`), or its name. A product without
  options uses `DEFAULT` (`BASIC-T-SHIRT-DEFAULT`).
- **Product base SKU (`product.sku`):** the normalised product name (`OVERSIZED-GRAPHIC-TEE`), with the same suffix rule.

### Normalisation (`normalizeSkuComponent`)

1. Unicode NFKD, then diacritics are removed (`é` → `e`).
2. Uppercase; apostrophes are dropped (`MEN'S` → `MENS`).
3. Every other run of characters outside `A-Z0-9` becomes a single `-`, so `/ \ ? # % & * :`, spaces and
   `-` all become one dash.
4. Leading and trailing dashes are removed; numbers are kept (`AIR-JORDAN-2026-42`).
5. **Non-Latin text (e.g. Bangla):** no transliteration exists in the project, and none was added (no large
   dependency). If a component contained letters that could not be represented, a short deterministic
   5-character hash of the original text is appended, so `কালো XL` → `XL-K3F9Q` and `লাল XL` → `XL-8QD2M`.
   Different names stay distinguishable, and the same name always gives the same code.
   A component that is entirely non-Latin becomes just the hash (`টি-শার্ট` → `U7M2KX`), never empty.
6. An empty result (for example only punctuation) falls back to `ITEM` or `DEFAULT`, never `BASIC-T-SHIRT-`.

### Length (max 64, the model limit)

The base is capped at **57 characters**, leaving room for suffixes up to `-999999`.
- If product + variant is too long, the **product part is shortened first** (to no less than 16 characters),
  because the variant part is what tells sibling variants apart. The result is then cut at a dash boundary
  where possible.
- Suffixes are appended **after** truncation, so they can never be cut off.

### Suffix algorithm (lowest free suffix, never a count)

1. **Query** only the relevant SKUs in the branch, through the unique index:
   `sku === BASE` or `sku` matches `^BASE-\d+$` (an anchored regex on the escaped base, so it is an index
   range scan). This is never a full scan.
2. **Taken numbers:** `BASE` = 1, `BASE-n` = n, plus numbers reserved by other variants in the same request.
3. **Choose** the lowest free number: `ABC, ABC-2, ABC-4` → `ABC-3`; `ABC, ABC-2, ABC-3, ABC-5` → `ABC-4`.

### Concurrency and retries

- **The database decides.** The existing unique index is the guarantee; the pre-query is only an
  optimisation.
- **Product create:** candidates are chosen, then the product and variants are inserted.
  - On a duplicate-key error on `sku`, a concurrent request took a candidate between the query and the insert.
  - Everything written so far is rolled back: on a standalone server, the product, variants and ledger rows
    are hard-deleted; with transactions, the transaction aborts.
  - The collided SKU is excluded, candidates are recomputed (they now see the winner's SKU), and the create
    is retried.
- **Add variant:** the same loop around one insert.
- **Retry limit:** `MAX_SKU_ATTEMPTS = 8`. After that the error is logged and the user gets a controlled 409
  ("Could not allocate a unique SKU, please try again"). A duplicate is never saved, and no raw `E11000`
  error ever reaches the user.

### Manual SKUs (kept; auto-generation is the default)

| Situation | Behaviour |
|---|---|
| Field left blank | Generated as above. |
| **Create** with a typed SKU | Normalised to `[A-Z0-9._-]` and used as the base. If taken, the same suffix rule applies (`MYSKU-2`) and the API returns the final SKU, which the UI shows. A valid product is never refused because of an SKU. |
| **Update** with a new SKU that is taken | `409` with a clear message and a **suggested free SKU** (e.g. "…is already used. `MYSKU-2` is available."). An existing identifier is never silently rewritten. |
| Same typed SKU on two variants in one form | Resolved with suffixes on the server; the client no longer blocks the save. |

### Updates never regenerate

Renaming a product, or editing a variant's attributes, price or name, keeps the existing SKU. A new SKU is
generated only when a variant is created. Legacy SKUs (`OVERSI-BLA-XL`) stay as they are.

### Duplicate logical variants

Unchanged. The variant matrix editor still builds one variant per attribute combination, and the server does
not add or remove variants. SKU suffixes only resolve **identifier** collisions (for example "Red Shirt / XL"
vs "Red Shirt XL / Default").

### Barcodes

Barcodes are separate (EAN-13 in the `200` range) and unaffected. Scanning, sales, returns, exchanges,
labels and receipts keep working. Historical documents keep their `skuSnapshot`.

## 3. Files, tests, migration

- **Code:** `server/src/modules/products/sku.ts` (new: normalisation, bases, lowest-free suffix, indexed lookup, collision detection).
  `products.service.ts` has the create retry loop, the `insertProduct` helper, the `addVariant` retry loop, and
  `assertSkuFree` (update with suggestion). The old `generateBaseSku`, `variantSkuSuffix` and pre-check-only
  helpers were removed.
- **UI:** `ProductFormDialog.tsx` no longer blocks duplicate typed SKUs, shows the final server-assigned SKUs
  in the success toast, and has updated hints. `VariantMatrixEditor.tsx` has an updated hint.
- **Unit tests (30):**
  - normalisation: spaces, slashes, apostrophes, dashes, unsafe characters, accents, numbers, DEFAULT;
  - Bangla: non-empty, deterministic, distinct per colour;
  - length: base ≤ 57, variant part kept, a suffix still fits within 64;
  - suffixes: base / -2 / -4, the gap cases → -3 and -4;
  - manual SKU normalisation.
- **End-to-end (30 checks,** in `scripts/smoke-test.mjs` "automatic conflict-free SKUs"**):**
  - Tests 1–15 of the brief;
  - 4 simultaneous identical creates → all 201 with base, -2, -3, -4, and no `E11000` text;
  - taken typed SKU on create → resolved;
  - same typed SKU twice in one form → X and X-2;
  - update to a taken SKU → 409 with a suggestion;
  - another branch may reuse an SKU;
  - no duplicates overall.
- **Full suite:** 2684 passed, 0 failed.
- **Migration:** none needed. The unique indexes already existed (verified in the working database), there
  were 0 live duplicates and 0 lowercase SKUs, and existing SKUs are not touched.

## 4. Limitations

- **Bangla readability:** Bangla-only names get a hash code (`U7M2KX`) rather than a readable transliteration.
- **Deleted variants:** a soft-deleted variant's SKU can be reused by a new variant (the existing partial-index
  rule). Historical documents keep their own `skuSnapshot`, so history is unaffected.
- **Product SKU is branch-scoped:** so is the product base SKU. It is not shown at the till; sellable SKUs are
  on variants.

