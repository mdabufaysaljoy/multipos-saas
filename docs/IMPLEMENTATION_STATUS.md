# Super Shop POS — implementation map

**Date:** 2026-09-25 · **Commit:** `c8de88d` (`main`, clean tree) · **Scope:** Super Shop only.

> **Not the project change log.** The append-only history of the whole platform
> is the root `IMPLIMENTATION_STATUS.md` (note the spelling), which this file
> does not replace or duplicate. This is the Super Shop audit and plan.

**Verified this run:** `npm run lint` ✅ · `npm run typecheck` ✅ ·
`npm run build` ✅ · `npm test` ✅ **3231 passed, 0 failed** (local, MongoDB on
:27017). CI on GitHub is red — see Issue 10, reproduced below.

---

## 1. Module map

### Super Shop only — safe to change

| Layer | File |
|---|---|
| Models | `server/src/models/ShopProduct.ts`, `ShopStock.ts`, `ShopSale.ts`, `ShopStockMovement.ts`, `shopUnits.ts` |
| Module | `server/src/modules/supershop/{supershop.service,controller,routes,validators,supershopReports.service}.ts` |
| Adapters | `server/src/services/inventory/adapters/supershop.adapter.ts`, `server/src/services/returns/adapters/supershop.saleAdapter.ts` |
| Import | the `supershopAdapter` block in `services/import/posImport.adapters.ts` (~L124-190) and `SHOP_COLUMNS` |
| Client pages | `client/src/pages/supershop/*` (9 pages) |
| Client features | `client/src/features/supershop/{ShopReceiptDialog,ShopThermalReceipt}.tsx` |
| Client api/types | `client/src/api/supershop.ts`, `client/src/types/supershop.ts`, `client/src/lib/supershop.ts` |

### Shared — a change here touches other verticals

`services/pos/paymentMethods.service.ts` · `services/returns/posReturns.{service,figures,types,list}.ts` ·
`services/inventory/{adapter,posLedger}.ts` · `services/import/posImport.service.ts` ·
`services/catalogue/posCategories.service.ts` · `services/reports/{reportPrint,reportViews,posMetrics}.ts` ·
`modules/reports/reports.validators.ts` · `modules/common/common.validators.ts` ·
`modules/loyalty/*` · `modules/customers/*` · `middleware/*` ·
`client/src/features/{payments,printing,reports,returns,loyalty}/*` · `client/src/components/{MoneyInput,QuantityInput}.tsx`

### Data model

```
ShopProduct   tenant-scoped catalogue. brand is FREE TEXT. unitType each|weight.
              priceMinor is per piece, or per KILOGRAM for weight goods.
              vatRateBps is INCLUSIVE (price already contains VAT).
ShopStock     one row per (tenant, store, product). quantityOnHand in pieces or
              GRAMS. costPriceMinor = weighted average, per piece or per kg.
              unique index on (tenantId, storeId, productId).
ShopSale      status: 'completed' | 'voided' only. Lines snapshot name/brand/
              barcode/price/vat/cost + returnedQuantity.
Return        SHARED across verticals, told apart by `vertical`.
```

---

## 2. Issue-by-issue findings

Each is read from code. Where I could not reproduce something, it says so.

### 1. Stock quantity/weight above 1000 kg → 422 · **CONFIRMED**

**Root cause:** `supershop.validators.ts:11`
```ts
const baseQuantity = z.number().int().min(1).max(1_000_000);
```
Weight goods count in **grams**, so 1,000,000 = exactly **1000 kg**. Anything
above it fails zod → 422. `adjustStockSchema.quantityDelta` (±1_000_000) and
`reorderLevel` (max 1_000_000) share the ceiling, as does the importer
(`wholeNumber(..., 1_000_000)`).

The cap is one number serving two unit systems: sane for pieces, low for a shop
receiving a tonne of rice.

**Files:** `supershop.validators.ts` (L11, L83, L104), `services/import/posImport.adapters.ts` (L133-134).
**Risk:** Low. **Approach:** make the ceiling unit-aware — keep 1,000,000 pieces,
raise the weight ceiling (e.g. 100,000,000 g = 100 t). `lineAmount` already
guards overflow with `Number.isSafeInteger`. Check `ShopStock.quantityOnHand` and
the movement ledger for the same assumption.

### 2. Imported products cannot be sold out-of-stock by authorized users · **CONFIRMED — root cause found**

**Root cause:** two facts combine.

1. The import creates a `ShopStock` row **only when the sheet has opening stock**
   (`posImport.adapters.ts:180-187`, guarded by `if (item.opening)`, which is set
   only `...(stock > 0 ? ...)`). A product imported with blank or 0 stock has
   **no `ShopStock` row at all**.
2. The out-of-stock override matches an **existing row at or below zero**
   (`supershop.adapter.ts:77-81`):
   ```ts
   { tenantId, storeId, productId, quantityOnHand: { $lte: 0 } }
   ```
   No row → `findOneAndUpdate` matches nothing → falls through to
   `"Only 0 of X is in stock in this branch."`

The code says so itself (L95-97): *"A product never received into this branch has
no stock row and no cost basis, which is a different problem from having run out;
the override does not cover it."*

So it is **not** a permission bug — `allowOutOfStock` is wired correctly at
`supershop.service.ts:374`. It is a missing stock row.

**Approach:** in the override branch, `upsert: true` so a first sale creates the
row at a negative quantity. **Decide the cost basis deliberately** — an upserted
row has `costPriceMinor: 0`, which reports 100% margin on that sale. Either
accept it and label it, or refuse when no cost basis exists. This is the one
place in the phase where the money question outranks the code.
**Risk:** Medium — touches the shared `InventoryAdapter` contract only in the
Super Shop implementation; behaviour of the other three is untouched.

### 3. POS page does not show all products · **CONFIRMED**

**Root cause:** `SupershopPosPage.tsx:80` requests `limit: 30`, one page, with no
pagination, infinite scroll, or "load more". Server sort is
`{ category: 1, name: 1 }`, so a shop with 500 products sees the alphabetical
first 30 of the earliest department.

Server ceiling is `MAX_PAGE_SIZE = 100` (`config/constants.ts:96`), so raising
the client number alone caps out at 100.

**Approach:** paginate or virtualise the grid; search and the barcode path
already work against the whole catalogue, so this only affects browsing.
**Risk:** Low. Pairs naturally with Issue 9.

### 4. Large split payments fail above 80k with 422 · **NOT REPRODUCED — needs the payload**

I could not find an 80,000 threshold. Every 422 in this path is zod, and the only
caps in `createSaleSchema` are:

