# Repository audit — `multipos-saas`

**Date:** 2026-09-24 · **Commit:** `bd7123d` (branch `claude/inspiring-franklin-wsguj1`, even with `origin/main`)
**Scope:** whole repository — architecture, security, correctness, tooling, docs.

## Verdict

This is a well-built codebase. ~78k lines of TypeScript across a server and a
client, strict typing throughout, and — unusually — the hard parts are the parts
that are done right: tenant isolation, money arithmetic, idempotency on the
billing path, and refresh-token rotation with reuse detection. Typecheck, lint
and build all pass clean from a fresh `npm ci`.

The gaps are not in the core engine. They are in **supply-chain currency**
(a high-severity `nodemailer` advisory), **secrets at rest**, **documentation
drift** (three of the four POS verticals are undocumented), and **duplicated
checkout logic across verticals** — with a functional consequence: store-level
tax settings only take effect in the Clothing vertical.

| Area | Assessment |
|---|---|
| Multi-tenant isolation | Strong |
| Authentication & sessions | Strong |
| Money & billing correctness | Strong |
| Concurrency & idempotency | Strong |
| Dependency hygiene | **Needs work** |
| Secrets at rest | **Needs work** |
| Documentation accuracy | **Needs work** |
| Test strategy | Good coverage, fragile shape |
| Observability | Thin |

---

## Verified during this audit

Run from a clean `npm ci` (dependencies were not installed in the container; an
earlier `typecheck` failure reporting `TS2688: Cannot find type definition file
for 'node'` was that, not a real defect):

```
npm run typecheck   →  clean (server + client)
npm run lint        →  clean
npm run build       →  clean (server tsc, client vite)
npm test            →  NOT RUN — needs MongoDB; no mongod and no docker daemon
                       in this container
```

So every finding below is from reading code and running static tooling. The
end-to-end suite was not executed.

---

## What is genuinely good

Worth stating explicitly, because these are the things most codebases of this
shape get wrong.

**Tenant isolation is structurally enforced, not enforced by convention.**
`resolveTenant` (`server/src/middleware/tenant.ts`) is the only place a
`tenantId` enters the request lifecycle, and it comes from the authenticated
user record — never a header, query or body. The `x-store-id` branch header is
accepted but re-validated twice: the branch must belong to the tenant, *and*
the user must be assigned to it. Permissions are re-read from the database on
every request (`middleware/auth.ts`); the JWT carries only an id, so a forged
payload cannot escalate.

**Money is integer minor units everywhere.** A scan for float arithmetic on
monetary values found only display-time `/100` formatting. No model stores a
non-minor money field.

**The billing path is idempotent under concurrency.** Renewals claim work with
a compare-and-swap on `lastRenewalAttemptAt` and then check a period-scoped
`idempotencyKey` on `PaymentModel` (`services/subscription/walletRenewal.service.ts`).
Invoices carry a unique index on `paymentId`. Emails are lease-claimed via
`claimedUntil`. Sales use an idempotency key plus compensating inventory writes
for the standalone-MongoDB case where transactions are unavailable.

**Session handling is correct.** Refresh tokens rotate; presenting a revoked
token kills the whole family. The refresh token lives in an `httpOnly`,
`secure`, `sameSite: strict` cookie in production.

**Uploads are validated by content, not by the declared MIME type** — the bytes
are inspected before the file is accepted, and quota is checked against the
final optimised size with rollback if a concurrent upload pushes the workspace
over.

**The error handler never leaks internals in production**, and duplicate-key
errors are translated without exposing raw index names.

---

## Findings

### High

**H1 — `nodemailer` 6.x carries 12 known advisories, including SMTP command
injection and recipient-domain bypass.**
`server/package.json` pins `nodemailer ^6.10.1`; the fix is `10.x`, a breaking
change. The relevant ones for this app are the CRLF/`envelope` injection issues
and the IDN/punycode and RFC-5322-comment domain-validation bypasses, which can
send mail to an attacker-controlled domain. This app sends invoices, renewal
notices and marketing campaigns with recipient addresses that originate from
tenant input, so the domain-validation bypasses are reachable.
*Action:* upgrade to `nodemailer@10`, then re-test
`services/email/providers/smtp.provider.ts` and the campaign path.

