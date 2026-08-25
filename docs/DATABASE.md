# Database schema

MongoDB + Mongoose. 18 collections. Every tenant-owned document carries
`tenantId`, and everything a store owns also carries `storeId`.

## Conventions

| Topic | Rule |
|---|---|
| Money | Integer **minor units**, suffixed `…Minor` (`79000` = ৳790.00). Never a float. |
| Quantities | `Number.isSafeInteger`, validated at the schema level |
| Percentages | **Basis points** (`750` = 7.5%) so rates stay integers |
| Timestamps | `createdAt` / `updatedAt` via `{ timestamps: true }` |
| Soft delete | `deletedAt: Date \| null` — hard delete is never exposed |
| Snapshots | Fields ending `…Snapshot` are frozen copies, never refreshed |

---

## Relationships

```
Tenant ─┬─ Store ─┬─ Category ◄──────────┐
        │         │                      │ (categoryId, nullable)
        │         ├─ Product ────────────┘
        │         │     └─ ProductVariant        ← stock · price · SKU live HERE
        │         ├─ Customer
        │         ├─ Sale                        ← embeds SaleItem[]
        │         ├─ Return ── saleId ─► Sale    ← embeds ReturnItem[]
        │         ├─ InventoryTransaction        ← append-only ledger
        │         └─ Counter                     ← per-store invoice sequences
        │
        ├─ User ── roleId ─► Role
        ├─ RefreshToken
        └─ Subscription ─┬─ SubscriptionEvent
                         └─ Payment

SubscriptionPlan   global — pricing lives in the DB, never in code
Permission         mirror of the in-code catalogue, for joins and the UI
```

---

## Core tenancy

### `Tenant`
One workspace. `subscriptionStatus`, `currentSubscriptionId` and
`subscriptionEndsAt` are denormalised copies for cheap middleware checks; the
`Subscription` document remains authoritative.

| Field | Type | Notes |
|---|---|---|
| `name` `slug` | String | `slug` unique platform-wide |
| `ownerUserId` | ObjectId → User | |
| `status` | `active` \| `suspended` | Suspension blocks every request from the workspace |
| `subscriptionStatus` | String | Denormalised cache |
| `contactEmail` `contactPhone` `country` | String | |
| `suspendedAt` `suspendedReason` | Date / String | |

**Indexes** `{ slug } unique` · `{ status }` · `{ subscriptionStatus }`

### `Store`
A physical shop. The schema is store-scoped throughout, so multi-branch is a
plan-limit change rather than a migration.

| Field | Type | Notes |
|---|---|---|
| `tenantId` | ObjectId | |
| `name` `code` | String | `code` unique per tenant |
| `logoUrl` `phone` `email` `address` | String | Printed on receipts |
| `currency` | String(3) | |
| `invoicePrefix` `returnPrefix` | String | e.g. `INV-` → `INV-000001` |
| `receipt` | Subdoc | `headerText` `footerText` `returnPolicy` `showLogo` `showCashier` `paperWidthMm` (58 \| 80) |
| `tax` | Subdoc | `enabled` `label` `rateBasisPoints` `inclusive` |
| `paymentMethods` | String[] | Tenders the POS offers |
| `lowStockThreshold` | Number | Default for new variants |
| `isActive` `isDefault` | Boolean | |

**Indexes** `{ tenantId }` · `{ tenantId, code } unique`

### `Counter`
Atomic per-store sequences. `findOneAndUpdate` + `$inc` + `upsert` is a
single-document operation, so an invoice number is never handed out twice.

**Indexes** `{ tenantId, storeId, key } unique`

---

## Identity and access

### `User`
`tenantId` is `null` for platform administrators, who live in their own global
namespace.