| Cap | Value |
|---|---|
| `amount` (each payment, and `discountMinor`) | 100,000,000 minor = **৳1,000,000.00** |
| payment rows | max **5** |
| `baseQuantity` per line | 1,000,000 |
| `redeemPoints` | 1,000,000 |

Client math (`paymentMath.ts`) is integer-only with no division, so no rounding
artefact reaches the wire.

**What I did find** is a real mismatch of exactly this class: `MoneyInput`
defaults to `max = 99_999_999_99` (**৳99,999,999.99**) while the server refuses
anything over **৳1,000,000.00** per row. A till can type an amount the API will
reject, and the 422 renders as *"The submitted data is not valid"* with no field
message — so the cashier sees an unexplained failure at *some* large number.

**Next step before coding:** reproduce once and capture the response body
(`error.details` names the failing field and its limit). That turns this from a
guess into a one-line fix. If the shop's currency scale differs from ৳-minor, the
80k figure may already be the 1,000,000 cap.
**Risk:** Low once the field is known.

### 5. Return exists, Exchange missing · **CONFIRMED**

Super Shop has returns (`POST /supershop/sales/:id/return`, shared engine,
`ShopReturnsPage.tsx`). It has no exchange.

**Reference:** Clothing's exchange is `modules/returns/returns.service.ts` — an
exchange is a return with `refundMethod: 'exchange'` **plus** a replacement sale,
with an idempotency key, the rule *replacement subtotal ≥ refund value*, and
compensating rollback at each step.

**Compatibility:** Clothing's engine is `Sale`-specific and folding the two
together is explicitly deferred in the root status log. The shared
`posReturns.service` has **no** exchange support and **no** idempotency key
(it writes `idempotencyKey: null`).
**Approach:** extend the shared engine with an exchange step driven by
`SaleReturnAdapter`, so Pharmacy inherits it later — do not fork a Super Shop
copy. Needs `returns.create` **and** `sales.create`.
**Risk:** **High** — the heaviest item here. Money, stock and loyalty move
together without transactions.
**Note:** the shared engine has an ordering defect worth fixing first — see
`docs/AUDIT-2026-09-25.md` **N1**.

### 6. Brand management missing · **CONFIRMED**

`ShopProduct.brand` is free text (`maxlength: 80`, default `''`). There is **no
`Brand` model anywhere in the repo** — Clothing stores brand as free text too, so
there is no reference implementation to copy.

`posCategoryService` is the right precedent: a tenant+vertical scoped name list
with CRUD, `assertUsable` on write, and a rename that cascades to items
(`posCategories.service.ts:148`).

**Approach:** either generalise `PosCategory` to a second "kind", or add a
parallel `PosBrand` following the same shape. Generalising is less code but
touches shared code used by three other verticals — weigh that.
**Risk:** Medium (data migration: backfill distinct existing brand strings).
**Depends on:** nothing. **Blocks:** the brand half of Issue 9 and brand
analytics in Issue 12.

### 7. Weighted/combined stock cost · **VERIFIED — mostly correct, two edges**

Read carefully; the core is right.

- Weighted average (`supershop.service.ts:151-176`) is a single atomic pipeline
  update with upsert and a duplicate-key retry. For weight goods both sides are
  grams × per-kg, so the units cancel and the average stays a per-kg figure. ✅
- Sale line cost (`:415`) uses `lineAmount(cost, qty, unitType)`, which divides by
  1000 for weight. ✅
- Inventory valuation (`:225-232`) divides by 1000 for weight. ✅

**Edge 1 — cost basis after an out-of-stock sale.** `$$onHand` is clamped with
`$max: [onHand, 0]`, so stock sold below zero contributes nothing to the average
while `quantityOnHand` still adds the true (negative) balance. Conservative, but
the average and the quantity disagree about the same row.

**Edge 2 — zero-cost rows.** An upserted or imported-without-cost row carries
`costPriceMinor: 0`, so `grossProfitMinor` counts the full sale as profit. The
importer guards this (*"Opening stock needs a cost price"*) but Issue 2's fix
would reintroduce it. **Decide this alongside Issue 2 — same question.**

Also: `restore` on a void writes `costPriceMinor: 0` (`:563`), and `$round`
in MongoDB is half-to-even. Both minor; neither is wrong today.

### 8. Sale Hold missing · **CONFIRMED**

No hold/park/suspend anywhere in the repo — not in any vertical.
`SHOP_SALE_STATUSES = ['completed', 'voided']`, and cart state is React-local in
`SupershopPosPage.tsx`, lost on reload.

**Approach:** a held sale is **not** a sale — it reserves no stock, takes no
number, earns no points, counts in no report. Store it as its own collection
keyed by (tenant, store, cashier), holding the cart and the customer/loyalty
selection. Re-price from the catalogue on resume; never trust held prices.
Avoid adding a `held` status to `ShopSale` — every existing aggregation filters
`status: 'completed'`, but reports, exports and the ledger would all need
re-auditing.
**Risk:** Medium. **Depends on:** nothing.

### 9. POS filtering needs Brand + Category dropdowns · **PARTIALLY DONE**

**Category already works** — `SupershopPosPage.tsx:73` loads departments and
passes `category` to the API; `listProductsSchema` accepts it.

**Brand does not.** `listProductsSchema` has no `brand` field, and
`listProducts` has no brand filter — brand is only reachable through the
free-text `search` `$or` (`supershop.service.ts:73`).

**Approach:** add `brand` to the query schema and filter; add the dropdown fed by
Issue 6's brand list. Index: the existing compound index is
`(tenantId, deletedAt, category, name)` — a brand filter will not use it.
**Depends on:** Issue 6 for a clean dropdown (a `distinct` over free text works
as an interim). **Risk:** Low.

### 10. CI failing · **CONFIRMED AND REPRODUCED — single root cause**

Local is fully green (3231/0). CI has failed on **every** run for days, always
~3 minutes, always **one** assertion:

```
FAIL  Rejects year zero date range
==========  3230 passed, 1 failed  ==========
```

**Root cause — a timezone-dependent boundary in a shared validator.**
`common.validators.ts:127`:
```ts
export const calendarDate = z.coerce.date().refine((v) => {
  const year = v.getUTCFullYear();
  return year >= 2000 && year <= 2100;
});
```
`z.coerce.date()` parses `"0"` via `new Date("0")`, which V8 reads as
**2000-01-01 local midnight**. The refine then reads `getUTCFullYear()`.
Measured:

