# Supplier management (Clothing POS)

Scope: **Clothing POS only.** Restaurant, Pharmacy and Super Shop are untouched — a Restaurant
workspace has no supplier module at all, whatever plan it is on.

Availability: **Professional and Enterprise.** Starter cannot reach the feature, its data or its API.

| Plan | Supplier management | Suppliers |
|---|---|---|
| Starter | ❌ | — |
| Professional | ✅ | 100 |
| Enterprise | ✅ | Unlimited |

Today this is a **contact management** feature: who you buy from, their people, their terms and their
tax details. Purchase orders, stock receiving, purchase history and payables are future modules; the
model is shaped so they can be added without rebuilding anything (see §11).

---

## 1. Ownership: workspace-level

A supplier belongs to the **workspace**, not a branch. A clothing business buys from the same
wholesalers for every shop it runs, so duplicating a supplier per branch would be busywork and would
make future purchase reporting lie.

- Every query is scoped by `tenantId` from the authenticated session. There is no `storeId` on a
  supplier and none is accepted from the client.
- Every branch of the workspace sees the same list, subject to the user's own permissions. A user who
  cannot reach a branch still cannot reach the API from it (`resolveTenant` refuses first).
- Another workspace's supplier is a **404**, never a peek: read, edit, status and delete all filter by
  `tenantId` before anything else.

Products, customers and categories stay branch-scoped — they are branch inventory and branch footfall.
A sourcing contact is neither.

---

## 2. Data model — `server/src/models/Supplier.ts`

| Field | Notes |
|---|---|
| `_id` | The stable identifier future purchase records will reference. Never a name. |
| `code` | `SUP-0001`, unique per workspace, **server-assigned** from an atomic counter. Never a database id, never accepted from the client. |
| `name` | Required, trimmed, ≤160. The only required field. |
| `type` | `manufacturer` · `wholesaler` · `distributor` · `importer` · `local` · `other` (default `other`). |
| `contact` | `{ name, designation, phone, altPhone, email }` — one primary contact person. |
| `phone`, `email`, `website` | Business contacts. The website is stored and displayed, **never fetched**. |
| `address` | `{ line1, line2, area, city, district, division, postalCode, country }` — comfortable for a Bangladeshi address, none of it required. |
| `taxNumber`, `tradeLicense` | Free text; no invented national validation algorithm. |
| `banking` | `{ accountName, accountNumber, bankName, branchName }` — protected, see §6. |
| `paymentTerms` | `cash` · `on_delivery` · `net_7` · `net_15` · `net_30` · `net_60` · `other`, plus a free-text `paymentTermsNote`. **Informational only** — nothing is calculated from it yet. |
| `notes` | Internal, ≤2000 characters. Never shown to a customer, never on a receipt. |
| `isActive` | Active by default. Inactive suppliers stay in the list and in search. |
| `deletedAt` | Soft delete, like every other record here. |
| `createdBy` / `updatedBy` / `createdAt` / `updatedAt` | The usual metadata. |

Indexes: `{tenantId, code}` unique among live rows; `{tenantId, deletedAt, isActive, name}` and
`{tenantId, deletedAt, createdAt}` for the list; single-field indexes on `name`, `phone`, `email`,
`contact.name` and `contact.phone` for search.

---

## 3. Entitlement and limit

- Feature: plan flag `supplierManagement` → entitlement key **`supplierManagement`** (Clothing only),
  enforced by `requireAccess({ entitlement: 'supplierManagement' })` on the router — so every route,
  including reads, is refused for Starter with `ENTITLEMENT_REQUIRED`.
- Limit: plan limit `maxSuppliers` → entitlement limit key **`suppliers`** (Starter 0, Professional
  100, Enterprise `-1` = unlimited). It counts **live, active** suppliers workspace-wide: deactivating
  one frees its slot, which is what makes "deactivate some or upgrade" a real remedy.
- Nothing anywhere branches on a plan name.

**Concurrency.** The pre-flight count is not atomic, so the create path repeats the check the way the
rest of the app does: after the insert it asks "how many active suppliers exist at or before mine?"
ObjectIds are monotonic, so racing requests get distinct, stable ordinals, exactly `max` of them are
inside the limit and the rest delete their own record and return the limit error. Verified by test:
four simultaneous creates against a 99/100 plan produce exactly one supplier and three refusals.

**Rate limiting.** The global `/api` limiter applies; creation also costs a counter increment and an
indexed insert, and the plan ceiling bounds the total.

---

## 4. Permissions

`suppliers.view` · `suppliers.create` · `suppliers.edit` · `suppliers.delete`, all four granted by
default to the built-in **Store Manager** role. Cashiers and Senior Cashiers get none. Tenant
admins/owners hold every permission.

Subscription and permission are independent gates: an Enterprise workspace still refuses a cashier, and
a Store Manager on Starter is still refused.

---

## 5. API — `/api/suppliers`

| Method | Path | Permission | Purpose |
|---|---|---|---|
| GET | `/summary` | `suppliers.view` | Counts, the plan ceiling and whether the workspace is over it |
| GET | `/` | `suppliers.view` | Paginated list: `page`, `limit`, `search`, `status`, `type`, `sort`, `order` |
| GET | `/:id` | `suppliers.view` | One supplier in full |
| POST | `/` | `suppliers.create` | Create (the server assigns the code) |
| PATCH | `/:id` | `suppliers.edit` | Edit in place — the identity and the `_id` never change |
| POST | `/:id/status` | `suppliers.edit` | Activate / deactivate |
| DELETE | `/:id` | `suppliers.delete` | Soft delete |

