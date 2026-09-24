# Taking goods back

*Task 08 of `docs/UNIVERSAL_POS_PLAN.md` — first part.*

Super Shop and Pharmacy could only **void a whole sale**. They take a real return now: chosen lines,
chosen quantities, money back on a tender the branch takes, goods back where that vertical keeps
them. Clothing's own engine — which also does exchanges and loyalty — is untouched.

## 1. What a return does, in order

The order is what makes it safe without transactions:

1. **read** the sale and work out what may still come back
2. **hold** each quantity on its sale line — one atomic guarded update per line, so two clerks
   returning the last unit at the same instant cannot both succeed
3. **put the stock back** through the vertical's `InventoryAdapter.restore` (task 06)
4. **write the return**, then update the sale's returned totals

Anything that fails after step 2 releases the held quantities. A sale can never end up with goods
marked returned that were never refunded.

## 2. The refund is what was paid

A line refunds its own price **less its share of any discount the whole sale had**. A customer who
paid ৳270 for three ৳100 items gets ৳90 back for one of them, not ৳100. Integer arithmetic, rounded
down, so a refund can never come to more than was taken.

> Clothing's own engine refunds the line price without apportioning its sale discount. That is
> long-standing behaviour with its own tests and was not changed here; it is worth deciding on
> deliberately rather than by accident.

## 3. What each vertical does with the goods

| Vertical | Where the goods go | Notes |
|---|---|---|
| Super Shop | back on the branch's stock row | pieces or grams |
| Pharmacy | back to **the batch they were dispensed from** | a pharmacy may not mix batches; the return names them |
| Clothing | its own engine, unchanged | exchanges, loyalty reversal, partial returns |
| Restaurant | — | not yet; see below |

**"Put the goods back in stock" is a switch on the dialog.** Damaged, opened or expired goods are
refunded without being restocked, and the ledger shows nothing coming back because nothing did.

## 4. One collection

Returns of every vertical live in the one `Return` collection, told apart by `vertical`. Clothing's
returns predate the field, so the ones without it are Clothing's. The line shape gained `itemId` (the
variant, product or medicine) and optional `allocations` (the batches a pharmacy line went back to);
Clothing keeps writing exactly what it always wrote.

Each vertical lists its own at `GET /:module/returns`, and takes one at
`POST /:module/sales/:id/return` with `returns.create`.

## 5. Not done yet

**Restaurant.** A restaurant has no stock, so its return is money-only — a refund against a paid
order. The engine has nothing vertical-specific left to learn for it, but the order model has no
per-line returned quantity yet and the till has no screen for it.

**Clothing has not moved onto this engine.** It has exchanges, loyalty reversal and an idempotency
key that this one does not; folding them together is worth doing only once the simpler engine has
been in use.
