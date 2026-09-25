# Taking goods back

*Task 08 of `docs/UNIVERSAL_POS_PLAN.md`.*

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
| Restaurant | **nowhere** | the kitchen cooked it and it is gone: a refund is money and a record |

**"Put the goods back in stock" is a switch on the dialog.** Damaged, opened or expired goods are
refunded without being restocked, and the ledger shows nothing coming back because nothing did.

## 4. One collection

Returns of every vertical live in the one `Return` collection, told apart by `vertical`. Clothing's
returns predate the field, so the ones without it are Clothing's. The line shape gained `itemId` (the
variant, product or medicine) and optional `allocations` (the batches a pharmacy line went back to);
Clothing keeps writing exactly what it always wrote.

Each vertical lists its own at `GET /:module/returns`, and takes one at
`POST /:module/sales/:id/return` with `returns.create`.

## 5. A restaurant refunds money, not goods

Only a **paid** order can be refunded. An open one is changed or cancelled instead, which already
exists and is a different thing. Voided lines cannot be refunded either — they were never charged
for.

Nothing restocks, and that falls out of the no-op inventory adapter rather than a special case in
the engine: `restore` on a restaurant does nothing, so the refund is money and a record. The dialog
drops the "put the goods back in stock" switch, because it would be a question with one answer. A
refunded order stays `paid` and carries `returnedTotalMinor`; it is not reopened.

## 6. Not done yet

**Clothing has not moved onto this engine.** It has exchanges, loyalty reversal and an idempotency
key that this one does not; folding them together is worth doing only once the simpler engine has
been in use.

**Analytics still report gross takings.** A refund is recorded on the sale and in the returns list,
but the Super Shop, Pharmacy and Restaurant dashboards and analytics still sum what was charged, not
what was kept. Clothing's reports do subtract returns. Bringing the other three into line belongs
with task 13 (analytics parity), and is the first thing to do there.

## The Returns screen

Taking something back used to be reachable only from inside a sale, which meant knowing which sale
it was before you could start. Every vertical now has a screen of its own, all of them one shared
component (`client/src/features/returns/PosReturnsScreen.tsx`):

| POS | Path | Called |
|---|---|---|
| Clothing | `/returns` | Returns (its own screen, with exchanges) |
| Super Shop | `/shop-returns` | Returns |
| Pharmacy | `/pharmacy-returns` | Returns |
| Restaurant | `/refunds` | Refunds — money only, nothing restocks |

The screen lists what has come back, and starts a new one the way the engine requires: find the sale
first, then choose the lines. The vertical supplies its own endpoints and says how to read one of
its sales (its number, its date, its second line and its returnable lines); the behaviour is the
same everywhere because it is the same engine underneath.

A Super Shop sale can now also be found by the customer who bought it, not only by its number or an
item on it — the first thing a shopkeeper knows is usually the person standing in front of them.
