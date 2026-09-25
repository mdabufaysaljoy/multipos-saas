# Stock, through one seam

*Task 06 of `docs/UNIVERSAL_POS_PLAN.md`.*

Four POS types keep stock four different ways, and all four are right:

| Vertical | Where stock lives | Rules that must survive |
|---|---|---|
| Clothing | a number on the variant | may go **below zero**, but only for a till with `sales.sellOutOfStock`, and the row says so |
| Pharmacy | `MedicineBatch` rows | earliest expiry first, **never expired**, never negative; a unit goes back to the batch it came from |
| Super Shop | one `ShopStock` row per product per branch | never negative; pieces or grams |
| Restaurant | nowhere | a kitchen cooks to order; there is nothing to count |

Shared features — returns, out-of-stock overrides, imports — need to move stock without knowing any
of that. `server/src/services/inventory/adapter.ts` is where they ask.

## 1. The interface

```ts
reserve(ctx, { itemId, quantity, label, allowOutOfStock? })  → Reservation
release(ctx, reservations)                                    // sale abandoned
commit(ctx, reservations, ref)                                // sale completed
restore(ctx, reservations, ref)                               // completed sale coming back
describe(ctx, itemId)                                         // label + what is on hand
```

**`release` vs `restore` is the distinction worth keeping.** `release` puts stock back for a sale
that never happened and writes **no ledger row** — as far as the branch is concerned nothing
occurred. `restore` puts it back after a sale that *did* happen (a void, a return) and **does** write
one, because that is a real movement staff must be able to see.

A `Reservation` carries `itemId`, `quantity`, `balanceAfter` and a `detail` that belongs to the
vertical alone: Pharmacy puts the batches it drew from there (with cost and expiry — the dispensing
record the receipt prints), Super Shop the weighted average cost at the moment of the take, Clothing
its own movement record. **Shared code reads the four common fields and never opens `detail`**, which
is why `inventoryAdapterFor(vertical)` hands back an adapter whose detail type is `never`.

## 2. What each adapter owns

The sale path of every vertical now goes through its adapter — this is not an interface waiting for a
user:

- `adapters/clothing.adapter.ts` delegates to `inventoryService`, which stays the single implementation
  of Clothing's stock. It is the one vertical that writes its ledger row **as** the stock moves (the row
  carries the out-of-stock flag), so `commit` stamps the invoice number onto rows that already exist.
- `adapters/pharmacy.adapter.ts` owns the FEFO allocator, the put-back and the per-batch movement rows.
- `adapters/supershop.adapter.ts` owns the guarded `$inc` take, the put-back and the movement rows.
- `adapters/restaurant.adapter.ts` is a no-op that answers honestly: `tracksStock` is `false`, and
  `describe` reports `onHand: null`. Inventing a shelf to satisfy the interface would be worse.

Receiving stock, manual adjustments, write-offs and low-stock queries are **catalogue** work and stay
in each module. The adapter is only about a line being sold and coming back.

## 3. One ledger read

`GET /stock-ledger` is mounted by all four modules — `/inventory`, `/supershop`, `/pharmacy`,
`/restaurant` — takes the same query (`itemId`, `type`, `from`, `to`, page, limit) and answers in one
shape:

```
id · at · itemId · itemLabel · itemDetail · type
quantityChange (signed) · balanceBefore · balanceAfter
reason · referenceType · referenceId · referenceNumber · by
```

`itemDetail` is where each vertical keeps its own second line: a SKU, `Batch NP-OLD`, `by weight`.
A restaurant answers with an empty page rather than an error, because "nothing moved" is the true
answer there. Storage is untouched — three ledgers, three schemas, read through one function.

**Existing endpoints are unchanged.** `/inventory/ledger`, `/supershop/movements` and
`/pharmacy/movements` still return exactly what they did, because their screens read those fields.
The universal route is additive; the client screen that would use it does not exist yet.

## 4. Selling what the system says is gone

*Task 07.* `sales.sellOutOfStock` used to mean something in Clothing only. It now means the same
thing in Super Shop and Pharmacy, through the `allowOutOfStock` flag on a stock request — decided by
the caller from the permissions resolved for that request, never from anything the client sends, so a
revoked grant stops working on the very next sale.

**The rule is deliberately narrow, and the same everywhere: it covers "there is none of this", never
"there is not enough".** A product with 3 on hand cannot be sold 5 by anyone; a product at zero can
be sold by a till that holds the permission. A partial shortfall is a counting error to fix, not
something to sell through.

| Vertical | What the override does | What it will not do |
|---|---|---|
| Clothing | variant goes below zero | cover a partial shortfall |
| Super Shop | the branch's stock row goes below zero | cover a partial shortfall; sell a product **never received into this branch** (no stock row, no cost basis — a different problem from running out) |
| Pharmacy | the latest-expiring **unexpired** batch goes below zero | touch an **expired** batch, ever; sell where there is **no unexpired batch at all**, because the batch number and expiry are the dispensing record and there would be nothing truthful to print |
| Restaurant | nothing — there is no stock to override | — |

Both the sale line and the ledger row are flagged (`outOfStockOverride`), and the ledger reason reads
`… (out-of-stock sale)`, exactly as Clothing has always recorded it. Negative stock is a debt the
branch owes: it shows in the till, in low-stock lists and in the ledger, and the next delivery pays
it off before anything is sellable again. Stock valuations exclude it — a negative row must never
cancel out another product's value.

**What this deliberately weakened:** before, no Super Shop or Pharmacy stock could go below zero
under any circumstances, and their concurrency tests said so. A till with the permission can now take
the last unit twice. That is the same trade Clothing has always made, and the suite now proves both
halves: unprivileged tills still race safely to exactly zero, and privileged ones go negative on
purpose.

## 5. What is still to come

Task 08 builds the return engine on `restore` — Clothing's return path still calls
`inventoryService.increase` directly, and moving it is that task's job, not this one's.

## The Super Shop inventory screen

The first client of `/stock-ledger` is the Super Shop **Inventory** screen (`/shop-inventory`):

- **Stock** — every product with what is on hand, its average cost and what that is worth, with
  Receive and Adjust (the same dialogs the catalogue uses, shared in
  `client/src/features/supershop/stockDialogs.tsx` so the two screens cannot drift apart).
- **Stock ledger** — the shared ledger, filtered by movement type. Append-only, and the screen says
  so: nothing here can be edited.

Above both, `GET /supershop/inventory-summary` answers what the branch holds: stock value at
weighted average cost, the same stock at shelf price, and how many products are low or out. It is
counted from the catalogue, not from the stock rows, so a product that has never been received still
counts as out of stock. Weighed goods hold a cost per kilogram against a quantity in grams, so their
value is divided by 1,000; stock below zero (an authorised out-of-stock sale) is worth nothing
rather than cancelling another product out.
