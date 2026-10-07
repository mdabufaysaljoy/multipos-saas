# Forgotten password

Somebody who cannot sign in gets back in by proving they read the mailbox the account was registered
with. They type a six-digit code that was emailed to them, then choose a new password.

It belongs to the **shared** authentication system, so it is the same flow for Clothing, Super Shop,
Restaurant and Pharmacy. Nothing in it knows which POS a workspace runs: it works on the `User`
record, which is the one identity all four verticals authenticate against.

Related: [contact verification](./CONTACT_VERIFICATION.md), which is a different thing — that proves
a *signed-in* owner owns their address before they are allowed to spend money. The two use separate
collections on purpose, so a verification code can never reset a password.

---

## 1. The flow

```
Login  →  "Forgot password?"  →  enter email  →  enter the emailed code  →  set a new password  →  sign in
```

Three steps rather than one, because somebody who mistypes the code has to be told so **before** they
are asked to invent a password.

| Step | Endpoint | What it does |
|---|---|---|
| 1 | `POST /api/auth/password/forgot` | Emails a code. Answers identically whether or not the address exists. |
| 2 | `POST /api/auth/password/verify-code` | Checks the code, returns a short-lived **reset ticket**. |
| 3 | `POST /api/auth/password/reset` | Spends the ticket, sets the password, ends every session. |

The screen is `client/src/pages/ForgotPasswordPage.tsx` at `/forgot-password`, reached from the
"Forgot password?" link beside the password field on `/login`. It uses the same `AuthShell` as sign-in
and registration, and the scene follows the **real** request state — nothing advances on a timer.

## 2. The code

| | |
|---|---|
| Format | 6 digits, from `crypto.randomInt` (never `Math.random`) |
| Lifetime | 15 minutes |
| Attempts | 5 wrong guesses, then the code is dead and a new one must be sent |
| Resend | 60-second cooldown per address, at most 5 codes per address per hour |
| Rate limit | plus a per-IP route limiter: 5 sends and 30 answers per 15 minutes in production |
| Storage | **the code is never stored** — only an HMAC-SHA256 of `password-reset:email:code`, compared with `timingSafeEqual` |
| Reuse | marked verified on success, consumed for good when the password is set; a new code kills the previous one |
| Transport | emailed only. It never appears in a URL, a query string or a log line |

Outside production the API also returns the code as `devCode`, because a development machine rarely
has SMTP configured and a reset nobody can complete would make the flow untestable. `isProd` gates
it, so a real deployment never returns a code to anyone.

## 3. Not revealing who has an account

Step 1 answers the **same sentence** for a registered and an unregistered address:

> If the account exists, a verification code has been sent.

The responses are byte-identical apart from the development-only `devCode`. An unknown address leaves
no row behind and sends no mail. A delivery failure is logged and swallowed rather than reported,
because "the gateway refused" for one address and silence for another would be exactly the oracle this
avoids. Step 2 gives a wrong code and an unknown address the same refusal.

Nothing in any response carries a user id, an account id, a workspace name or a role. The masked
address (`s****t@example.com`) appears only **after** the right code was typed.

A cooldown message *is* returned plainly — it concerns a mailbox the person asking already controls,
so it tells them nothing they do not know.

## 4. The ticket

Verifying a code does not set a password; it returns a signed ticket, good for 10 minutes.

- Its secret is derived from — never equal to — the access-token secret, and it carries its own
  audience, so a ticket can never be presented as an access token nor an access token as a ticket.
- It carries the **code row id**, not a user id. It proves "this code was answered", nothing more.
- The row is the authority. Spending the ticket is a guarded update that requires the row to be
  verified, unconsumed and unexpired, so a replayed ticket matches nothing and is refused.

## 5. Setting the password

- Validated by the **one** password policy, `newPassword` in `auth.validators.ts`, which registration
  and the signed-in change also import. There is no second rule.
- Hashed with the existing `hashPassword` (bcrypt, `BCRYPT_ROUNDS`).
- Applied to **every** identity on that address. `User` is unique on tenant + email, so one address
  can own accounts in several workspaces and sign-in already treats them as one person choosing
  between their own shops. Resetting one and not the others would leave a different password per
  workspace with no way to tell which.
- Deactivated and soft-deleted identities are skipped — and if every identity on an address is in that
  state, the address behaves exactly like one that was never registered.

### Sessions

The reset does what `change-password` does: it bumps `permissionVersion` and revokes every refresh
token for the affected identities.

> **Known limit.** `authenticate` does not consult `permissionVersion`, so an access token already in
> flight stays usable until it expires — 15 minutes by default. The refresh token is dead immediately,
> so the session cannot be extended past that. This is pre-existing behaviour shared with
> `change-password`, not something this feature introduced. Closing it means enforcing `pv` in
> `authenticate`; the access token already carries the claim. It is left alone deliberately, because
> `permissionVersion` is also bumped by role edits, staff permission changes and branch reassignment,
> so enforcing it would sign people out of every vertical the moment an admin edited a role. Worth
> doing as its own change, with that consequence decided on purpose.

## 6. The email

Sent through the existing SMTP provider (`emailService.provider()`), reloading credentials from
platform settings — the same path contact verification uses. It is **not** wallet-billed: this is the
platform mailing its own customer.

The template is `server/src/services/email/templates/securityEmails.ts`, built on the shared
`brandedEmail` layout, and contains the code, its expiry and a security warning. It contains **no
link** — the code is typed back into the page the person already has open, so nothing reset-related
ever travels in a URL where it could reach browser history, a proxy log or a referrer header.

## 7. Where it is tested

| | |
|---|---|
| `scripts/smoke-test.mjs` | the flow over HTTP: the link on the login screen, generic responses, wrong/right codes, attempt limits, the cooldown, old password dead, new password working, bystanders untouched, ticket/token separation, validation |
| `server/src/seed/passwordReset.check.ts` | what needs the clock moved: expiry, supersession, the cooldown, single use, and that a reset covers every identity on the address and no one else |

The clock-dependent cases are model-level on purpose: over HTTP they would mean sleeping a minute per
assertion, and a test that sleeps is a delay, not a test.
