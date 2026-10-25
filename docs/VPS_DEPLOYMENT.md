# Single-VPS production deployment

Phase 8. Everything here has been prepared and validated locally; **nothing has
been deployed to a server.** There is no VPS, no domain and no TLS yet, and the
section *Before you deploy* lists what is still needed.

Phase 9 adds Cloudflare, a domain and HTTPS, and is **also prepared but not
deployed** — see [CLOUDFLARE_SSL.md](CLOUDFLARE_SSL.md). Until it is applied
this deployment cannot carry real customer traffic, and the reason is concrete
— see *The HTTP boundary*.

Deploying with TLS is this guide plus the overlay:

```bash
TLS=1 ./deploy/build.sh
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.prod.tls.yml up -d
```

Read `CLOUDFLARE_SSL.md` first. The order matters: enabling Cloudflare's
Full (strict) before the origin certificate is installed takes the site down.

---

## The HTTP boundary

Over plain HTTP this deployment **cannot hold a login session**, by design:

The refresh token is an httpOnly cookie set with `secure: true` in production.
A browser refuses to store or send a `Secure` cookie over HTTP. So a sign-in
appears to work — the access token comes back in the response body — and then
dies fifteen minutes later with no way to refresh. That is the cookie behaving
correctly; it is not a bug to work around, and lowering it would be a real
security regression.

What follows from that:

- Phase 8 validation uses the access token directly, or private access.
- **Do not invite real users, and do not put payment or customer data through
  an HTTP deployment.** Rate limits, tenant isolation and idempotency all work,
  but every token and every payload crosses the network in the clear.
- The expected successful outcome of Phase 8 is **DEPLOYED — RESTRICTED**, not
  "live".

---

## Server

| | |
|---|---|
| Provider | Vultr Cloud Compute (Hetzner CX22 or OVHcloud VPS also fit) |
| Size | 2 vCPU, 4 GB RAM, 50–80 GB NVMe |
| OS | Ubuntu Server 24.04 LTS |
| Architecture | **amd64 or arm64** — both are built and verified |
| Region | nearest your customers, and the same region as Atlas if you use it |

On price: a 4 GB instance is normally **above** $10/month at Vultr
(their 4 GB plan is around $20; $5–6 buys 1 GB). Hetzner's CX22 (2 vCPU,
4 GB) is around €4–5. Check current pricing yourself — none of it was verified
here, and a 1 GB instance is not enough for this stack.

---

## Database: pick one

**Strategy A — MongoDB Atlas (default, and what the compose file assumes).**
The application opens transactions, so it needs a replica set; Atlas is one
without spending the VPS's memory on it. Set `MONGODB_URI` to the `mongodb+srv`
string, create a user with `readWrite` on that database only, and allow just the
VPS's IP.

> **The free tier has no backups.** M0 provides no scheduled backup and no
> point-in-time restore. A production deployment on M0 therefore has **no
> database backup at all** unless you add one. Either move to a paid tier or
> take your own dumps — and test a restore.

Do not open `0.0.0.0/0` in the Atlas access list. If you have to, write down why
and who accepted the risk.

**Strategy B — MongoDB on the VPS.** Add
`-f docker-compose.prod.mongo.yml`, which brings a single-node replica set with
its own volume and an idempotent initialiser. Read the memory note at the top of
that file first: it changes the whole budget, and 4 GB becomes tight. Backups
become entirely your responsibility (`deploy/backup.sh`).

Never run both. One authoritative database.

---

## Before you deploy

Still missing, and all of it needs you rather than the repository:

1. A VPS, and explicit approval to deploy to it.
2. The database decision, and a connection string if Atlas.
3. Fresh production secrets, generated on the server.
4. **A backup destination.** `BACKUP_DEST` off the server — another host, S3,
   R2. Until that exists, treat production readiness as blocked: a backup
   sitting on the same disk as the database protects against a bad deploy and
   nothing else.
5. A decision on who may SSH in, and their public keys.
6. For Phase 9: a domain.

---

## Host preparation

