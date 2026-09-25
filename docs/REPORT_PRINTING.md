# Printing a report

Universal POS task 14. Every Advanced Analytics screen — Clothing, Super Shop, Pharmacy and
Restaurant — has a **Print / PDF** button that hands back the report on screen as a PDF.

## 1. Printing is not exporting

They look similar and are deliberately different things:

| | Data export | Print / PDF |
|---|---|---|
| What it hands over | rows of the underlying data (customers, products, sales…) | the report the user is already looking at |
| Formats | CSV, Excel, JSON, PDF | PDF only |
| Gate | `dataExport` entitlement (Professional and above) + `reports.export` | exactly what opened the report: `reports.view` + `advancedAnalytics` |
| Scope | Clothing (its dataset registry) | all four POS types |

That is the whole rule: **a print of what is on screen needs nothing more than the screen did.**
Asking a shop to buy Data export to print the page it is already reading would be a toll booth, not
a feature. Anything beyond the report — the rows behind it — stays where it was.

## 2. One writer

`services/reports/reportPrint.ts` builds the document and streams it through the export module's own
`writePdf`, so a printed report and an exported dataset are the same product: same header block
(workspace, branch, range, who printed it and when), same money handling (minor units divided once),
same date formatting in the business timezone, same page numbering, same formula-guarding.

The document is:

1. a **Summary** table — the figures the page shows as cards, in the order it shows them;
2. one table per section of the page, in the page's order.

A section with no rows is left out: a printed report should be what happened, not a list of empty
tables.

## 3. What each vertical prints

`services/reports/reportViews.ts` arranges each vertical's own analytics payload. Nothing is
recomputed — the numbers come from the same service call that answered the screen, so a printed
report cannot disagree with the page it was printed from.

| POS | Endpoint | Sections |
|---|---|---|
| Clothing | `GET /api/reports/print` | sales over time, best sellers, best variants, categories, payments, staff |
| Super Shop | `GET /api/supershop/reports/print` | daily sales, best sellers, departments, VAT by rate, busy hours, payments, returns, write-offs, dead stock |
| Pharmacy | `GET /api/pharmacy/reports/print` | daily sales, most dispensed, by form, payments, returns, expiry buckets, write-offs, slow movers |
| Restaurant | `GET /api/restaurant/reports/print` | best sellers, sections, payments, refunds, voided lines, discounts by staff |

Each takes the same range query the report itself takes (`preset`, or `from`/`to`), so the printed
document covers exactly the range on screen. The file is streamed, never stored: there is no
generated file at rest to protect or expire.