### Medium

**M2 — Integration secrets are stored in plaintext in MongoDB.**
`models/PlatformSettings.ts` holds the SMTP password and the SMS gateway API key
as plain strings. `select: false` keeps them out of ordinary queries — which is
good hygiene and clearly deliberate — but it is not encryption: anyone with a
database dump, a backup file, or read access to the collection has the
credentials. Encrypt at rest with a key from the environment (or move these two
fields to env vars entirely, as the payment credentials already are).

**M3 — `qs` / `express` / `morgan` / `react-router` advisories.**
Six moderate findings, all fixable. `npm audit fix` clears the `qs` (DoS,
array-limit bypass, reached via `express` and `body-parser`) and `morgan`
(log forging) ones without breaking changes. `react-router` 6.x has an open
redirect via backslash in `<Link>`/`useNavigate` plus an SSR hydration issue;
the fix is `react-router-dom@7`, a major upgrade — schedule it rather than
rushing it, since this app is client-rendered and the SSR issue does not apply.

**M4 — The access token lives in `localStorage`.**
`client/src/api/client.ts`. Any XSS reads it directly. The 15-minute TTL and the
`httpOnly` refresh cookie limit the blast radius, and there is exactly one
`dangerouslySetInnerHTML` in the codebase (sanitised through DOMPurify), so
this is defence-in-depth rather than a live hole. Worth revisiting if you ever
move to in-memory token storage.

**M5 — Store tax settings are silently ignored in three of four verticals.**
`StoreModel.tax` (`enabled`, `label`, `rateBasisPoints`, `inclusive`) is applied
only by the Clothing checkout. Restaurant computes `total = subtotal - discount`
(`restaurant.service.ts:525`), as do Pharmacy (`:316`) and Supershop (`:265`).
Restaurant even selects `tax` for its print payload but never uses it. A
merchant who configures VAT on a Restaurant, Pharmacy or Supershop workspace
will undercharge every sale with no warning anywhere in the UI. Either apply
tax in those verticals or hide the setting for them — the current state is the
worst of both.

**M6 — Checkout logic is copy-pasted across the verticals.**
The discount-permission check, accepted-payment-method check, shortfall
calculation and its error message are character-for-character identical in
`restaurant.service.ts:517-529`, `pharmacy.service.ts:308-320` and
`supershop.service.ts:258-268`. M5 is the direct consequence: the Clothing
implementation grew a tax step and the three copies did not. Extract a shared
`settleTender(ctx, { subtotalMinor, discountMinor, payments, store })` helper.

### Low

**L7 — Background jobs have no leader election.**
`startSubscriptionJobs()` runs `setInterval` in-process (`server/src/server.ts`).
Run two instances and both sweep. The money paths are safe — renewals CAS-claim,
invoices are unique on `paymentId`, emails lease — so this is duplicated load
and duplicated log noise rather than double billing. It becomes a real problem
the moment a new job is added without that discipline. Either add a lease on a
`jobs` collection or move the sweeps to an external scheduler.

**L8 — Payment and SMS credentials bypass the env schema.**
`config/env.ts` validates everything with Zod and fails fast — except the
eighteen `process.env.*` reads scattered through
`services/payment/registry.ts`, the provider files and
`services/sms/providers/alpha.provider.ts`. A typo'd `BKASH_APP_SECRET` in
production does not fail at boot; it fails at the first customer payment.
Fold these into the schema as optional fields. (`.env.example` does document
them all — only `QZ_*` and `INVOICE_ISSUER_*` are missing from it.)