Run as root on a fresh Ubuntu server, reading each step rather than pasting the
block. **Do not disable password authentication until you have confirmed a key
login works from a second terminal** — locking yourself out of a cloud VPS means
a console session or a rebuild.

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
# paste your public key:
printf '%s\n' "ssh-ed25519 AAAA... you@example" > /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 600 /home/deploy/.ssh/authorized_keys
```

Now, **from another terminal**, prove `ssh deploy@SERVER` works. Only then:

```bash
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sshd -t && systemctl reload ssh
```

Firewall — allow SSH *before* enabling it:

```bash
ufw allow OpenSSH
ufw allow 80/tcp
ufw --force enable
ufw status verbose
```

> **ufw does not control published Docker ports.** Docker writes its own
> iptables rules ahead of ufw's, so a published port is reachable whatever ufw
> says. That is why `docker-compose.prod.yml` publishes only the web port, and
> why `WEB_BIND` exists. Verify the real exposure from outside the box with
> `nmap` rather than trusting `ufw status`.

Docker, time and logs:

```bash
curl -fsSL https://get.docker.com | sh
usermod -aG docker deploy          # docker group = root-equivalent. Only trusted operators.
timedatectl set-timezone UTC       # host clock in UTC; the app containers get BUSINESS_TIMEZONE
timedatectl set-ntp true
apt-get update && apt-get -y upgrade
```

Container log rotation is configured in the compose file (10 MB × 3 per
service). Unattended upgrades are deliberately **not** enabled here: an
automatic restart in the middle of a shift is a decision for you, not a default.

---

## Deploy

```bash
su - deploy
git clone https://github.com/<you>/multipos-saas.git && cd multipos-saas
git checkout <the revision you intend to run>

cp .env.production.example .env.production
chmod 600 .env.production
nano .env.production          # fill in everything marked REQUIRED

deploy/validate.sh            # refuses to pass on placeholders or weak secrets
deploy/build.sh               # builds and tags with the git revision
deploy/deploy.sh              # starts the stack
deploy/health.sh              # verifies it
```

Seeding a **brand-new** database only — never one with real data:

```bash
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose --env-file .env.production \
  -f docker-compose.prod.yml exec api node dist/seed/seed.js
```

For Strategy B, prefix every command with `SELF_HOSTED_MONGO=1`.

### Updating

```bash
git fetch && git checkout <new revision>
deploy/validate.sh && deploy/build.sh && deploy/deploy.sh && deploy/health.sh
```

`deploy.sh` records the revision it replaces, so `deploy/rollback.sh` has a
target. It refuses to run with uncommitted changes, so the running image can
always be traced to source.

### Day to day

```bash
deploy/health.sh                 # full verification, read-only
deploy/logs.sh api               # follow one service
deploy/logs.sh worker 200        # last 200 lines
deploy/backup.sh                 # encrypted backup (see below)
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose --env-file .env.production -f docker-compose.prod.yml restart api
```

Any manual `docker compose` call against the production files needs both
`--env-file .env.production` **and** `IMAGE_TAG` set. Neither is optional
politeness:

- Without `IMAGE_TAG` the call fails outright — the compose file declares it
  required so a mutable `latest` can never creep in.
- Without `--env-file` it *succeeds* and silently ignores every tunable in
  `.env.production`, because compose's `env_file:` feeds the container but not
  `${...}` interpolation. Measured consequence: `WEB_BIND` reverts to its
  default and the port binds to `0.0.0.0` instead of the address you chose.
  A command that looks like it worked is the dangerous case here.

The `deploy/` scripts pass both for you, which is why they are the recommended
path.

---

## Rollback, and what it does not do

```bash
deploy/rollback.sh               # to the recorded previous revision
deploy/rollback.sh abc1234       # to a specific one
```

It changes **which image runs**. It does not touch MongoDB, Redis or the uploads
volume, and it does not undo a data change.

That distinction is the whole point. If the revision you are leaving wrote data
the older code cannot read — a new required field, a renamed field, a migration
— then rolling the image back leaves the old code looking at new data, and you
need a **database restore** as well. That is a different, slower decision with
data loss attached: everything written since the backup is gone. Application
rollback is cheap and reversible; data recovery is neither. Decide which one you
are doing before you start.

The script refuses to roll back to an image that is not on the host, and asks
you to type the target revision to confirm.

---

## Backups

```bash
export BACKUP_PASSPHRASE='...'          # from a password manager, not history
export BACKUP_DEST='user@backup-host:/srv/retailer-suites'   # or s3://bucket
RESTORE_TEST=1 deploy/backup.sh
```

Covered: uploads always; MongoDB when self-hosted. **Not** covered:
`.env.production`, deliberately — the one file that must live somewhere else
entirely, in a password manager rather than in an archive beside the data it
unlocks.

`RESTORE_TEST=1` decrypts the archive and lists both members. That proves the
archive is intact; it does **not** prove a restore into a running system works.
Do that drill separately, against a scratch database, before you need it:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE \
  -in backup.tar.gz.enc | tar xzf - -C /tmp/restore
# Strategy B:
IMAGE_TAG=$(git rev-parse --short HEAD) docker compose --env-file .env.production \
  -f docker-compose.prod.yml -f docker-compose.prod.mongo.yml \
  exec -T mongo mongorestore --archive --gzip --drop < /tmp/restore/mongo.archive.gz
```