| Field | Type | Notes |
|---|---|---|
| `tenantId` | ObjectId \| null | null ⇒ platform admin |
| `storeId` | ObjectId \| null | Default store |
| `name` `email` `phone` | String | |
| `passwordHash` | String | bcrypt, `select: false` |
| `role` | `platform_admin` \| `admin` \| `staff` | |
| `roleId` | ObjectId → Role | Baseline permissions |
| `extraPermissions` | String[] | Granted on top of the role |
| `deniedPermissions` | String[] | **Beats** the role |
| `isActive` `lastLoginAt` `deletedAt` | | |
| `permissionVersion` | Number | Bumped when access changes |

**Indexes** `{ tenantId, email } unique` · `{ role }` · `{ tenantId, isActive, deletedAt }`

> Effective set = `(role.permissions ∪ extraPermissions) − deniedPermissions`.
> Admins bypass entirely. Resolved from the **database** on every request — the
> token only carries an id, so an edited payload escalates nothing.

### `Role`
`{ tenantId, name, description, permissions[], isSystem, isActive }`.
System roles (Cashier, Senior Cashier, Store Manager) ship with each tenant and
cannot be deleted, though their permissions stay editable.

**Indexes** `{ tenantId }` · `{ tenantId, name } unique`

### `Permission`
Read-only mirror of `config/permissions.ts` — `{ key, group, label, description }`.
Code remains the source of truth. **Indexes** `{ key } unique` · `{ group }`

### `RefreshToken`
One row per issued session, stored as a SHA-256 digest and rotated on use.

| Field | Notes |
|---|---|
| `userId` `tenantId` | |
| `jti` | Unique token id |
| `tokenHash` | Digest — a DB leak cannot mint sessions |
| `expiresAt` | **TTL index**, expired rows self-delete |
| `revokedAt` `replacedByJti` | Replay detection: reusing a revoked token kills the family |
| `userAgent` `ip` | |

**Indexes** `{ jti } unique` · `{ userId }` · `{ expiresAt } expireAfterSeconds: 0`

---

## Catalogue

### `Category`
`{ tenantId, storeId, name, slug, description, parentId, isActive, deletedAt }`

**Indexes** `{ tenantId, storeId, slug } unique` *(partial: `deletedAt: null`)* —
so a deleted name can be reused · `{ tenantId, storeId, deletedAt, isActive }`

### `Product`
The catalogue entry. It holds **no price and no stock** — those belong to
variants.

| Field | Type | Notes |
|---|---|---|
| `name` `sku` | String | `sku` is the base; sellable SKUs are on variants |
| `categoryId` | ObjectId \| null | |
| `categoryNameSnapshot` | String | Kept for display after a category is removed |
| `description` `brand` | String | |
| `images` | `[{ url, key, isPrimary }]` | |
| `options` | `[{ name, values[] }]` | e.g. Color / Size axes |
| `hasVariants` `isActive` `deletedAt` | | |
| `createdBy` `updatedBy` | ObjectId → User | |

**Indexes** `{ tenantId, storeId, sku } unique` *(partial)* ·
`{ tenantId, storeId, deletedAt, isActive }` · `{ tenantId, storeId, categoryId }` ·
text index on `name, brand, sku`

### `ProductVariant`
**The sellable unit.** Every product has at least one — products without options
get a `Default` variant, giving POS, inventory, sales and returns a single
uniform code path.

| Field | Type | Notes |
|---|---|---|
| `productId` | ObjectId | |
| `productNameSnapshot` | String | Denormalised for fast POS search |
| `name` | String | `"Black / M"` |
| `attributes` | `[{ name, value }]` | |
| `sku` `barcode` | String | |
| `sellingPriceMinor` `costPriceMinor` | Number | Integer-validated |
| `stock` | Number | **`min: 0`** + integer-validated |
| `lowStockThreshold` | Number | |
| `isActive` `deletedAt` | | |

**Indexes** `{ tenantId, storeId, sku } unique` *(partial)* ·
`{ tenantId, storeId, barcode } sparse` · `{ tenantId, productId, deletedAt }` ·
`{ tenantId, storeId, isActive, deletedAt }`

