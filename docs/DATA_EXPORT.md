# Business Data Export

Scope: **Clothing, Restaurant, Pharmacy and Super Shop.** The server selects a vertical-specific,
field-allow-listed registry from the authenticated workspace. Starter is refused by the backend;
Professional and Enterprise are enabled by the `dataExport` entitlement.

---

## 1. Audit — what already existed

| Area | Finding |
|---|---|
| Subscription plans | `SubscriptionPlan` with `features` flags; codes `starter-store-*` (Starter), `showroom-*` (Professional), `brand-*` (Enterprise). |
| Entitlements | `config/entitlements.ts` maps stable keys to plan flags. **`dataExport` → `exportData` already existed** and was **not enforced anywhere**. |
| Gating middleware | `requireAccess({ entitlement, permission })` / `requireEntitlement` (`middleware/access.ts`), resolved per request from the database. |
| Tenant / branch scope | `resolveTenant` builds `ctx` (`tenantId`, `storeId`, `isAdmin`, `permissions`); reports use `storeScope(ctx, branch)` where `all` is admin-only. |
| Business models | Shared customers, returns and loyalty plus each POS type's catalogue, sales/orders, line items, payments, stock data and vertical-specific operational records. |
| Models that do **not** exist | Purchase/Purchase item and Expense. They are therefore not offered. |
| Payments | POS payments live **inside** `Sale.payments`; the `Payment` model is subscription/wallet billing, not POS. |
| Reports API | `reports.service.ts` with `resolveRange` (presets `today`…`custom`), `salesAndProfit`, `breakdown`, `inventoryReport`. |
| Export libraries | **None** (no CSV, XLSX or PDF). Added: `exceljs` (streaming workbook) and `pdfkit` (streaming PDF). |
| Uploaded files | `services/storage` local provider + tenant-scoped `StorageObject` ownership registry - built for product images, not temporary files. |
| Queue / workers | **None.** `jobs/subscription.job.ts` is an in-process hourly timer; there is no Redis or worker. |
| Rate limiting | Global `express-rate-limit` on `/api`, plus per-route limiters (e.g. `adminActionLimiter`). |
| Audit log | `AuditLog` + `recordAudit(req, …)`. |

**"ASX":** not defined anywhere in the codebase or product docs. Treated as a typo for **XLSX**, as instructed.

---

## 2. Entitlement and permissions (final behaviour)

| Plan | Data Export |
|---|---|
| Starter | **No** (`exportData: false`) |
| Professional | **Yes** |
| Enterprise | **Yes** — the platform's hierarchy already grants Enterprise everything Professional has (`exportData: true` in the plan seed). Preserved rather than artificially removed. |

The gate is the existing entitlement `dataExport`; no new subscription concept was introduced. The
pricing comparison reads the same plan flag, so the page and the backend can never disagree.

**Permission:** new `reports.export` ("Export data"), granted by default to the built-in **Store Manager**
role (tenant admins/owners hold every permission). Existing tenants get it through
`npm run migrate:export-permission -w server` (idempotent; never re-grants a permission an admin removed).
A staff member therefore needs **Professional/Enterprise + `reports.export`**.

The same gate protects every supported POS type. A workspace only sees datasets for its own vertical.

---

## 3. Exportable datasets (server-side registry)

The client may only name a key from this registry. There is **no** way to name a collection, model or
field from the request, so arbitrary database export is impossible.

| POS type | Datasets offered |
|---|---|
| Every POS | Customers, returns/exchanges, loyalty members and loyalty ledger (when the matching feature and read permission are available) |
| Clothing | Products and variants, categories, current inventory, stock movements, sales, sale items, sale payments and the existing sales report |
| Restaurant | Menu items, categories, dining tables, orders, order items, order payments, kitchen tickets, cash-drawer shifts and shift cash movements |
| Pharmacy | Medicines, categories, medicine batches/current inventory, stock movements, sales, sale items with batch allocations, sale payments and prescription records |
| Super Shop | Products, departments, brands, current inventory, stock movements, sales, sale items (including weight/VAT/cost) and sale payments |
| Clothing + Super Shop | Supplier contacts, terms and tax details (**never banking**), when Supplier Management is enabled |

A dataset is workspace- or branch-scoped to match the data itself. Catalogues, departments/categories,
brands and suppliers are workspace-level; branch-owned sales, orders, stock, tables and shifts follow
the branch rule below.

Never exported: users, passwords or hashes, tokens, sessions, API keys, provider credentials, platform
settings, other workspaces' data, or any collection outside this registry.

---

## 4. Formats

| Format | Library | Notes |
|---|---|---|
| CSV | hand-written writer | RFC 4180 escaping, UTF-8 **with BOM** (Excel opens Bengali correctly), `\r\n`, deterministic columns. |
| XLSX | `exceljs` streaming `WorkbookWriter` | Real workbook, header row, numbers as numbers, money as numbers with a `#,##0.00` format, frozen header, sized columns. Because the sheet is streamed, the frozen pane and column widths are declared before the rows. `sales-report` gets two sheets (Summary, Daily). |
| JSON | streamed by hand | `{ exportType, generatedAt, workspace, store, filters, columns, records: [...] }`, no circular data. |
| PDF | `pdfkit` streaming | A4 landscape report: store name, title, range, filter summary, repeated table headers, page numbers, truncated long text. Capped at 5,000 rows (a report format, not a database dump). |