| TZ | `new Date("0")` | `getUTCFullYear()` | Result |
|---|---|---|---|
| `Asia/Dhaka` (dev) | 1999-12-31T18:00Z | **1999** | rejected → 422 → **test passes** |
| `UTC` (CI) | 2000-01-01T00:00Z | **2000** | accepted → 200 → **test fails** |
| `America/New_York` | 2000-01-01T05:00Z | **2000** | accepted → **test fails** |

So `from=0` is accepted as a valid date anywhere at or behind UTC. Not a flake,
not Super Shop.

**⚠️ Scope note:** the fix is in **shared** code on a **Clothing** route
(`/reports/dashboard`). It cannot be done under a strict Super-Shop-only rule —
flagging rather than assuming. Reproduce locally with `TZ=UTC npm test`.
**Approach:** parse calendar dates as calendar dates — require `YYYY-MM-DD`
before coercing, and compare in one frame. **Risk:** Low, but it touches every
date-filtered report in all four verticals, so it needs the full suite in both
timezones.

### 11. Barcode quick product creation missing · **CONFIRMED**

`SupershopPosPage.tsx:139-145`: an unknown barcode ends at
`onError: () => toast.error('No product has that barcode')`. No create path.
The API already has everything needed (`GET /products/lookup`,
`POST /products` with a `barcode` field, and `assertUnique` treats a barcode as
belonging to one product).

**Approach:** a dialog pre-filled with the scanned barcode, creating the product
and optionally receiving opening stock, then dropping it into the cart. Mostly
client work. Must respect `products.create` **and** the plan's product limit
(`assertCanAddProduct`), and should reuse the category/brand pickers.
**Depends on:** Issues 1 (quantity ceiling) and 6 (brand picker) for a clean form.
**Risk:** Low.

### 12. Advanced Analytics needs expansion · **CONFIRMED — already broad**

`GET /supershop/reports` (gated on `advancedAnalytics` + `reports.view`) already
returns: totals, trend, products, departments, VAT by rate, hours, payments,
discounts, void totals, voids, write-offs, dead stock, and returns — with
returns correctly subtracted.

**Missing vs Clothing** (`reports.service.ts:305-313`): **sales by staff**
(`byStaff`). Also absent in both: brand breakdown, customer/loyalty analytics,
profit by department.

**One real defect found:** `supershopReports.service.ts:34` takes the timezone
from **the server process**:
```ts
const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
```
Day buckets therefore depend on where the server runs, not on the store. A shop
in Dhaka on a UTC host gets days split at 06:00 local. The `Store` model already
carries a timezone; this should use it.
**Depends on:** Issue 6 for brand analytics. **Risk:** Low-Medium.

### 13. Branch dashboard 30-day overview · **CONFIRMED — trend series absent**

The `last30` preset already exists server-side (`RANGE_PRESETS`) and client-side
(`DASHBOARD_PRESETS`, labelled "30 days"), and KPIs honour it with a
previous-period comparison.

**What is missing is the over-time view.** `supershop.service.ts:600` destructures
`bucket` from `resolveDashboardWindow` and returns it in `range` (`:663`) — but
**never builds a series**. `bucket` is computed, shipped, and unused. Clothing
calls `this.trend(match, granularity)` (`reports.service.ts:265`) and returns a
bucketed array.

**Approach:** add a `trend` aggregation grouped by `bucket`, mirroring Clothing's
`trend()` at `reports.service.ts:883`, and render a chart. The plumbing is
already in place. Use the store timezone (see Issue 12), not the process one.
**Risk:** Low. **Note:** the dashboard is **not** behind `advancedAnalytics`,
unlike `/reports` — keep it that way.

---

## 3. Dependencies

```
1  quantity ceiling ────────────┐
2  out-of-stock (cost basis) ───┼──→ 11 barcode quick create
6  brand management ────────────┼──→ 9 brand filter
                                └──→ 12 brand analytics
10 CI green  ──→ (gates trustworthy verification of everything after it)
N1 returns ordering ──→ 5 exchange
12 store timezone ──→ 13 trend buckets
7  cost basis decision ←──shares a decision with──→ 2
3, 8  independent
```

## 4. Recommended phase order

Two changes from the suggested order, both evidence-based:

**CI moves to the front.** It is currently impossible to tell a regression from
the standing failure, and every later phase is verified against it. It is also
~1 line. Doing it last means eleven phases land unverifiable.

**Brand management moves ahead of POS filtering**, since the dropdown is its
consumer.

| Phase | Work | Why here |
|---|---|---|
| **0** | CI green (Issue 10) ⚠️ *shared code — needs your go-ahead* | Unblocks verification of everything |
| **1** | Stock ceiling + out-of-stock sale + cost-basis decision (1, 2, 7) | One decision covers all three |
| **2** | Brand management (6) | Blocks 9 and 12 |
| **3** | POS product loading + Brand/Category filter (3, 9) | Consumes phase 2 |
| **4** | Large-value split payment (4) | Cheap once the payload is captured |
| **5** | Return ordering fix (N1) then Exchange (5) | Riskiest; wants a green suite |
| **6** | Sale Hold (8) | Independent |
| **7** | Barcode quick create (11) | Wants 1, 2, 6 done |
| **8** | Advanced Analytics + store timezone (12) | Wants 6 |
| **9** | Dashboard 30-day trend (13) | Wants the timezone fix |

## 5. Files likely to change

| Phase | Files |
|---|---|
| 0 | `modules/common/common.validators.ts` **(shared)**, possibly `scripts/smoke-test.mjs` |
| 1 | `supershop.validators.ts`, `services/inventory/adapters/supershop.adapter.ts`, `services/import/posImport.adapters.ts`, `models/ShopStock.ts` |
| 2 | new `PosBrand` model + service/routes (or extend `services/catalogue/posCategories.service.ts`), `supershop.{routes,validators,service}.ts`, new `ShopBrandsPage.tsx`, `api/supershop.ts` |
| 3 | `supershop.{validators,service}.ts`, `SupershopPosPage.tsx`, `ShopProductsPage.tsx` |
| 4 | `supershop.validators.ts` and/or `client/src/components/MoneyInput.tsx` **(shared)** |
| 5 | `services/returns/posReturns.{service,types}.ts` **(shared)**, `adapters/supershop.saleAdapter.ts`, `supershop.{routes,controller,validators}.ts`, `ShopReturnsPage.tsx`, `ShopThermalReceipt.tsx` |
| 6 | new `ShopHeldSale` model + routes, `SupershopPosPage.tsx` |
| 7 | `SupershopPosPage.tsx`, new quick-create dialog, `api/supershop.ts` |
| 8 | `supershopReports.service.ts`, `models/Store.ts` (timezone read), `SupershopReportsPage.tsx` |
| 9 | `supershop.service.ts` (dashboard), `SupershopDashboardPage.tsx` |