> Stock is only ever mutated by `inventoryService`, via an atomic conditional
> update. Nothing else writes the field.

### `Customer`
`{ tenantId, storeId, name, phone, email, address, notes, totalSpentMinor,
orderCount, lastPurchaseAt, isActive, deletedAt }`

**Indexes** `{ tenantId, storeId, phone } unique` *(partial)* ·
`{ tenantId, storeId, name }`

---

## Transactions

### `Sale` — embeds `SaleItem[]`

| Field | Type | Notes |
|---|---|---|
| `saleNumber` | String | From `Counter` |
| `cashierId` / `cashierNameSnapshot` | | |
| `customerId` / `customerSnapshot` | nullable | **Optional** — walk-in sales are first class |
| `items` | `SaleItem[]` | Embedded, below |
| `subtotalMinor` `discountMinor` `taxMinor` `totalMinor` | Number | Computed **server-side** |
| `discountType` `discountValue` | | `fixed` = minor units, `percent` = basis points |
| `paidMinor` `changeMinor` | Number | |
| `paymentMethod` `payments[]` `paymentStatus` | | |
| `status` | `completed` \| `cancelled` | |
| `returnedTotalMinor` `fullyReturned` | | Roll-ups maintained by the return flow |
| `soldAt` | Date | Business timestamp, distinct from `createdAt` |

#### `SaleItem` (embedded subdocument)

Everything needed to render the line is **snapshotted here**. Nothing joins to
the live `Product` or `ProductVariant`, which is precisely what makes history
immune to later catalogue edits and deletions.

| Field | Notes |
|---|---|
| `productId` `variantId` | For analytics grouping only |
| `productNameSnapshot` `variantNameSnapshot` `skuSnapshot` `brandSnapshot` | Frozen |
| `categoryId` `categoryNameSnapshot` | Frozen |
| `unitPriceMinor` | **The price actually charged.** `min: 1` |
| `listPriceMinor` | Catalogue price at the time, for override reporting |
| `costPriceMinorSnapshot` | Frozen, for margin reporting |
| `quantity` | `min: 1`, integer-validated |
| `lineTotalMinor` `lineDiscountMinor` | |
| `returnedQuantity` | Incremented atomically as returns are processed |

**Indexes** `{ tenantId, storeId, saleNumber } unique` ·
`{ tenantId, storeId, soldAt: -1, status }` *(primary reporting index)* ·
`{ tenantId, storeId, cashierId, soldAt: -1 }` ·
`{ tenantId, storeId, customerId, soldAt: -1 }` ·
`{ tenantId, 'customerSnapshot.phone' }`

### `Return` — embeds `ReturnItem[]`

`saleId` is **required**: there is no standalone return anywhere in the schema
or the API.

| Field | Notes |
|---|---|
| `returnNumber` | From `Counter` |
| `saleId` `saleNumberSnapshot` | |
| `items[]` | `saleItemId` → the exact original line, plus the same snapshots |
| `items[].unitPriceMinor` | Always the **historical** price, never today's |
| `items[].restock` | Per-line — damaged goods can be refunded without re-shelving |
| `totalMinor` `reason` `refundMethod` | |
| `processedBy` `processedByNameSnapshot` `returnedAt` | |

**Indexes** `{ tenantId, storeId, returnNumber } unique` · `{ saleId }` ·
`{ tenantId, storeId, returnedAt: -1 }`

> **The excess-return guarantee.** Quantities are reserved with a conditional
> update on the sale line — `items.$.returnedQuantity ≤ sold − qty` — before any
> stock moves. Two clerks returning the last unit simultaneously cannot both
> succeed: the second matches zero documents and is rejected.

### `InventoryTransaction`
Append-only ledger. Current stock lives on the variant for speed, but every
change is recorded here so it can be audited and reconstructed.

