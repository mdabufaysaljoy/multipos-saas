# Reporting the same thing

*Task 13 of `docs/UNIVERSAL_POS_PLAN.md`.*

Each vertical measures different things — VAT rates and dead stock in a shop, batches and expiry in a
pharmacy, tables and kitchen times in a restaurant — and those stay its own. What must not differ is
the **vocabulary for the money**, because an owner comparing two of their own workspaces has to be
comparing the same thing.

## 1. The contract

`server/src/services/reports/posMetrics.ts`:

| Field | Means |
|---|---|
| `grossSalesMinor` | what was charged |
| `returnAmountMinor` | what was given back |
| `netSalesMinor` | what was **kept**: gross less returns |
| `costMinor` | cost of what was sold, **less the cost of what came back** |
| `grossProfitMinor` | net less cost (and less VAT where the vertical collects it) |
| `marginBps` | profit as basis points of the revenue it was earned on |

Clothing has used these names since long before the other three existed. This is what the others
were brought into line with — no field was renamed, `grossSalesMinor` and `returnAmountMinor` were
added, and `netSalesMinor` now means what it says.

## 2. What was actually wrong

Task 08 gave Super Shop, Pharmacy and Restaurant real returns. Until now their reports summed what
was **charged** and called it net — a shop that refunded ৳100 of a ৳300 day still read ৳300, on both
the dashboard and Advanced Analytics. That was the one number in the platform a shopkeeper would
have argued with.

Now, in all three:

- **Dashboards** show what was kept under the takings: *"1 sale · ৳200.00 kept after ৳100.00 refunded"*.
- **Analytics** report gross, returns and net, and a **Returns card** lists what came back — the
  return number, the sale it was against, the reason, who took it, and how many units were refunded
  but *not* restocked.
- **Profit loses the returned goods' cost**, so a refunded item stops counting as both lost revenue
  and retained cost. The daily trend uses the same arithmetic as the totals, so a one-day period's
  row and its total agree — checked by a test, because that is exactly the kind of thing that drifts.

Per-line figures (best sellers, departments, VAT by rate) are still **before** discounts and returns,
and every one of them now says so.

## 3. Gaps closed and left

**Closed:** the Restaurant had taken split payments since task 04 but could not report them; it now
has the payment breakdown the other verticals have, cash net of the change handed back.

**Left:** staff performance (who sold what) exists in Clothing and in the Restaurant dashboard, but
not in Super Shop or Pharmacy analytics. Nothing depends on it, and no number is wrong without it.