`--drop` replaces collections. Never aim a restore at a database you still want.

A cron entry, once `BACKUP_DEST` is set:

```
0 3 * * * cd /home/deploy/multipos-saas && BACKUP_PASSPHRASE=... BACKUP_DEST=... deploy/backup.sh >> /var/log/rs-backup.log 2>&1
```

---

## Resources

Measured on the local validation run, **Strategy B** (self-hosted MongoDB), idle
after startup. Not a load test and not a capacity figure:

| Service | Limit | Idle |
|---|---|---|
| api | 1.25 GB | 137 MB |
| mongo | 1.17 GB | 164 MB |
| worker | 640 MB | 97 MB |
| redis | 320 MB | 10 MB |
| web | 128 MB | 10 MB |
| **total** | | **~418 MB** |

Comfortable on 4 GB with Atlas; tighter with MongoDB on the same box. The limits
are ceilings that stop one service starving the others, and `*_HEAP_MB` sets
Node's own heap **below** its container limit — otherwise the kernel OOM-kills
the process instead of letting V8 collect garbage. They are different numbers
and both matter.

Consider 1–2 GB of swap as emergency protection, not as extra RAM. A POS that
swaps during a checkout is a POS that loses sales.

---

## Timezone

Business-day boundaries are computed from the **process clock**
(`dayjs().startOf('day')`), not from `BUSINESS_TIMEZONE`, which is only used for
display formatting. So the containers' `TZ` is what decides when a sales day
starts and ends, and the compose file sets it from `BUSINESS_TIMEZONE`.

Keep the **host** in UTC and let the containers carry the business timezone.
Persisted instants are UTC either way; MongoDB stores dates as UTC.

**The limitation:** every tenant shares that one timezone. A workspace in a
different timezone gets the wrong day boundary, and no amount of configuration
fixes it — the code would have to derive each window from the tenant's own
timezone. That touches reporting across all four verticals and is out of scope
here. Until it is done, do not claim correct local-day reporting for tenants
outside `BUSINESS_TIMEZONE`.

---

## One API instance, and why

`docker-compose.prod.yml` runs exactly one API container, and that is a
correctness constraint:

- The **subscription scheduler runs inside the API process**. A second replica
  would run every scheduled pass twice — renewals, expiries, invoices.
- **Uploads are on a local volume.** A second replica would serve 404s for files
  the first one wrote.

Do not `--scale api=2`. Horizontal scaling is blocked until the scheduler gains
leader election or moves to the worker, and uploads move to object storage.

---

## Troubleshooting

**API will not start.** `deploy/logs.sh api 50`. The environment schema fails
fast and names the variable. A present-but-**empty** `SEED_*_EMAIL` is a common
one: it is validated as an email address, so a bare `SEED_STAFF_EMAIL=` stops
the boot. Remove the line.