Chain on every route: authenticated → workspace + branch → Clothing → usable subscription →
`supplierManagement` entitlement → permission.

Search covers name, code, business phone, business email, contact name and contact phone, in the
database with indexes — never by loading the list into the browser. Filters: status and type. Sorting:
name, code, created, updated. Pagination is server-side for every plan; "unlimited" means no
subscription ceiling, not "fetch everything".

---

## 6. Sensitive information

Banking details are the only sensitive part of a supplier:

- the **list never returns them** (nor tax number, trade licence or notes — the projection is explicit);
- the **detail view returns them only** to a caller who may edit suppliers (`suppliers.edit`, or a
  tenant admin) — the people who set them in the first place;
- a user without that permission cannot see them and the form does not show or submit the block;
- they never appear in an audit-log entry, on a receipt, or in any customer-facing response.

Tax number and trade licence are ordinary business registration data and are returned on the detail
view to anyone who may view suppliers.

---

## 7. Status and deletion

- **Deactivate** is the normal retirement: the record stays, stays searchable (`status=inactive`) and
  frees a plan slot. Reactivating has to fit the ceiling again.
- **Delete** is a soft delete: `deletedAt` is set, the row leaves the list and the detail view 404s, and
  the code is freed for reuse. Nothing is erased, so a future purchase record that referenced the
  supplier can still resolve it.
- Nothing is ever hard-deleted by a user action. The only hard delete in the module is the create path
  undoing its own record when it loses a limit race.

---

## 8. Subscription changes — nothing is ever destroyed

| Change | Behaviour |
|---|---|
| Professional → Enterprise | The 100 suppliers stay; the ceiling lifts. No migration. |
| Enterprise → Professional (say 250 suppliers) | **Nothing is deleted.** All 250 remain readable, editable and searchable. `summary.overLimit` is true, the page explains the state, and creating another is refused until some are deactivated or the plan is upgraded. |
| Professional → Starter | The feature locks: every route returns 403. **The supplier data stays in the database untouched.** |
| Starter → Professional/Enterprise again | Everything is there, exactly as it was. |
| Expired / suspended / past due | The existing subscription rules apply through `requireSubscribedAccess`; no separate status system was invented. |

---

## 9. Audit log

`supplier.created`, `supplier.updated`, `supplier.deactivated`, `supplier.reactivated` and
`supplier.deleted`, each with the acting user, workspace, branch and the supplier's code and name. An
update logs the **names of the fields** that changed, never their values — so banking and tax numbers
are never copied into the log.

---

## 10. Exporting the supplier list

The **Export** button on the Suppliers page (Excel, CSV or PDF) goes through the ordinary Data export
API — the same registry, limits, history and audit trail as every other export (`docs/DATA_EXPORT.md`).

- The dataset is `suppliers`, and it is a **snapshot**: every supplier is included, active and inactive,
  with no date range to trim the older ones.
- It carries the code, name, type, contact person, business contacts, the full address, tax number,
  trade licence, payment terms and notes.
- **Banking details are never exported.** An export file travels — by email, by USB, into a shared
  drive — and account numbers should not travel with it. They stay on the supplier's detail view.
- Access is doubly gated: a caller needs the export feature (`dataExport` + `reports.export`) **and**
  supplier access (`supplierManagement` + `suppliers.view`). Someone who may export reports but not see
  suppliers is not even offered the dataset, and a direct request for it is refused.

Supplier **import** is still not built (§13).

---

## 11. Built for what comes next

- A supplier is referenced by its `_id`; the code is for humans.
- **No product relationship is baked in.** A garment may be bought from several suppliers over time, so
  that link belongs on a purchase record, not on the product and not on the supplier. Product import
  and product creation are unchanged and still need no supplier.
- Purchase orders, stock receiving, purchase history and payables can be added as their own modules
  referencing `supplierId`, with `paymentTerms` already recorded here.
- Supplier **import** is deliberately not built; the import column registry in `docs/PRODUCT_IMPORT.md`
  is where it would go. Export is done (§10).

---

## 12. Rollout

`npm run migrate:suppliers -w server` (also part of `npm run migrate`; idempotent):

1. sets `features.supplierManagement` and `limits.maxSuppliers` on plans that predate the feature
   (Starter off/0, Professional on/100, Enterprise on/unlimited);
2. backfills the same on subscription snapshots, so a paying workspace gets what it pays for and a
   Starter one stays out;
3. grants the four `suppliers.*` permissions to existing built-in Store Manager roles, once.

It is a tidy-up, not a prerequisite: a snapshot with no value for these keys is resolved from the plan
document at read time (`entitlement.service.ts`), so a Professional or Enterprise workspace has supplier
management whether or not the migration has run. A Starter plan still says no.

The page itself asks the server rather than trusting the session it was loaded with, so a workspace that
upgrades mid-session does not have to sign out and back in to see its suppliers.

---

## 13. Limitations

- Contact records only: no purchase orders, receiving, payments or payables yet.
- One primary contact person per supplier.
- No supplier **import** (export is covered in §10).
- No supplier ↔ product link (deliberate, see §11).
- Duplicate detection is the same name **plus** the same phone or email; two different companies with
  similar names are allowed, and so is the same name with different contact details.
- The supplier count is workspace-wide; there is no per-branch supplier quota.