## 6. Testing strategy

The suite is the gate, but it is one 9,300-line HTTP script with no unit layer
and no frontend tests, so:

1. **Phase 0 first**, then treat 3231/0 as the baseline. Run `TZ=UTC npm test`
   as well as the local timezone — that difference is what hid Issue 10.
2. **Add assertions in the existing Super Shop sections** rather than new files,
   matching the project's convention.
3. **Per phase, the checks that would have caught the bug:**
   - 1: receive 2000 kg; sell 1500 kg; confirm ledger and valuation agree.
   - 2: import a product with **no** opening stock, then sell it with and without
     `sales.sellOutOfStock`; assert the stock row is created negative and assert
     what profit reports.
   - 3: 150 products, confirm all reachable.
   - 4: the captured failing payload, asserted at the new ceiling and one above.
   - 5: partial exchange, cheaper replacement refused, double-submit idempotent,
     stock and points both correct, plus a **failure injected after the return
     row is written** (N1).
   - 6: hold, reload, resume; confirm no stock reserved and no report movement.
   - 8/9: a sale at 23:30 store-time lands in the right bucket under `TZ=UTC`.
4. **Tenant isolation**: every new route needs a cross-workspace 404/403 check —
   the existing sections have the pattern.
5. **Responsiveness** (rule 14): new pages checked at 375px.
6. Consider a first unit test around `shopUnits.ts` when Phase 1 changes the
   quantity ceiling — it is pure and needs no database.

## 7. Open questions for the owner

1. **Issue 2/7 — cost basis.** When an authorized till sells a product that was
   never received, what cost should the sale record? Zero (reports 100% margin)
   or refuse the sale? This is a money-reporting decision, not a code one.
2. **Issue 10 — scope.** The CI fix is in shared code on a Clothing route.
   Proceed, or leave CI red for now?
3. **Issue 4.** Can you reproduce the 80k failure once and send the response
   body? Its `details` names the field and limit.
4. **Issue 6.** Generalise `PosCategory` (less code, touches three other
   verticals) or add a parallel Super-Shop-scoped brand list (more code, zero
   blast radius)?

---

# Change log

## 2026-09-25 — Phase 1 (part): stock ceiling and the authorised out-of-stock sale

Issues 1 and 2 of the audit above. Super Shop only.

### Issue 1 — stock could not go above 1000 kg

**Cause — the request schema, not the frontend, database, or precision.**
`supershop.validators.ts` bounded every quantity with a single number,
`max(1_000_000)`. Weighed goods count in **grams**, so that number is a million
pieces but only **1000 kg** — one delivery of rice. The bound was applied before
anything knew which unit the product used.

A second, looser cap sat in the client: `parseKgToGrams` accepted at most four
integer digits (9999 kg). The server was the binding one.

**Fix — the bound moved to where the unit is known.** A zod schema cannot see the
product, so it now bounds by the *widest* unit and the service narrows it once
the product has been read:

- `models/shopUnits.ts` — `MAX_PIECES` (1,000,000), `MAX_GRAMS` (100,000,000 =
  100 t), `MAX_BASE_QUANTITY`, `maxQuantityFor()`, `describeMaxQuantity()`.
- `supershop.service.ts` — `assertWithinUnitMax()`, applied in `receiveStock`,
  `adjustStock`, `createSale` (per line) and `createProduct` / `updateProduct`
  for `reorderLevel`. A refusal names the limit **in the unit the person typed**
  ("the most in one go is 100000 kg"), never in grams.
- `posImport.adapters.ts` — the Super Shop block derives its ceiling from the
  row's own *Sold by* column. **Pharmacy's identical lines were left alone.**
- `client/src/lib/supershop.ts` — `parseKgToGrams` now allows six integer digits
  and is bounded by the same `MAX_GRAMS`; `parseQuantity` bounds pieces by
  `MAX_PIECES`. A till can no longer type an amount the API will refuse.

**Preserved:** grams-per-kg semantics, 3-decimal kg entry (`1.25` → exactly
1250 g, still by string split so no float touches it), the weighted-average cost
maths, negative stock only through the override, and every existing refusal for
zero, fractional, negative and non-numeric input.

**On "decimal quantities":** the API has none, deliberately. A weighed quantity is
an **integer number of grams**; the decimal exists only in the kg field a person
types. That is what keeps weighed money exact, so it was not changed.

### Issue 2 — imported products could not be sold out of stock, even by an admin

**Cause — not permissions.** `allowOutOfStock` was wired correctly from
`sales.sellOutOfStock`. Two facts combined:

1. The importer creates a `ShopStock` row **only when the sheet carries opening
   stock** (`if (item.opening)`, set only when `stock > 0`). A row imported with a
   blank stock column gets **no stock record at all**.
2. The override matched an **existing** row: `quantityOnHand: { $lte: 0 }`. With
   no row, `findOneAndUpdate` matched nothing and fell through to
   *"Only 0 … is in stock in this branch."*

So the override missed precisely the products a bulk import creates.

**It was never import-specific.** `createProduct` does not create a stock row
either, so a product added **by hand** and not yet delivered was refused the same
way. Fixing the shared cause is what "imported products behave like manually
created ones" actually requires.

**Fix.** `supershop.adapter.ts` — the override branch now upserts, so the first
authorised sale creates the row at the negative balance an existing row would
have reached. Enforced server-side; no client flag is involved.

The narrow rule is intact. A row holding **some** stock but not enough does not
match `$lte: 0`, so the upsert attempts a second row and the unique index on
`(tenantId, storeId, productId)` refuses it; that duplicate key is caught and
falls through to the normal "not enough stock" error.

| | no `sales.sellOutOfStock` | with it (incl. Admin) |
|---|---|---|
| out of stock (row at ≤ 0) | blocked | allowed, line flagged |
| **never received (no row)** | **blocked** | **allowed, row created negative** |
| some stock, not enough | blocked | **blocked** |

**⚠️ Cost basis — decided by default, still open for you.** A branch that never
bought the goods has no cost for them, so the upserted row records
`costPriceMinor: 0` and the sale's `costMinor` is 0 — **all of it reports as gross
profit** until the first delivery sets the real average. I asked which behaviour
you wanted and proceeded with zero rather than block the fix, because it is what
an existing zero-cost row already did. The ledger row is stamped
`outOfStockOverride`, so a report can tell these sales apart. Refusing a sale
with no cost basis instead is a small change in the same branch.

