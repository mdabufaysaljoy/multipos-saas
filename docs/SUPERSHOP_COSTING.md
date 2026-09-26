# Super Shop — stock valuation and profit

**Method: weighted average cost, per branch.** Not FIFO, not batch cost, not last
purchase price. This document is the specification; everything below is what the
code does today.

## The unit, first, because everything turns on it

A Super Shop product is sold one of two ways, and this is the single most
important thing to hold in mind when touching cost:

| `unitType` | `quantity` is | `priceMinor` / `costPriceMinor` is |
|---|---|---|
| `each` | a count of pieces | per piece |
| `weight` | **grams** (integer) | **per kilogram** |

So for weighed goods `price × quantity` is **a thousand times** the real figure.
The conversion lives in one function and must always be used:

```ts
lineAmount(unitPriceMinor, quantity, unitType)   // models/shopUnits.ts
  weight → Math.floor((unitPriceMinor * quantity + 500) / 1000)   // half-up
  each   → unitPriceMinor * quantity
```

Quantities are integers (grams), money is integer minor units. No float ever
touches either: a "0.5 kg" typed at the till becomes exactly 500 g by splitting
the string, never by `parseFloat`.

## Receiving: how the average moves

`supershopService.receiveStock` — one atomic MongoDB pipeline update per receipt,
upserted, with a duplicate-key retry so two first deliveries at once cannot race:

```
newCost = round( (onHand × oldCost + receivedQty × receivedCost)
                 / (onHand + receivedQty) )
```

`onHand` and `receivedQty` are in the product's base unit, and both costs are per
that unit, so the units cancel and the result stays "cost per piece" or "cost per
kilogram". The canonical case:

```
100 kg @ 100/kg  +  100 kg @ 120/kg  →  200 kg @ 110/kg
```

Two deliberate properties:

- **`onHand` is floored at zero.** Stock sold below zero (an authorised
  out-of-stock sale) contributes nothing to the average, because those units were
  already sold — the delivery that arrives after them sets the cost rather than
  being diluted by a negative. The quantity still adds the true balance.
- **A delivery never rewrites history.** A sale keeps the cost it was taken at;
  only future sales see the new average.

Rounding is MongoDB's `$round` (half to even) on an internal basis figure. Money
paid and charged is never rounded this way.

## Where the cost is read

| Event | Cost used |
|---|---|
| Sale | the average **at the moment stock is reserved**, extended by `lineAmount` and stored on the sale line as `costMinor` |
| Return | the cost the **sale** recorded, apportioned to the returned quantity, stored on the return line as `costMinor` |
| Exchange | the replacement is an ordinary sale, so the average at that moment; the returned goods behave exactly as a return |
| Void | quantity goes back; the average is untouched |
| Write-off | quantity goes out; the average is untouched |
| Count correction | quantity moves; the average is untouched, so found stock is valued at the current average |
| Restock of returned goods | quantity goes back at the **current** average — a simplification of weighted average, and the usual one |
| Inventory value | `lineAmount(costPriceMinor, quantityOnHand, unitType)` |
| Dead stock / write-off reports | the same `lineAmount` |

## Profit

```
gross profit = net sales − VAT − cost of goods sold
net sales    = charged − refunded
cost of goods sold = sale cost − cost of goods that came BACK and were restocked
```

Goods refunded but **not** restocked (damaged, opened) keep their cost against
the shop: they were paid for and are gone.

VAT is excluded from profit because it is collected for the government, and Super
Shop prices are VAT-**inclusive** — `vatMinor` is the tax contained in what was
charged, not added on top.

## The unit trap, and the seam that closes it

Two places got this wrong and were fixed on 2026-09-26. Both were in the
**shared** return engine, which sees a quantity and a unit price but has no idea
that one of its verticals measures in grams:

1. `refundFor` valued a refund at `unitPriceMinor × quantity` — so a weighed
   Super Shop return **refunded a thousand times the money taken**. 1 kg of rice
   sold for ৳200 refunded ৳200,000.
2. `posReturns.figures` valued returned cost the same way, inflating reported
   profit by the same factor.

The fix is a seam rather than a special case. `SaleReturnAdapter` gained two
optional methods:

```ts
amountOf?(line, quantity): number   // what these units SOLD for
costOf?(line, quantity): number     // what they COST
```

The engine's default is `price × quantity`, which is exactly right wherever a
quantity is a count of things — Pharmacy and Restaurant implement neither and are
unchanged. Super Shop implements both with the same `lineAmount` its checkout
charges by, so **a refund can never differ from what was taken.**

The return line now also stores `costMinor`, the extended cost, so reports read a
number instead of re-deriving one. Returns written before this fall back to
`quantity × costPriceMinorSnapshot` — correct for a count of things, and what
those rows have always reported.

> **If a Super Shop in production has already refunded weighed goods**, those
> `Return` rows hold the inflated figure and will keep reporting it through the
> fallback. Recomputing them is a migration this change does not attempt; the
> figures are recoverable from the sale lines if it is wanted.

## Rules for anyone touching this

1. Never write `price * quantity` for a Super Shop line. Use `lineAmount`.
2. Never re-derive a cost that was already recorded. The sale line and the return
   line both carry `costMinor`; read it.
3. Shared code must ask the adapter, not assume the unit.
4. Cost is per **branch**. `ShopStock` is keyed `(tenantId, storeId, productId)`,
   and two branches of one workspace hold independent averages.