| Field | Notes |
|---|---|
| `productId` `variantId` + name/SKU snapshots | |
| `type` | `INITIAL_STOCK` · `PURCHASE` · `SALE` · `RETURN` · `MANUAL_ADJUSTMENT` · `SALE_CANCELLED` |
| `quantityChange` | Signed integer |
| `previousStock` `newStock` | Read from the update's pre-image, so no interleaving writer can corrupt it |
| `reason` `referenceType` `referenceId` `referenceNumber` | Links to the sale/return |
| `performedBy` `performedByNameSnapshot` | |

**Indexes** `{ tenantId, storeId, createdAt: -1 }` ·
`{ tenantId, variantId, createdAt: -1 }` · `{ tenantId, referenceId }`

---

## Billing

### `SubscriptionPlan` (global)
Pricing is data, not code.

`{ code, name, description, interval: monthly|yearly, priceMinor, currency,
trialDays, features{}, limits{}, isActive, isPublic, sortOrder }`

- **features** — `salesReports` `advancedReports` `customerManagement`
  `inventoryLedger` `multiStore` `customRoles` `exportData` `prioritySupport`
- **limits** — `maxStaff` `maxProducts` `maxStores` `maxMonthlySales`; **`-1` = unlimited**

**Indexes** `{ code } unique` · `{ interval, isActive, sortOrder }`

### `Subscription`
`planSnapshot` freezes the plan's price, features and limits, so changing a plan
never rewrites a period a customer has already paid for.

| Field | Notes |
|---|---|
| `planId` / `planSnapshot` | Frozen copy |
| `status` | `trial` · `active` · `past_due` · `cancelled` · `expired` · `suspended` |
| `startedAt` `currentPeriodStart` `currentPeriodEnd` `trialEndsAt` | |
| `cancelAtPeriodEnd` `cancelledAt` | Cancel stops the **next** renewal; access runs to period end |
| `autoRenew` `provider` `providerSubscriptionId` | |
| `lastPaymentId` `failedPaymentCount` | Three failures ⇒ expired |
| `isManual` `activatedBy` `notes` | Manual activation by a platform admin |

**Indexes** `{ tenantId }` · `{ status }` · `{ currentPeriodEnd }` ·
`{ tenantId, createdAt: -1 }` · `{ status, currentPeriodEnd, autoRenew }` *(renewal job)*

### `SubscriptionEvent`
Append-only audit trail powering the history screen:
`created · activated · extended · plan_changed · renewed · renewal_failed ·
cancelled · reactivated · expired · suspended · deactivated`

**Indexes** `{ tenantId, createdAt: -1 }` · `{ subscriptionId }`

### `Payment`
`{ tenantId, userId, subscriptionId, planId, amountMinor, currency, provider,
providerTransactionId, providerReference, status, failureReason, paidAt,
refundedAt, idempotencyKey, metadata }`

Statuses: `pending` · `paid` · `failed` · `cancelled` · `refunded`

**Indexes** `{ provider, providerTransactionId } unique sparse` and
`{ idempotencyKey } unique sparse` — together these make a redelivered webhook a
no-op rather than a double charge · `{ tenantId, createdAt: -1 }` · `{ status }`

---

## Index rationale

Indexes were chosen for the queries the app actually issues, and nothing more.

| Index | Serves |
|---|---|
| `{ tenantId, … }` leading on every collection | Tenant isolation — the filter on every query |
| `Sale { tenantId, storeId, soldAt: -1, status }` | Dashboard ranges and sales history, including multi-year |
| `ProductVariant { tenantId, storeId, isActive, deletedAt }` | POS search |
| `ProductVariant { …, barcode } sparse` | Scanner lookup; sparse because most variants have none |
| Partial unique on `sku` / `slug` / `phone` | Uniqueness among **live** records, so soft-deleted values are reusable |
| `RefreshToken { expiresAt } TTL` | Sessions clean themselves up |
| `Payment { provider, providerTransactionId } sparse unique` | Webhook idempotency |
| Text index on `Product` | Catalogue search |

Deliberately **not** indexed: low-cardinality booleans on their own, and fields
only ever read as part of an already-indexed compound query.
