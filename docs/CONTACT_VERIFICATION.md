# Contact verification (email or phone)

Every workspace owner proves **one** contact detail — their email address *or* their phone number —
before they can buy a subscription. One is enough; which one is up to them.

It exists so that an invoice, a receipt, a renewal reminder and a "your plan is about to lapse" warning
have somewhere real to arrive, and so an account cannot be created and paid for behind an address or a
number nobody owns.

---

## 1. The flow

```
Register  →  Verify your contact (on the onboarding screen)  →  Set up the store  →  use the POS
                                   ↓ (skippable)
                             Buy a subscription  ──►  refused until one contact is verified
```

- The verification card appears **at registration**, above the store form. It is not a wall: the shop
  can be set up, products added and sales rung up without it.
- The moment money is involved, it is required. The Subscription page shows the same card, and the
  upgrade dialog swaps its payment form for it rather than letting a purchase fail.

## 2. The code

| | |
|---|---|
| Format | 6 digits, from `crypto.randomInt` (never `Math.random`) |
| Lifetime | 10 minutes |
| Attempts | 5 wrong guesses, then the code is dead and a new one must be sent |
| Resend | 60-second cooldown, at most 5 codes per channel per hour, plus a per-IP route limiter |
| Storage | **the code is never stored** — only an HMAC-SHA256 of `userId:channel:code`, compared in constant time |
| Reuse | consumed on success; sending a new code kills the previous one |
| Channel | a code for the email address cannot verify the phone number, and vice versa |
| Moving target | if the address or number changes after the code was sent, the code is void |

Sending goes straight through the platform's SMTP provider or SMS provider — **not** through the
wallet-billed messaging service. This is the platform verifying its own customer, so no workspace
wallet is charged.

**Credentials are reloaded before every send.** Both gateways are configured by a platform admin and
live in the database, so the copy held in memory since boot is usually empty; the SMS path calls
`smsRegistry.activeAsync()` (which refreshes first) and the email path `emailService.provider()`. Using
the un-refreshed registry silently selected the **SMS test double** on a server that had
`SMS_MOCK_ENABLED=true`, which reports success and delivers nothing — that is exactly how a code can
"send" and never arrive.

The test double is never treated as a delivery, even when it is the only provider available.

### "Code sent" is only said when it was

The send response carries `delivered` and, when false, a `deliveryNote` naming the reason ("No SMS
gateway is configured.", "The SMS gateway refused the message.", "Only the SMS test double is
available…"). Outside production the UI shows that instead of a success toast, with the development
code beside it. In production an undelivered code is an outright error, so nobody is left waiting for a
message that was never sent.

### The development code

Development and test servers rarely have SMTP or an SMS gateway configured, and a verification step
nobody can complete would make the whole app untestable. Outside production the send response includes
the code it sent (`devCode`), and the UI shows it in the toast. `isProd` gates it: **a production server
never returns a code to anyone**, and delivery failure there is reported as an error rather than
silently swallowed.

## 3. What is gated

Enforced by `requireVerifiedContact` (`server/src/middleware/verifiedContact.ts`), which answers one
question: does this user have `emailVerifiedAt` **or** `phoneVerifiedAt`?

| Route | Gated |
|---|---|
| `POST /subscriptions/purchase` (wallet / manual / online) | ✅ |
| `POST /subscriptions/renew` (renew now, from the wallet) | ✅ |
| `POST /subscriptions/upgrade-request` (manual payment claim) | ✅ |
| `POST /payments/checkout` (online provider) | ✅ |
| Automatic renewal from the wallet (the scheduled job) | ❌ — a paying customer must never lose their subscription to a check they cannot answer at 3am |
| Platform-admin plan assignment | ❌ — a deliberate act by staff, on behalf of a customer |
| Everything else (POS, products, reports…) | ❌ — this gates buying, not the shop |

A refusal is `403 VERIFICATION_REQUIRED` with a message that says what to do.

## 4. API

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/auth/verification` | What is proven, with the destinations **masked** (`u****r@example.com`, `017****11`) |
| POST | `/api/auth/verification/send` | `{ channel }` → sends a code (`devCode` outside production) |
| POST | `/api/auth/verification/confirm` | `{ channel, code }` → verifies, and returns the new status |

The session (`/auth/me`) carries the same status under `user.verification`, so the app knows whether to
ask without an extra request.

## 5. Data

- `User.emailVerifiedAt` / `User.phoneVerifiedAt` — null until proven.
- `VerificationCode` — `{ userId, channel, destination, codeHash, expiresAt, attempts, consumedAt }`,
  with a TTL index so expired rows delete themselves.

Verification belongs to the **person**, not the workspace: an owner who opens a second workspace is not
asked again. Changing a phone number clears its verification — what was proven was proven about the old
number.

## 6. Existing customers

Nobody is grandfathered in, and no data is touched: a workspace that has been running since before this
existed simply verifies once, the next time it buys or renews. That is the one-off friction the feature
is for. Nothing else in the app is affected while they are unverified.

## 7. Limitations

- One email address and one phone number per person — the ones on their user record. Changing them is
  done in Settings/Staff, not here.
- No "verify later, remind me" schedule: the prompt is at registration, and the gate is at purchase.
- SMS delivery depends on the platform's configured provider (Platform admin → Settings → SMS); if it
  is not set up, email is the way through, and vice versa. With neither configured, nobody can verify
  and therefore nobody can buy — so configure at least one before going live.
- `SMS_MOCK_ENABLED=true` belongs on test machines only. It registers a double that delivers nothing;
  verification reports it as undelivered rather than pretending.
- The code is not a second factor for signing in — it proves a contact detail, nothing more.
