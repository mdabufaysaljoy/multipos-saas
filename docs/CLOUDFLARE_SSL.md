# Cloudflare, HTTPS and edge security

**Status: PREPARED — NOT DEPLOYED.**

Everything in this document exists in the repository and has been tested
locally against a running container. Nothing has been applied to a domain, a
DNS zone, a Cloudflare account or a server, because none of those exist for
this project yet. The missing prerequisites are listed in
[What is still needed](#what-is-still-needed); every one of them needs a
decision or a credential that is not ours to supply.

Read [Order of operations](#order-of-operations) before changing anything.
Several of these steps take the site down if done in the wrong order.

---

## Why this phase exists

Today the production stack serves plain HTTP. Three consequences, in order of
severity:

1. **Sessions silently break under HTTPS-less production.** The refresh cookie
   is set with `secure: true` whenever `NODE_ENV=production`
   (`server/src/modules/auth/auth.controller.ts`). A browser will not store a
   `Secure` cookie over plain HTTP. So on an HTTP production deployment every
   session dies when the access token expires, with no refresh and no error
   that points at the cause. HTTPS is not a hardening step here; it is what
   makes logins work at all.
2. **Credentials and sales data cross the network in clear text.** This is a
   point of sale. Staff passwords, customer phone numbers and every
   transaction are readable by anything between the till and the server.
3. **The SPA document carries no security headers whatsoever.** Measured, not
   assumed: nginx serves `index.html` from disk and never reaches Express, so
   helmet's headers — CSP, HSTS, framing, referrer policy — appear only on
   `/api` JSON responses. The document a browser actually renders had none.
   That is fixed here, in nginx, because that is the only place that can fix
   it.

---

## What is still needed

| Prerequisite | Status | Who decides |
|---|---|---|
| A registered domain | **missing** | you |
| A Cloudflare account with that zone added | **missing** | you |
| Nameservers pointed at Cloudflare | **missing** | you (at the registrar) |
| A VPS with a public IP | **missing** (Phase 8 is also prepared-only) | you |
| An origin certificate on that VPS | **missing** | you — see [Origin certificate](#origin-certificate) |
| `SERVER_NAME`, `CLIENT_ORIGIN`, `PUBLIC_BASE_URL` set to the real hostname | template ready | you |

Until a domain exists, `CLIENT_ORIGIN` in `.env.production.example` stays a
placeholder. The `203.0.113.x` addresses in these documents are from the
RFC 5737 documentation range and are deliberately not real.

---

## Order of operations

The dependency that matters: **Full (strict) requires a working origin
certificate first.** Turning it on before the origin can serve TLS produces an
immediate site-wide `526 Invalid SSL certificate`.

1. Add the domain to Cloudflare; point the registrar's nameservers at it. Wait
   for the zone to go active.
2. Create the DNS records **unproxied (grey cloud)** at first, so you can
   verify the origin directly without Cloudflare in the way.
3. Deploy the HTTP stack (`docker-compose.prod.yml`, no TLS overlay). Confirm
   the site works over `http://<ip>`. Cloudflare is not involved yet.
4. Install an origin certificate on the VPS at `ORIGIN_CERT_DIR`.
5. Set `SERVER_NAME`, and change `CLIENT_ORIGIN` and `PUBLIC_BASE_URL` to
   `https://<domain>`.
6. Run `deploy/validate.sh`. It checks the certificate, the key permissions,
   the key/certificate match, the expiry and the https origins.
7. Build and deploy with the TLS overlay:
   `TLS=1 ./deploy/build.sh` then add `-f docker-compose.prod.tls.yml`.
8. Verify the origin directly, bypassing Cloudflare:
   `curl -vk --resolve <domain>:443:<origin-ip> https://<domain>/healthz`
9. **Now** proxy the DNS records (orange cloud) and set SSL/TLS mode to
   **Full (strict)**.
10. Set "Always Use HTTPS" on.
11. Run `deploy/verify-tls.sh <domain>` — and with `ORIGIN_IP=<ip>` set, so it
    also checks that the origin is not reachable directly.
12. Only then restrict the firewall to Cloudflare (step 9 of
    [Origin exposure](#origin-exposure)). Doing this earlier locks you out of
    your own debugging.

Rollback at any point: remove `-f docker-compose.prod.tls.yml` and redeploy,
then set Cloudflare back to its previous SSL mode. The HTTP stack and the TLS
stack are separate images and separate compose files precisely so this is one
step and not a repair job.

---

## Cloudflare configuration

### DNS

| Type | Name | Content | Proxy |
|---|---|---|---|
| A | `@` or `app` | the VPS IPv4 | Proxied (orange) |
| AAAA | same | the VPS IPv6, if it has one | Proxied |
| CNAME | `www` | the apex name | Proxied |

Nothing else should be proxied onto this origin. Do not create a record
pointing at the raw IP under another name (`direct`, `origin`, `ssh`, a bare
`mail`): one unproxied record naming the origin is enough to undo the firewall
and WAF work below, and this is the most common way a Cloudflare setup is
defeated in practice.

### SSL/TLS

- **Mode: Full (strict).** Cloudflare validates the origin certificate.
- **Not Flexible.** Flexible means Cloudflare speaks HTTP to the origin while
  showing visitors a padlock. The leg carrying passwords and sales data would
  be unencrypted and nobody would be able to tell. It also makes the origin
  see HTTP, so `X-Forwarded-Proto` lies and the `Secure` cookie problem above
  comes back in a form that is harder to diagnose.
- **Not Full (non-strict)** beyond a brief cutover: it encrypts but accepts any
  certificate, including a forged one, so it stops an eavesdropper and not an
  interceptor.
- Minimum TLS version: 1.2. Opportunistic Encryption and TLS 1.3: on.
- Always Use HTTPS: on (after step 10).
- **HSTS at the edge: leave off.** nginx already sends it, and configuring it
  in two places means a change in one is invisible in the other. **Do not
  enable preload** — it is compiled into browsers and effectively permanent.

### Origin certificate

Two valid choices. Both go to `$ORIGIN_CERT_DIR/origin.pem` and
`$ORIGIN_CERT_DIR/origin.key`:

- **Cloudflare Origin CA** — free, valid 15 years, issued in the dashboard
  (SSL/TLS → Origin Server → Create Certificate). Simplest, and it satisfies
  Full (strict). It is **not trusted by browsers**, so a direct visit to the
  origin shows a warning. That is expected and harmless when traffic only
  arrives through Cloudflare — `validate.sh` prints the issuer so this is not
  later debugged as a fault.
- **Let's Encrypt** — publicly trusted, renews every 90 days, needs the
  ACME HTTP-01 challenge path that the port-80 server block already serves
  (`/.well-known/acme-challenge/`, mounted from `ACME_WEBROOT`). Choose this
  if anything other than Cloudflare must reach the origin over trusted TLS.

Permissions: `chown root:root`, `chmod 600` on the key. `validate.sh` fails the
deployment if the key is more permissive. The directory must live outside the
repository — also checked.

### WAF

The free Managed Ruleset is enough to start. Set it to **Managed Challenge**
rather than Block, so a false positive degrades to a challenge instead of an
outage.

**These paths must be excluded from the WAF, from edge rate limiting and from
caching.** They are server-to-server callbacks: a challenge page returned to a
payment gateway is an accepted payment that the system never records.

| Path | Method | Why |
|---|---|---|
| `/api/payments/webhook/:provider` | POST, GET | gateway callback; body is `text/plain` and signature-verified from the raw bytes |
| `/api/payments/callback/:provider` | GET | gateway redirect return |
| `/api/payment-providers/paymently/events` | POST | device-authenticated SMS event ingest |

A challenge on these is not a theoretical risk: the gateway retries a few
times, gives up, and the order stays unpaid while the money has moved.

Two WAF behaviours to be aware of before enabling anything stricter:

- **The webhook body is `text/plain`.** Signature verification reads the raw
  bytes (`rawBody`, captured in `server/src/app.ts`). Any edge feature that
  rewrites, re-encodes or normalises a request body will break signature
  verification. Do not enable body transformation on these routes.
- **Uploads are up to 25 MB** (`client_max_body_size 25m`). Cloudflare's free
  plan caps request bodies at **100 MB**, so 25 MB passes — but if the upload
  limit is ever raised past 100 MB, the edge becomes the binding constraint and
  the error appears as a Cloudflare 413 that no application log explains.

### Edge rate limiting

Application rate limiting already exists and is distributed through Redis
(Phase 4, 23 policies). Edge rules are a coarse outer layer, not a replacement:
their value is that an attack is dropped before it costs the origin anything.

Suggested starting rules, outside the bypass list above:

| Path | Limit | Action |
|---|---|---|
| `/api/auth/login` | 10 / minute / IP | Managed Challenge |
| `/api/auth/*` (other) | 30 / minute / IP | Managed Challenge |
| `/api/*` | 600 / minute / IP | Block, 1 minute |

Keep the edge limits **looser** than the application's. The application's
limits are per-policy and tenant-aware; the edge's are not. If the edge is
tighter it will reject legitimate traffic that the application would have
allowed, and the resulting 429 is invisible in the application's own logs.

### Caching

- **`/api/*`: never cached.** Create a cache rule with Bypass. nginx also sends
  `Cache-Control: no-store, no-cache, must-revalidate, private` on every API
  response, so there are two independent guards. These responses are
  workspace-specific — sales, stock, staff, wallet — and a shared cache handing
  one tenant's data to another is the worst failure available to a
  multi-tenant system. `verify-tls.sh` fails the run if `cf-cache-status` on
  `/api/health` is ever `HIT`.
- **`/assets/*`: cache aggressively.** Vite fingerprints these; nginx sends
  `immutable` with a one-year max-age.
- **`/` and `index.html`: never cached.** It names the current asset bundle, so
  a stale copy points browsers at JavaScript the next deploy has deleted.
- **`/uploads/*`: do not cache at the edge.** nginx marks these `private`.
  They are unauthenticated random-filename URLs today, but if authorization is
  added later a shared cache would outlive the change.
- **Do not apply a blanket "Cache Everything" rule.** On this application it
  would cache authenticated API responses.

---

## Real client identity

This is the part most easily got wrong, so it is worth being precise.

Cloudflare replaces the TCP source address with its own. Without handling,
every request appears to come from a Cloudflare edge: one shared rate-limit
bucket for the whole internet, and audit rows naming Cloudflare instead of a
till.

The handling is in nginx, not in the application:

```
include /etc/nginx/cloudflare-realip.conf;   # set_real_ip_from <22 ranges>
                                             # real_ip_header CF-Connecting-IP
                                             # real_ip_recursive on
...
proxy_set_header X-Forwarded-For $remote_addr;   # replaced, not appended
```

nginx rewrites `$remote_addr` from `CF-Connecting-IP`, but **only for requests
that genuinely arrive from one of Cloudflare's published ranges**. It then
sends exactly one `X-Forwarded-For` value.

**`TRUST_PROXY_HOPS` therefore stays `1`.** Phase 8 guessed it would need to
become `2` once Cloudflare was added; that guess was wrong. From Express's
point of view there is still exactly one proxy, and the single value it reads
is already the real client. Setting `2` would make Express read *past* that
value into whatever the request arrived carrying — attacker-controlled data,
and precisely how a client mints itself a fresh rate-limit bucket.

Measured on a running container (see
[Verification](#verification) for how to repeat it):

| Request | What the API received as `X-Forwarded-For` |
|---|---|
| from an untrusted address, no headers | the real source address |
| from an untrusted address, `CF-Connecting-IP: 1.2.3.4` | the real source address — **forgery ignored** |
| from an untrusted address, `X-Forwarded-For: 9.9.9.9` | the real source address — **chain discarded** |
| from an untrusted address, all of the above plus `X-Real-IP` | the real source address |
| from a **trusted** range, `CF-Connecting-IP: 203.0.113.77` | `203.0.113.77` — honoured |
| from a trusted range, that header plus a forged chain | `203.0.113.77` — forged chain discarded |

`CF-Ray` and `CF-IPCountry` are passed through to the application, but they are
**not** validated this way and a direct-to-origin request can set them to
anything. Use them for logging only, never for authorization or geo-gating.

### Keeping the range list current

`docker/nginx/cloudflare-realip.conf` is **generated**, not hand-written:

```bash
./deploy/refresh-cloudflare-ips.sh          # regenerate, then commit
./deploy/refresh-cloudflare-ips.sh --check  # CI: fail if stale
```

It fetches `cloudflare.com/ips-v4` and `/ips-v6`, rejects anything that is not
a valid CIDR, and refuses to write a suspiciously short list. A stale list has
two failure modes and both are bad: nginx stops trusting a new Cloudflare edge
(so everyone behind it shares one bucket), and a firewall built from the same
list drops them entirely.

The fetch deliberately does **not** happen during the image build — a build
that reaches the network is not reproducible and fails when the network does.

`--check` is **not** wired into CI either, deliberately: Cloudflare publishing a
new range would then fail every unrelated pull request. Run it when deploying,
or on a schedule. `npm run test:edge` does assert the committed list is
plausible and contains no catch-all range, which is the part that matters for
security and needs no network.

---

## Origin exposure

Full (strict) and a WAF protect nothing if the origin answers the whole
internet directly. Two measures, in order of effectiveness:

1. **Firewall the origin to Cloudflare.** `deploy/refresh-cloudflare-ips.sh`
   also writes `deploy/cloudflare-ufw.generated.sh`, which allows 80 and 443
   from Cloudflare's ranges only. It refuses to run unless an SSH rule already
   exists, because the alternative is locking yourself out of the server.
   Review it before running it; it changes the firewall of whatever host it
   runs on.

   Note the Docker caveat from Phase 8: **a published container port is
   inserted ahead of ufw's rules.** `WEB_BIND` exists for this reason. Verify
   with `verify-tls.sh` and `ORIGIN_IP` set, from a machine outside
   Cloudflare — not by reading the ufw output.

2. **Authenticated Origin Pulls** (optional, stronger). Cloudflare presents a
   client certificate and nginx refuses connections without it, so an attacker
   who learns the origin IP still cannot reach the application even if the
   firewall is wrong. To enable, add Cloudflare's origin-pull CA to the cert
   directory and set in the 443 block:

   ```
   ssl_client_certificate /etc/nginx/certs/cloudflare-origin-pull-ca.pem;
   ssl_verify_client on;
   ```

   Left out of the default config on purpose: it breaks the direct-to-origin
   verification in step 8 above, and it must not be turned on until proxied
   traffic is confirmed working.

Never whitelist `0.0.0.0/0`. The generated nginx include is checked by
`npm run test:edge` specifically for a catch-all range, since trusting
everything means anyone can forge `CF-Connecting-IP` and become any client
they choose.

---

## Response headers

`docker/nginx/security-headers.conf` is included by the SPA locations. It is a
separate file because **nginx's `add_header` does not merge**: an `add_header`
inside a `location` replaces every inherited one, so each location that needs
these has to state them, and stating them once is the only way they stay in
step.

| Header | Value | Note |
|---|---|---|
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` | no `preload` — see below |
| `Content-Security-Policy` | see below | enforcing; report-only variant left commented |
| `X-Frame-Options` | `DENY` | with `frame-ancestors 'none'` |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | |
| `Permissions-Policy` | camera, microphone, geolocation, payment all `()` | |
| `Cross-Origin-Opener-Policy` | `same-origin` | |

`preload` is deliberately absent. It is compiled into browsers and removing it
takes months, so it is a decision to take knowingly later, not a default.

Headers are **not** repeated on `/api/`: helmet already sets them there, and two
CSPs on one response are *intersected* by the browser, silently producing a
policy nobody wrote.

### The CSP, and why each exception is there

```
default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none';
form-action 'self'; script-src 'self';
style-src  'self' 'unsafe-inline' https://fonts.googleapis.com;
font-src   'self' data: https://fonts.gstatic.com;
img-src    'self' data: blob:;
connect-src 'self' wss://localhost:* ws://localhost:* https://localhost:*;
worker-src 'self' blob:; manifest-src 'self'
```

Each exception was derived from what the built bundle actually loads, not from a
template:

- **`fonts.googleapis.com` / `fonts.gstatic.com`** — `client/index.html` loads
  a Google Fonts stylesheet and there are **no self-hosted font files** in the
  build. Removing these two hosts changes every typeface in the product.
  (Self-hosting the fonts would remove the dependency and improve load time
  from Bangladesh; that is a client change, not an edge change, and is out of
  scope here.)
- **`'unsafe-inline'` for styles** — Tailwind and the chart library both set
  inline styles. Not ideal; removing it requires a nonce-based build.
- **`data:` and `blob:` images** — barcodes, QR codes and receipt previews are
  drawn on a canvas and read back out.
- **`wss://localhost:*`** — **QZ Tray.** Read the next section before touching
  this line.

`npm run test:edge` asserts each of these against the actual client source, so
tightening the CSP without noticing fails the test suite rather than a shop.

---

## QZ Tray and HTTPS — read before cutover

**This is the one thing in this phase that TLS can break and no configuration
here can fix.**

Thermal receipt printing works by the browser opening a WebSocket to QZ Tray
running on the same machine. The connection never leaves the till, so neither
nginx nor Cloudflare sees it or can compensate for it.

QZ Tray defaults to `wss://` on ports 8181–8484 and falls back to `ws://` on
8182–8485. **That insecure fallback is blocked as mixed content from an HTTPS
page.** Today the site is HTTP, so the fallback works and nobody has noticed.
After the cutover:

- Each till needs QZ Tray's trusted localhost certificate installed so the
  `wss://` connection succeeds.
- A till where that certificate is missing or expired **stops printing
  receipts**, and the failure appears only in the browser console.

Verify this on one till before switching the rest, and plan it as part of the
cutover rather than discovering it at a counter during business hours.

---

## Verification

Locally, with no domain and no server — this is what has actually been run:

```bash
npm run test:edge          # 26 assertions over the configs and Express
./deploy/refresh-cloudflare-ips.sh --check
docker build -f docker/Dockerfile --target web-tls -t rs-webtls:test .
```

To repeat the live checks against a container, as was done here: generate a
self-signed certificate, run the `web-tls` image with it mounted at
`/etc/nginx/certs`, then

```bash
VERIFY_PORT=18443 VERIFY_HTTP_PORT=18080 VERIFY_INSECURE=1 \
  ./deploy/verify-tls.sh 127.0.0.1
```

Against the real deployment, after step 10:

```bash
./deploy/verify-tls.sh app.example.com
ORIGIN_IP=203.0.113.10 ./deploy/verify-tls.sh app.example.com
```

`verify-tls.sh` is read-only. Every request it makes is an ordinary GET or HEAD
that a browser makes anyway: it is a configuration check, not a penetration
test, and it does not attempt to bypass the WAF, flood the rate limiter or
touch payment endpoints. Running aggressive scans against live production
infrastructure is a separate activity requiring separate authorization.

---

## What this phase does not do

Stated plainly, so none of it is mistaken for done:

- **Nothing is deployed.** No DNS record, firewall rule, Cloudflare setting or
  certificate has been created or changed.
- **Uploads stay on a local volume.** Moving them to R2 is explicitly deferred;
  it remains the reason more than one API replica is unsafe.
- **Authenticated Origin Pulls is documented but not enabled.**
- **The edge rate-limit and WAF rules are recommendations.** They have to be
  created in the dashboard; nothing in this repository can assert they exist.
  Free-plan allowances may not cover all of them.
- **No load test.** The cache and rate-limit choices are reasoned, not measured
  under load.
- **The QZ Tray certificate rollout is a per-till operational task** that no
  change in this repository can perform.