**L9 — `client/tsconfig.tsbuildinfo` is tracked despite `.gitignore`.**
`.gitignore` lists `*.tsbuildinfo`, but the file was committed before that rule
existed, so the rule does not apply to it. Every build leaves the working tree
dirty. `git rm --cached client/tsconfig.tsbuildinfo` fixes it. Same for
`.claude/launch.json`, tracked while `.claude` is ignored — harmless, but decide
which you meant.

**L10 — Logging is `console.*` with no structure.**
`utils/logger.ts` emits prefixed strings. No JSON, no request ids, no
correlation between a failed renewal and the request that triggered it, no way
to raise or lower level without a redeploy. For a payment-handling SaaS this is
the thinnest part of the operational story. A structured logger (pino) behind
the same four-method interface is a contained change.

**L11 — `multer@1.x` is end-of-life.** Not flagged by `npm audit`, but 1.x no
longer receives fixes. Plan the move to 2.x.

**L12 — No dependency automation and no secret scanning in CI.**
`.github/workflows/ci.yml` is a single well-built verify job — services, health
checks, throwaway per-run JWT secrets, minimal permissions. But there is no
Dependabot or Renovate config, and no `npm audit` step, which is how H1 went
unnoticed. Add an audit step at `--audit-level=high` and a Dependabot config.

### Documentation

**D13 — The README documents a product that no longer exists.**
It is titled "Clothing POS", and neither it nor `docs/API.md` nor
`docs/DATABASE.md` contains a single mention of *restaurant*, *pharmacy*,
*supershop* or *vertical* — despite `server/src/config/verticals.ts`, three full
service modules, dedicated client page trees and per-vertical entitlements. The
"What works today" table stops at clothing features. Loyalty, wallets, workspace
switching and the account-level billing layer are likewise absent. Anyone
onboarding from the README will misunderstand the product's shape. The printing
docs, by contrast, are current and detailed.

---

## Test strategy

Stronger than it first looks, and worth defending: `scripts/smoke-test.mjs` runs
**2,275 assertions across 95 sections** against a real API and a real MongoDB,
including sections explicitly aimed at cross-tenant IDOR, plan tampering, auth
bypass (`alg: none`, forged refresh tokens), numeric/payload abuse and upload
abuse. `scripts/run-tests.mjs` provisions an isolated `*_test` database and
drops it afterwards, with a guard against ever pointing at a real one. That is
more security-regression coverage than most projects this size have.

The problem is its shape, not its coverage:

- It is one 9,297-line script. You cannot run a single section, so a one-line
  change to loyalty means running the whole suite.
- Every assertion goes over HTTP. Pure logic — `loyalty.math.ts`,
  `purchaseBreakdown.ts`, `proration.service.ts`, `utils/money.ts` — has no
  direct unit tests, so a proration bug surfaces as a failing HTTP assertion
  several layers away from its cause.
- There are zero frontend tests. `PlatformPage.tsx` is 1,606 lines with no
  coverage at all.
- No coverage measurement, so nobody knows what the 2,275 assertions miss.

*Suggested direction:* keep the E2E suite as the integration gate, add Vitest for
the pure-logic modules (they are already well isolated and need no database),
and split the script into per-domain files behind a runner that can execute one.

---

## Recommended order of work

1. Upgrade `nodemailer` to 10.x and re-test the email paths. **(H1)**
2. `npm audit fix` for `qs` and `morgan`; schedule the `react-router` 7 upgrade. **(M3)**
3. Decide tax behaviour for the three non-Clothing verticals and implement it. **(M5)**
4. Encrypt the SMTP password and SMS API key at rest. **(M2)**
5. Extract the shared tender/settlement helper. **(M6)**
6. Rewrite the README around the multi-vertical product. **(D13)**
7. Add an `npm audit` CI step and a Dependabot config. **(L12)**
8. Untrack `client/tsconfig.tsbuildinfo`. **(L9)**
9. Fold payment/SMS env vars into the Zod schema. **(L8)**
10. Structured logging, then a job lease. **(L10, L7)**

Items 1, 2, 7 and 8 are same-day. Item 3 is the one that needs a product
decision before code.