### One existing assertion changed on purpose

`scripts/smoke-test.mjs` asserted *"a product never received here is still
refused"* — the old behaviour, which was the bug. It was replaced with the
permission-dependent behaviour above.

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3262 passed, 0 failed** (baseline 3231; **31 net new
  assertions**). Two intermediate failures during development were my own test
  fixtures perturbing assertions that count products by exact value (the plan
  meter and the dead-stock report); the fixtures now reset their stock after each
  delivery and are retired at the end of the block.
- `client/src/lib/supershop.ts` checked directly against 24 cases via `tsx`
  (1000 kg, 1500 kg, 10 t, 100 t, past the ceiling, `1.25` → 1250 g, and the
  grams → kg-text → grams round trip).

New backend assertions — **ceilings:** 1000 kg exactly, 1500 kg, 10 t (past the
old client wall), 100 t at the ceiling, past the ceiling refused, 1.25 kg exact,
negative / NaN / Infinity / null refused (Infinity and NaN sent as raw JSON,
since `JSON.stringify` cannot carry them), a million pieces accepted and a
million-and-one refused in piece units, a count correction above 1000 kg, a
reorder level above 1000 kg on a weighed product but not on a piece product.
**Override:** a never-received product blocked without the permission and no row
conjured up, allowed with it, the row created at −3, zero cost recorded, the
ledger row, the first delivery paying off the debt and setting the cost basis;
and an imported no-opening-stock product blocked for an unauthorised till, sold
by an authorised one and by an admin, the branch left owing 750 g, with the
movement in the ledger.

**Not touched:** Clothing, Restaurant, Pharmacy — no addition in the diff
references them. **Still open:** the CI failure (Issue 10) is red for the reason
documented above; it is a shared validator on a Clothing route and was out of
scope here.

## 2026-09-26 — Phase 2: the till's item list, and filtering it

Issues 3 and 9 of the audit above. Super Shop only.

### Issue 3 — the POS showed no products

**Cause — a disabled query, not pagination.** `SupershopPosPage.tsx` had:

```ts
const browsing = search.length > 0 || department !== 'all';
const { data: results } = useQuery({ ..., enabled: browsing });
```

So the product query **never ran** until the cashier typed something or picked a
department; until then the screen showed an `EmptyState` reading *"Ready to
scan"*. That is the reported "shows no products", and it was deliberate — the
till was built scan-first. Behind it sat the second half: `limit: 30`, one page,
no way to reach page 2, so even while browsing it showed at most 30 of the
catalogue.