**`IMAGE_TAG is required`.** A manual compose call without it. Use the scripts,
or set it.

**Settings in `.env.production` seem ignored.** Ports, memory limits and `TZ` are
Compose *interpolation*, which `env_file:` does not feed — you need
`--env-file .env.production`. The scripts pass it.

**502 from nginx.** The API is unhealthy, or was recreated. nginx re-resolves per
request (fixed in Phase 7), so it should recover on its own; check
`deploy/health.sh`.

**Transactions unavailable.** `MONGODB_URI` is pointing at a standalone server.
`deploy/health.sh` checks for a replica set explicitly and fails if there is not
one.

**Worker idle.** It has no HTTP endpoint by design. Check its startup log for
`Worker process ready`, and the queue depth in Redis.

**Apple Silicon → amd64 VPS.** `PLATFORM=linux/amd64 deploy/build.sh`, or build
on the server, which is simpler and avoids emulation.

---

## Validated, and not

Local validation on macOS arm64, Docker 29.8:

| | |
|---|---|
| `deploy/validate.sh` | refuses placeholders, short secrets, identical secrets, a non-replica-set URI, an empty `SEED_*_EMAIL`; passes a correct file |
| Production images build | arm64 **and amd64** |
| amd64 image runs | uid 1000, `x86_64`, **sharp + libvips 8.18.7**, bullmq, msgpackr, ioredis, mongoose, express — under emulation |
| Stack starts | api, worker, redis, mongo, web all healthy |
| Health script | 15 checks, all passing |
| MongoDB | replica set `rs0`, writable primary, transactions available |
| Exposure | only the web port published, and on the address `WEB_BIND` names |
| Graceful shutdown | api and worker both exit **0** |
| Persistence | uploads and MongoDB data survive a full restart |
| Backup | encrypted, restore-tested, refuses to call a local-only copy a backup |
| Rollback | image swapped, volumes untouched, refuses an absent image, requires confirmation |
| Refusals | deploy blocked on a dirty tree; rollback blocked on a missing image |
| Non-root | api/worker uid 1000, redis and mongo uid 999, nginx workers unprivileged (master root, as required to bind :80) |
| Memory limits | enforced by the kernel on all five containers; idle use ~425 MB against 3.11 GB of limits (Strategy B) |
| Log rotation | `json-file` 10 MB x 3 on every service, confirmed in the daemon's view |
| `no-new-privileges` | applied to all five services; stack verified healthy with it on |
| Documented commands | every `docker compose` block in this file copy-pastes and runs |

**Not validated:** anything on a real VPS. No remote host was touched. The amd64
image has not run on real amd64 hardware, only under emulation. No load test.
No TLS, no domain, no Cloudflare. Atlas (Strategy A) could not be exercised
without a cluster — the local run used Strategy B.

**`restart: unless-stopped` is configured but was not observed firing.** It is
set on every service and present in the daemon's view of each container, but an
auto-restart could not be demonstrated on this machine: a control container
with the same policy, SIGKILLed, also stayed exited. The limitation is the local
Docker daemon's handling of `docker kill`, not this configuration — but it is
unproven here either way, so treat it as configured rather than verified.

### Known weakness: no database or cache authentication

Neither self-hosted MongoDB nor Redis requires a password:

- `mongod` runs with `--replSet rs0 --bind_ip_all` and **no `--auth`**.
- `redis-server` runs with **no `requirepass`**.

Neither is reachable from the internet — no port is published for either, which
was verified — so the exposure is limited to the Docker network. But it means
anything that gets onto that network, or any compromise of the API or worker
container, has unauthenticated full read/write access to the database.

This is a deliberate open item rather than an oversight: adding auth to a
replica set needs a keyFile for internal membership auth, a root user created at
first init, and a changed `MONGODB_URI`, which is a migration rather than a
setting. **Atlas (Strategy A) does not have this weakness** — it enforces
authentication and TLS, which is one more reason it is the default. If you
choose Strategy B for real customer data, close this first.