**Spreadsheet formula injection:** any CSV/XLSX text cell starting with `= + - @`, tab or CR is prefixed
with an apostrophe, so names like `=cmd()` can never execute in Excel, Google Sheets or LibreOffice.
Phone numbers, SKUs and barcodes are written as text so leading zeros survive.

**Money:** minor units are converted once (`/100`) to a 2-decimal number; no floating-point arithmetic is
performed on the values.

**Dates:** filtering reuses `reports.resolveRange` (same presets and inclusive end-of-day as the reports
screen). Values are printed in the business timezone (`BUSINESS_TIMEZONE`, default Asia/Dhaka) as
`YYYY-MM-DD HH:mm`, with the timezone named in the file header/report so a spreadsheet is unambiguous.

---

## 5. Architecture

```
POST /api/exports            (Professional/Enterprise + reports.export)
   ↓ registry lookup (approved query + approved columns + transformer)
   ↓ Mongo cursor  →  batched rows  →  format writer  →  HTTP response stream
   ↓ ExportJob record: who, what, filters, rows, bytes, status (history + audit)
```

- **Streaming, not stored.** Files stream straight to the browser as the download. Nothing sensitive is
  written to disk or object storage, so there is no file to leak, no signed URL to guess and nothing to
  expire. This also avoids building a second queue: the project has none, and Redis/workers are not part
  of the stack.
- **Memory.** Rows are read with a Mongo cursor in batches of 500 and written out as they arrive. CSV,
  JSON and XLSX are all streamed; PDF is capped (below) because it must paginate.
- **Limits** (documented, configurable in `export.limits.ts`): 200,000 rows for CSV/JSON/XLSX, 5,000 rows
  for PDF, and 5 exports per minute per user (a dedicated `express-rate-limit`). Over the row cap the
  request is refused with a clear message suggesting a narrower date range.
- **History:** `GET /api/exports` lists recent `ExportJob` records (type, format, filters, rows, size,
  status, who, when). It stores **metadata only** - never exported rows. Re-running an export is a button,
  since files are not kept.
- **Audit:** every export writes an `AuditLog` entry (`data.exported`) with type, format, filters and row
  count.

---

## 6. Security

| Control | How |
|---|---|
| Entitlement | `requireAccess({ entitlement: 'dataExport' })` - server-side, per request, from the database. |
| Permission | `reports.export` in the same guard. |
| Tenant isolation | Every dataset query is built from `ctx.tenantId`; the request cannot carry a workspace id. |
| Branch isolation | `storeId` comes from `ctx`; `branch: all` is honoured only for tenant admins, exactly as reports do. Non-admins always get their own branch. |
| Registry | Only the vertical-aware keys above; unknown or wrong-vertical keys are refused. No collection/model/field names come from the client. |
| Per-dataset access | Each dataset declares its underlying read permission and optional feature entitlement. `reports.export` is never a side door into products, customers, stock, sales, returns, loyalty, suppliers or reports a role cannot otherwise read. Such datasets are hidden from `GET /datasets` and refused by the download. |
| Field allow-list | Each dataset lists its columns explicitly; documents are projected, never spread. |
| Secrets | Users, passwords, tokens and settings are not in the registry at all. |
| Injection | Spreadsheet formula prefixes neutralised; filters are typed and validated by zod. |
| Privacy | No file at rest, no customer data in URLs or logs (only counts and sizes are logged). |
| Rate limit | 5 exports/minute/user, plus the global API limiter. |
| Double-click | The button disables while the download runs. |

---

## 7. API

| Route | Purpose |
|---|---|
| `GET /api/exports/datasets` | The registry as the UI shows it (labels, descriptions, date support, formats). |
| `POST /api/exports` | Streams the file. Body: `{ type, format, preset/from/to, branch }`. |
| `GET /api/exports` | Recent export history for the workspace (paginated). |

All require: authenticated user → workspace/branch → usable subscription → `dataExport` entitlement →
`reports.export` permission.

---

## 8. Limitations

- **No background jobs.** Exports are synchronous. Very large exports are bounded by the row caps above
  rather than being queued; there is no queue in this stack.
- **No stored files**, so history has no download link; re-run instead. (Deliberate: nothing sensitive at rest.)
- **Purchases and expenses** are not exportable because those business models do not exist.
- **Temporary Super Shop held baskets** are not trade: they take no stock or payment and expire automatically, so they are not exported as sales.
- **PDF** is a report format, capped at 5,000 rows.
- **Dates** are formatted in one business timezone (not per user).
- **PDF text is Latin-only.** The built-in PDF fonts cannot draw Bengali glyphs, so Bengali names appear
  blank in a PDF (nothing is dropped from the data - CSV, XLSX and JSON keep it exactly). Use Excel or CSV
  for Bengali content; embedding a Unicode font would be the fix if PDF ever needs it.

---

## 9. Verified by the test suite

`scripts/smoke-test.mjs` covers Starter refusal and Professional catalogues/downloads for all four POS
types. The detailed Clothing export suite additionally verifies entitlement + history + run,
unauthenticated refusal, the registry, unknown type/format/range refusals, CSV (BOM, CRLF, Bengali,
formula neutralisation, money in major units, no secret columns), a complete readable XLSX workbook,
structured JSON, a real PDF, an empty dataset, `reports.export` permission (cashier vs manager), branch
isolation (including a manager asking for "all branches"), tenant isolation (including a forged workspace
id in the body), history and audit contents, downgrade to Starter and Enterprise keeping access.