Everything else audited was already correct and was left alone: the API request,
the `activeOnly` product-status filter, the category filter, and branch scoping
(the catalogue is **workspace**-scoped by design — `ShopStock` is what is per
branch, and the list already carries this branch's stock per row).

**Fix.** The query is now a `useInfiniteQuery`, always enabled, 40 products a
page, with an `IntersectionObserver` sentinel that fetches the next page as the
end of the list scrolls into view and a "Load more products" button as the
fallback. This is the same shape Clothing's `features/pos/ProductSearchPanel`
has used since it was built — the reference implementation, followed rather than
reinvented. The whole database is never loaded: the browser holds only the pages
that were scrolled to.

Preserved exactly: the barcode path (a separate `lookup` mutation, untouched and
unaffected by any filter — asserted), the debounced product search, and
**out-of-stock visibility**. An out-of-stock row is still listed, still says
"Out of stock", and is tappable or not according to `sales.sellOutOfStock` —
the same permission flow as before, re-checked on the server.

### Issue 9 — Brand and Category dropdowns

Category filtering already worked; **brand did not exist** as a filter — brand
was reachable only through the free-text search `$or`.

- `listProductsSchema` gained `brand`; `listProducts` filters on it. **Server-side**,
  so a filter narrows the whole catalogue and not the page already in the browser.
- New `GET /supershop/brands` (`products.view`) returns the distinct brands in
  use, blanks dropped and sorted for a dropdown. A brand is still free text on
  the product — there is no Brand catalogue yet (audit Issue 6), so this is the
  values in use, not a managed set.
- `ShopProduct` gained `{ tenantId, deletedAt, brand, name }`. The existing index
  leads with `category` and cannot serve a brand filter or the `distinct`.
  Additive; no migration.
- Client: new `features/supershop/PosFilters.tsx` — two dropdowns. **Dropdowns,
  not the chip row**, because a supershop has far more departments than a
  restaurant has menu sections and brands are open text, so chips would scroll
  off the side of a tablet. `features/catalogue/CategoryFilter` is **shared with
  Pharmacy and Restaurant and was not touched**; the Super Shop page simply stops
  using it.
- Both filters live in the query key beside the search text, so changing any of
  them restarts at page 1 and pages from different filters never mix. A
  department or brand that stops existing falls back to All rather than filtering
  the list to nothing behind a blank dropdown.

**No second product-query system:** both filters, the search and the paging all
go through the existing `supershopApi.products` → `GET /supershop/products`.

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3289 passed, 0 failed** (was 3262; **27 net new assertions**).

New assertions, in a new section *"Supershop POS item list: paging and filters"*,
run against **45 real products** so the 40-per-page list genuinely has a second
page: no filter (whole catalogue counted, first page only, second page is the
rest, no product on both pages, out-of-stock rows present); the brand list
(brands in use, never a blank, sorted); **category only** (23), **brand only**
(15), **both** (8), an unknown brand returning nothing rather than everything;
**search + brand** (15) and **search + both** (7), and a search that matches
nothing in a brand; the **barcode lookup unaffected by the filters**; and
isolation — 401 unauthenticated on both routes, 403 cross-workspace on both, and
422 for a malformed brand. The 45 fixtures are retired at the end of the block,
because the plan meter and the dead-stock report further down count products by
exact value.

**Browser pass: not completed.** The dev database's Super Shop workspace
("Shwapno", 25 products, brands PRAN/Square) belongs to the owner's own account
and signing in would mean entering their password, which I will not do. The app
builds, serves and reaches the sign-in screen with no console errors; the
signed-in visual check of the dropdowns and infinite scroll is still outstanding
and needs the owner at the keyboard.

**Not touched:** Clothing, Restaurant, Pharmacy. **Still open:** CI (audit Issue
10) remains red for the timezone reason documented above.

## 2026-09-26 — Phase 3: high-value sales and split payment

Audit Issue 4, which the audit could not reproduce from reading alone. It can now
be stated precisely. Super Shop only; **no shared code changed**.

### What the ~Tk 80,000 threshold actually was: nothing

Traced the whole request — POS state → `usePayments`/`computePayments` →
`tenderedRows` → payload → `createSaleSchema` → controller → `supershopService`
→ `settleTender` → `ShopSale`. Then probed the schema directly, and then drove
real sales end to end.

**There is no limit at or near Tk 80,000, and there never was.** Before any
change, sales at Tk 50,000 / 80,000 / 110,000 / 100,000 / 250,000 (the reported
basket, 100k + 75k + 75k across three tenders) and 500,000 across four tenders
all completed. Each of these is now a standing assertion.

Ruled out, each by inspection:

| Suspected cause | Finding |
|---|---|
| Integer schema | `z.number().int()` throughout; correct |
| Decimal precision | None exists — money is integer minor units end to end |
| Frontend input type | `parseMoneyToMinor` splits the string; no `parseFloat(x) * 100` |
| JSON parsing | Client sends plain integers; verified |
| Database type | `ShopSale` validates `Number.isSafeInteger`; no cap |
| Aggregation logic | `computePayments` is integer-only, no division |
| **Max constraint** | **The one real limit — but at Tk 1,000,000, not 80,000** |

### The real defect

`supershop.validators.ts` used **one** `amount` schema, capped at 100,000,000
minor (**Tk 1,000,000**), for both a unit price and a payment row. A basket is
not bounded by what one item costs, so a single tender above Tk 1,000,000 was
refused — and refused as a bare `422 "The submitted data is not valid"`, with no
indication of which field or what the limit was. That is the message in the
report, and an illegible refusal at *some* large amount is exactly what gets
remembered as "about eighty thousand".

**Clothing, the reference vertical, has no upper bound on a payment at all**
(`positiveMinorAmount` — safe integer, positive, no max). The cap is something
the three newer verticals introduced.

### The fix

Two ceilings instead of one, because the two quantities are not alike:

- `amount` — a unit price or cost — **stays at Tk 1,000,000**, deliberately. A
  unit price is MULTIPLIED by a quantity, and this ceiling times the largest
  quantity a line may carry stays inside `Number.isSafeInteger`, so a line total
  can never silently lose precision.
- `saleAmount` — a payment row or a whole-sale discount — **Tk 100,000,000.00**
  (`MAX_SALE_AMOUNT_MINOR`), with a message that names the limit and says to
  split across tenders. Five rows at the ceiling still add up well inside a safe
  integer.

This is a bound, not the removal of one: a mistyped amount is still refused, and
now says why.

**The client/server mismatch closes without touching shared code.** `MoneyInput`
accepts at most Tk 99,999,999.99; the new server ceiling is Tk 100,000,000.00,
just above it. Every amount a till can physically type is now an amount the
server will take, so `features/payments/PaymentPanel` (shared with all four
verticals) needed no change.

**The till now says what is wrong.** `SupershopPosPage`'s sale error handler
reads `ApiError.fieldErrors` — which already existed and was simply unused — and
shows the field-level message instead of "The submitted data is not valid".

Preserved unchanged: exact minor-unit precision, split-payment validation,
remaining-payable, cash-tendered and change, `settleTender`'s three rules
(enabled method, covers the total, only cash may exceed), the guarded stock
decrement that is the duplicate-sale protection, and backend authority — the
request still carries no prices.

### Proof that other POS types are unaffected

Three files changed, none shared:
`server/src/modules/supershop/supershop.validators.ts` ·
`client/src/pages/supershop/SupershopPosPage.tsx` · `scripts/smoke-test.mjs`.
`amount` and `saleAmount` are module-private to Super Shop's validators.

**Flagged, not changed:** Pharmacy and Restaurant carry the *identical*
`max(100_000_000)` payment cap and therefore the same latent limitation. Out of
scope here; worth a decision.

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3314 passed, 0 failed** (was 3289; **25 net new assertions**).

New section *"Supershop high-value split payment"*: under / exactly / above
Tk 80,000; Tk 100,000 on one tender; **Tk 250,000 across three tenders, paid to
the paisa with no change**; Tk 500,000 across four, with every tender stored
exactly as taken; Tk 1,500,000 both split and — now — as a single tender, which
the old cap refused; a payment above the new ceiling refused *with the field and
the limit named*; cash over the total becoming change; a card over the total
refused; only the cash part of a split overshooting; a short split refused with
its shortfall in minor units; an unaccepted tender, a negative amount, a
fractional amount and a sixth tender all refused; and — the duplicate-sale
check — every completed sale taking its stock exactly once while no refused sale
took any.

**Not touched:** Clothing, Restaurant, Pharmacy. **Still open:** CI (audit Issue
10). **Browser pass:** still outstanding for the same reason as Phase 2.

## 2026-09-26 — Phase 4: Exchange (Super Shop)

Audit Issue 5, the one flagged **High risk**. Super Shop only; Clothing untouched.

### What an exchange is here

A return and a sale joined at the till. The returned goods' refund value pays for
replacement goods instead of being paid out, and the customer settles whatever is
left. It is built from the parts that already exist — the shared return engine
and Super Shop's own checkout — so stock, VAT, split payment, cash change, the
ledger and the customer's lifetime value all follow the ordinary rules. **No
second checkout and no second receipt engine were written.**

### The seam, and why Pharmacy and Restaurant are provably unaffected

`SaleReturnAdapter` gained an **optional** `exchange` capability
(`SaleExchangeAdapter`: `quote`, `create`, `cancel`, `link`). Only Super Shop
implements it. `posReturnService.createExchange` refuses outright when a vertical
has not provided one, and `posReturnService.create` — the ordinary return path
every vertical uses — was **not changed**.

The one shared refactor is `prepareLines`, the line-validation both paths now
share. It was extracted verbatim, deliberately: an exchange that valued the
returned goods differently from a refund would be a way to launder money out of
the till. The existing Pharmacy, Restaurant and Super Shop return assertions all
still pass, which is what proves the extraction changed nothing.

Restaurant has nothing to swap — the food is gone. Pharmacy trading one batch for
another needs an expiry and dispensing decision that is its own piece of work.
Both are left as they were.

### Order of operations

No multi-document transactions, so ordering is the correctness argument:

```
validate the returned lines  -> refund value from the ORIGINAL sale prices
quote the replacement        -> today's catalogue prices, server-side
rule: replacement >= refund  -> nobody is paid out for trading down
hold the returned quantities -> atomic, guarded, releasable
create the replacement sale  -> takes its stock; tenders cover only the difference
put the returned goods back  -> unless the till says they are damaged
write the return             -> THE COMMIT POINT, carrying the idempotency key
```

Each failure undoes the steps already taken. **The return document is written
last of the steps that can fail** — so unlike the ordinary return path (see
`AUDIT-2026-09-25.md` N1, still open) a half-finished exchange cannot be mistaken
for a finished one. The bookkeeping after the commit point is best-effort and
logged rather than thrown: it must not leave the customer holding goods and the
till showing an error.

### Rules the backend enforces

Nothing is trusted from the client — **no prices are sent at all**.

| Rule | Where |
|---|---|
| Sale belongs to this workspace *and* branch | `findSale` scopes on both |
| Returnable quantity | `prepareLines`, per line, against what is left |
| Replacement priced from the catalogue | `quote`, never from the request |
| **Replacement may not be cheaper** | 422 `EXCHANGE_CHEAPER_REPLACEMENT` |
| Payment covers the difference | `settleTender`, same three rules as the till |
| Only cash may overshoot | `settleTender` |
| Inventory | the inventory adapter, both directions |
| Permissions | `returns.create` **and** `sales.create` |
| Duplicate submission | unique `idempotencyKey`, replay returns the first |

The credit is **what was paid**, not today's shelf price: it comes from the
original sale line and shares out any discount that sale had, exactly as a refund
does. A test pins this by raising the catalogue price between the sale and the
exchange.

**On loyalty:** Clothing has to subtract the restored point value from the
exchange credit, because its returns do not apportion the sale discount. Super
Shop needs no such step — its stored `discountMinor` already includes the loyalty
discount, so `refundFor` has already excluded the points-funded share. The points
themselves still come back through the existing `reverseLoyalty` hook.

### Receipt

The replacement sale's own receipt, through the existing Super Shop receipt
architecture (`ShopThermalReceipt`, the shared receipt branch for header, logo,
footer and paper width). It gains an `EXCHANGE` banner naming the original sale
and the return number, the returned-goods credit and the difference paid, and a
"Returned" block listing what came back. Branch, date/time, tenders and branding
come from the existing layout unchanged.

### Model and API

- `ShopSale.exchange` — optional, defaults null, so sales taken before exchanges
  existed load unchanged. Carries the original sale, the credit, the return
  number and a snapshot of what came back.
- `POST /supershop/sales/:id/exchange` — `returns.create` at the route,
  `sales.create` in the engine.
- Client: `ShopExchangeDialog` (Super Shop only). `PosReturnDialog`, shared with
  Pharmacy and Restaurant, was **not touched**.

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3351 passed, 0 failed** (was 3314; **37 net new assertions**),
  green on the first run.

Covering every case asked for: **same product** exchanged like for like with the
shelf ending where it started; **a different product at the same price** with
nothing to pay; **a dearer replacement** collecting exactly the difference;
**a cheaper replacement refused** with nothing moved — no stock, no return on the
sale; **split payment** for the difference across two tenders; **insufficient
payment** refused with the sale still fully exchangeable; **cash over the
difference** coming back as change; **inventory** checked in both directions on
every case; **duplicate request** — the same key returning the same exchange,
one replacement sale, one unit off the original; **unauthorized access** — no
session, another workspace, a till missing `returns.create`, a till missing
`sales.create`, and the same till succeeding once it holds both; and **receipt
generation** — the replacement's own receipt naming the original sale, the
return, the credit, what came back, the branch, the date and the tender.

**Not touched:** Clothing, Restaurant, Pharmacy. **Still open:** CI (audit Issue
10), the ordinary return path's N1 ordering, and the browser pass.

## 2026-09-26 — Phase 5: Brand management (Super Shop)

Audit Issue 6. Super Shop only; **no shared server code changed at all**.

### The existing architecture, audited first

`posCategories.service` is the precedent, and the design is worth restating
because Brand copies it deliberately:

- the **item carries the NAME**, so the collection is the LIST of names —
  what exists, what is still offered, in what order;
- the list is **everything written down plus everything items actually use**,
  which is why it needed no migration and loses nothing;
- a **slug** decides duplicates, so "PRAN", "pran" and " Pran " are one name;
- **renaming rewrites the live items**; sales keep the name they were sold
  under, so last month's report still reads as it did;
- **removing is refused while in use**; hiding (`isActive`) is how something
  still on the shelf is retired;
- `assertUsable` **auto-registers** an unknown name and **refuses a hidden one**.

Brand now works identically, on `ShopProduct.brand`.

### Why a separate model rather than extending `PosCategory`

`PosCategory` is shared by Super Shop, Pharmacy and Restaurant, and its unique
index is `(tenantId, vertical, slug)`. Adding brands to it would have meant a new
`kind` discriminator, a changed unique index and a migration — on a collection
three verticals depend on. `ShopBrand` is its own Super Shop-scoped collection
instead: zero blast radius, and Clothing keeps brand as free text, Pharmacy calls
the equivalent `manufacturer`, and a restaurant has none, so there was nothing to
share yet. If another vertical ever needs brands, `shopBrands.service` is the one
to generalise the way `posCategories` already is.

### One real difference from a category

**A brand is optional.** Most of a supershop's shelf is unbranded, so an empty
name is never a row, never counted and never refused. Existing products without a
brand stay exactly as valid as they were — asserted.

### What was built

- `models/ShopBrand.ts` — unique live row per name per workspace
  (`{tenantId, slug}` partial on `deletedAt: null`), plus a list index
  `{tenantId, deletedAt, sortOrder, name}`.
- `services/catalogue/shopBrands.service.ts` — create, list (with `search` and
  `includeInactive`), rename-with-cascade, hide/show, remove-when-unused,
  `assertUsable`.
- `ShopProduct` already had `{tenantId, deletedAt, brand, name}` from Phase 2,
  which serves the filter and the list.
- Routes at `/supershop/brands`: reading needs `products.view` (every till must
  know what it may filter by), writing needs `categories.create/edit/delete`.
  **Reusing the category permissions deliberately** — it is the same class of
  catalogue setting, and new keys would have meant a roles migration across all
  four verticals.
- `createProduct` / `updateProduct` call `shopBrandService.assertUsable`, so a
  brand typed into the product form joins the list and a hidden one is refused.
- **Import**: the `Brand` column already existed and goes through `createProduct`,
  so a brand named in a sheet registers itself. Existing imports are unaffected —
  a sheet with no brand column still imports exactly as before. (The preview's
  `newCategories` summary has no `newBrands` counterpart; that would touch the
  shared import service used by three verticals, so it was left alone.)

### Client

- `ShopBrandsPage` reuses the shared `PosCategoriesScreen` — full CRUD,
  hide/show, rename-with-warning and delete-guard for free. The screen gained
  two **optional, defaulted** props (`entityLabel`, `maxNameLength`) purely for
  wording and the 80-character limit; every existing caller renders exactly as
  before.
- The product form's brand field is now the shared `CategoryInput` combobox,
  which gained optional `kind` / `maxLength` / `placeholder`. It still accepts a
  new name typed free-hand.
- The till's brand filter now reads the **managed** list, so a hidden brand
  disappears from it.

### A semantic change worth knowing

Phase 2's brand endpoint was a `distinct` over live products, so a brand vanished
when its last product did. It is now a catalogue: **a brand survives its
products**, and what drops to zero is the count carrying it. Two Phase-2
assertions were updated to the new meaning.

### ⚠️ On "Department, Category and Brand independently"

Super Shop has **one** such axis today, not two: the field is `category` and the
UI calls it "Department". Brand is now genuinely independent of it — a product
has either, both or neither, and the till filters by each separately, which is
asserted.

Splitting Department and Category into two separate axes would be a schema change
to every product, the import, the filters and the reports. It is not what
"implement Brand management" asked for, and "do not replace Department or
Category" pointed the other way, so **it was not done**. If two axes are wanted,
say so and it is its own task.

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3396 passed, 0 failed** (was 3351; **45 net new assertions**),
  green on the first run.

Covering: create; duplicate refused, including the same name in different case
and spacing; nameless and over-length refused; unknown fields refused; listed
with its product count; search, and a search that matches nothing; assigning to a
product and filtering by it; a brand typed straight onto a product joining the
list; **a product with no brand still valid**, and "no brand" never becoming a
brand; rename moving every product while **the sale keeps the name it was sold
under**; rename onto a taken name refused; hide, dropping out of the till list
but not the owner's; new goods refused under a hidden brand while existing ones
are untouched; show again; **remove refused while in use**, allowed when unused,
and the name free afterwards; 404 on an unknown id; **brand and department
independent**, separately and together; the import path; and isolation and
permissions — no session, another workspace reading/creating/renaming, and a till
that may read but not create, rename or remove.

**Not touched:** Clothing, Restaurant, Pharmacy. **Still open:** CI (audit Issue
10), N1 on the ordinary return path, and the browser pass.

## 2026-09-26 — Phase 6: stock cost and profit

Audit Issue 7. Full specification: **`docs/SUPERSHOP_COSTING.md`** (new).
Super Shop only.

### The method, audited before anything was changed

**Weighted average cost, per branch.** Not FIFO, not batch cost, not last
purchase price. `receiveStock` moves the average in one atomic pipeline update,
upserted, with a duplicate-key retry:

```
newCost = round((onHand x oldCost + receivedQty x receivedCost) / (onHand + receivedQty))
100 kg @ 100  +  100 kg @ 120  ->  200 kg @ 110
```

Verified correct as it stood, and two properties confirmed **deliberate** rather
than fixed: `onHand` is floored at zero (units already sold out-of-stock must not
dilute the delivery that arrives after them), and a delivery never rewrites what
an earlier sale cost.

Also verified correct already: the sale's own `costMinor`, `writeOffs` and
`deadStock` in analytics, and `inventory-summary` — all four convert grams to
kilograms through `lineAmount`.

### What was actually broken — and it was worse than cost

The unit trap. A Super Shop quantity is in **grams** while its prices are **per
kilogram**, so `price x quantity` is a thousand times the real figure. Two places
in the **shared** return engine did exactly that, because it sees a quantity and
a unit price and has no idea one of its verticals weighs things:

1. **`refundFor` — a weighed return refunded 1000x the money taken.** 1 kg of
   rice sold for Tk 200 refunded Tk 200,000. Proved by running the new tests
   before the fix: `creditMinor: 20,000,000` against a replacement priced at
   `20,000`.
2. `posReturns.figures` valued returned cost the same way, inflating reported
   profit by the same factor — measured at exactly 1000x on the dashboard.

**This is a money bug that shipped in task 08 and that my own audit missed** — it
reviewed `refundFor`'s discount proration and never checked its units.

### The fix: a seam, not a special case

`SaleReturnAdapter` gained two optional methods:

```ts
amountOf?(line, quantity): number   // what these units SOLD for
costOf?(line, quantity): number     // what they COST
```

The engine's default stays `price x quantity`, which is exactly right wherever a
quantity is a count of things — **Pharmacy and Restaurant implement neither and
are provably unchanged**, which the existing return assertions for both confirm.
Super Shop implements both with the same `lineAmount` its checkout charges by, so
a refund can never differ from what was taken.

The return line now stores `costMinor`, the extended cost, so reports read a
number rather than re-deriving one; both the return and the exchange writer use
the same code path. Rows written before this fall back to
`quantity x costPriceMinorSnapshot` — correct for a count of things, and what
those rows have always reported.

**⚠️ Existing data:** a Super Shop that has already refunded weighed goods holds
the inflated figure on those `Return` rows and will keep reporting it through the
fallback. Recomputing them is a migration this change does not attempt; the
figures are recoverable from the sale lines if wanted. **Worth checking your
production data before merging.**

### Verification

- `npm run lint` ✅ · `npm run typecheck` ✅ · `npm run build` ✅
- `npm test` — **3427 passed, 0 failed** (was 3396; **31 net new assertions**).

Run **before** the fix, the new section failed 4 assertions — the over-refund,
the 1000x cost in the dashboard, and an exchange of weighed goods refused because
its credit was a thousand times the replacement's price. One of the four was my
own arithmetic (the half-kilo average is 10,010, not 10,020) and the expectation
was corrected.

Covering: the canonical 100+100 at 100/120 averaging to 110; **same cost** leaving
it alone; **a lower cost** pulling it down rather than replacing it; **multiple
receipts**; **decimal kg** weighted by real weight; **sale after receipt** costed
per kilogram, and a later delivery never rewriting it; **return** giving back what
was charged and never more than the sale took, with the line's own cost recorded;
**exchange** of weighed goods; write-off and count correction leaving the average
alone; stock value; pieces staying simple; **zero, negative, fractional and
missing-cost receipts refused**; and **branch isolation** — a second branch starts
with no stock and no cost, receiving there moves only its own average, and
another workspace is refused.

**Not touched:** Clothing, Restaurant, Pharmacy. **Still open:** CI (audit Issue
10), N1 on the ordinary return path, the browser pass.
