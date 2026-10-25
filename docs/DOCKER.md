# Docker

Production images for the API and the background worker. This is the image
layer only — there is no Compose file, no reverse proxy and no deployment
automation here; those are Phases 7–10.

## What gets built

One image serves both roles. The API and the worker run the same compiled
server and the same dependencies and differ only in which entrypoint starts, so
a worker can never drift from the API it shares a database with, and a
deployment promotes one artifact instead of hoping two were built from the same
commit.

```
docker/Dockerfile
├── deps           npm ci from the lockfile (manifests only, so the layer caches)
├── build-server   tsc  → server/dist
├── build-client   vite → client/dist   (artifact only; the API does not serve it)
├── client-assets  the built SPA, exportable with --output
├── prod-deps      npm ci --omit=dev, scoped to the server workspace
└── server         runtime: node:22-bookworm-slim, non-root, ~no build tools
```

**Base image: `node:22-bookworm-slim`.** Node 22 is the LTS line the repository
already targets (`engines: >=20`, CI runs 22). Debian rather than Alpine for a
specific, checked reason — see *Native dependencies*.

## Build

From the repository root (the Dockerfile expects the root as build context):

```bash
docker build -f docker/Dockerfile -t retailer-suites:dev .
```

The SPA, as files you can hand to a static host or a reverse proxy:

```bash
docker build -f docker/Dockerfile --target client-assets \
  --output type=local,dest=./client-dist .
```

A release build that must not ship stale marketing copy reads the admin's live
SEO settings and fails if it cannot:

```bash
docker build -f docker/Dockerfile \
  --build-arg PRERENDER_API_URL=https://api.example.com/api \
  --build-arg PRERENDER_REQUIRE_API=true \
  -t retailer-suites:1.0.0 .
```

Without those arguments the prerender step falls back to the built-in copy and
says so in the build log. That fallback is correct for a development or CI
build; it is a deliberate choice for a release, which is why it has to be asked
for rather than inherited.

## Run

### API

```bash
docker run -d --name rs-api --init \
  -p 4000:4000 \
  -e NODE_ENV=production \
  -e PORT=4000 \
  -e MONGODB_URI='mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/retailersuites' \
  -e JWT_ACCESS_SECRET='<48+ random bytes, hex>' \
  -e JWT_REFRESH_SECRET='<a different 48+ random bytes, hex>' \
  -e CLIENT_ORIGIN='https://app.example.com' \
  -e PUBLIC_BASE_URL='https://api.example.com' \
  -e TRUST_PROXY_HOPS=1 \
  -e REDIS_URL='redis://redis:6379' \
  -v rs-uploads:/app/server/uploads \
  retailer-suites:dev
```

### Worker

Same image, different command, and **no health check** — the worker serves no
HTTP, so the image's check would fail it forever:

```bash
docker run -d --name rs-worker --init --no-healthcheck \
  -e NODE_ENV=production \
  -e MONGODB_URI='mongodb+srv://USER:PASSWORD@cluster.example.mongodb.net/retailersuites' \
  -e JWT_ACCESS_SECRET='<same as the API>' \
  -e JWT_REFRESH_SECRET='<same as the API>' \
  -e REDIS_URL='redis://redis:6379' \
  retailer-suites:dev \
  node dist/worker.js
```

The worker **requires** Redis and exits non-zero with a clear message without
it. The API treats Redis as optional and keeps serving.

### Operating

```bash
docker logs -f rs-api                 # follow
docker logs --tail 100 rs-worker
docker ps --filter name=rs-           # status, and the API's health column
docker inspect --format '{{.State.Health.Status}}' rs-api
docker stop rs-api rs-worker          # SIGTERM, then drain; both exit 0
docker rm rs-api rs-worker
docker exec rs-api node -e 'console.log(process.getuid(), process.version)'
```

`docker stop` sends SIGTERM. The API closes its HTTP server, Redis and MongoDB;
the worker stops taking jobs, gives the batch in hand up to 15 seconds, then
closes its queues and database. Both exit 0. `--init` adds a reaper for
grandchild processes; Node itself handles the signals, because the application
registers its own handlers.

## Environment

Nothing is baked into the image. Every value is injected at run time, and
`.dockerignore` keeps `.env`, `*.pem`, `*.key` and `certs/` out of the build
context entirely.

**Required**

| Variable | Notes |
|---|---|
| `MONGODB_URI` | Atlas or any replica set. A standalone works but disables transactions. |
| `JWT_ACCESS_SECRET` | ≥32 chars. The server refuses to boot otherwise. |
| `JWT_REFRESH_SECRET` | ≥32 chars, different from the access secret. |

**Required for the worker**

| Variable | Notes |
|---|---|
| `REDIS_URL` | `redis://` or `rediss://` for TLS. The worker exits 1 without it. |

**Worth setting in production**

| Variable | Default | Notes |
|---|---|---|
| `NODE_ENV` | `production` in the image | |
| `PORT` | `4000` | |
| `CLIENT_ORIGIN` | `http://localhost:5173` | Comma-separated CORS allowlist. |
| `PUBLIC_BASE_URL` | `http://localhost:4000` | Used to build public file URLs; must be the API's real address. |
| `TRUST_PROXY_HOPS` | `1` | **Must match the number of proxies.** It decides `req.ip`, which rate limiting keys on. |
| `REDIS_URL` | unset | Without it the API still rate limits, but per process. |
| `REDIS_KEY_PREFIX` | `retailersuites:<NODE_ENV>:` | |
| `STORAGE_LOCAL_DIR` | `uploads` | Relative to `/app/server`. |

Gateway, SMTP and SMS credentials are **not** environment variables: a platform
admin sets them in the database. `.env.example` is the full annotated list.

## Persistence

| Path | Holds | Needed in Phase 7 |
|---|---|---|
| `/app/server/uploads` | product and shop images, logos, the site's social image | **Yes** — a named volume, or uploads are lost on every deploy |

Nothing else is written at runtime: exports stream straight to the response,
imports are parsed in memory, image processing happens in memory through
`sharp`, and invoices and receipts are MongoDB documents. The only writer is
`services/storage/local.provider.ts`.

**This does not survive a second API replica.** Replica A writes a file;
replica B is asked for it and has nothing. Local uploads make the API
effectively single-replica, and that is one of the two reasons more than one
API container is not safe yet (the other is the scheduler, below). Object
storage is the fix and is deliberately deferred — the `StorageProvider`
interface and the boot-time refusal for an unimplemented driver already exist,
so it is a contained change when a real requirement appears.

## Health

The image's `HEALTHCHECK` calls `/api/health` and is **liveness only**: it says
the process is serving HTTP. It does **not** prove MongoDB is reachable, and it
deliberately does not fail when Redis is unavailable — Redis is optional for the
API, so a dependency-aware check here would kill containers that are working.

A real readiness probe belongs with the observability phase; `pingRedis()` and
the Mongo connection state are the primitives it will read. Until then, treat a
`healthy` container as "the process is up", not "everything it needs is up".

**The worker has no HTTP endpoint and no health check**, and none was invented
for it. Until Phase 7 gives it a proper probe, judge it by:

- its startup log — `Worker process ready with 1 worker(s)` names what registered;
- `docker ps` showing it still running, since it exits 1 when Redis is missing;
- queue depth and failed-job counts in Redis, which is where a stuck worker shows.

## Native dependencies

Two packages compile native code, and the base image was chosen on the evidence
rather than by habit. Both ship prebuilt binaries, and the lockfile was read to
check which platforms are actually covered:

| Package | glibc (Debian) | musl (Alpine) |
|---|---|---|
| `sharp` | `@img/sharp-linux-x64`, `-linux-arm64` ✅ | `@img/sharp-linuxmusl-x64` ✅ |
| `msgpackr-extract` (via BullMQ) | `@msgpackr-extract/msgpackr-extract-linux-x64`, `-linux-arm64` ✅ | **none** ❌ |

On Alpine, `msgpackr-extract` would fall back to `node-gyp`, which means adding
python3, make and g++ to build a module that has a ready binary for Debian. So:
Debian, no compiler in any stage, and **no apt packages at all** — `sharp`
brings its own libvips inside its prebuilt package.

Host `node_modules` is excluded by `.dockerignore`, so macOS binaries can never
reach a Linux image. Dependencies are always installed inside the build, for the
build's own platform. Build on the architecture you deploy to, or use
`docker build --platform linux/amd64`.

## Security

- Runs as the image's unprivileged `node` user (uid 1000); only `uploads` is
  writable by it.
- Production dependencies only in the runtime stage — no TypeScript, no Vite, no
  test tooling.
- No compilers, no apt packages, no shell utilities beyond the base image.
- One port, and only because `PORT` is served on it.
- No credentials in any layer; no `.env` in the build context.
- No Docker socket, no privileged mode, no host networking needed.

The compiled migrations are in the image (`node dist/migrations/<name>.js`), so
a release can run them without `tsx` or any development dependency.

## Compose: the local stack

`docker-compose.yml` runs the whole thing: nginx, the API, the worker, Redis and
a **single-node MongoDB replica set**. The replica set is the point — a
standalone server silently disables transactions, so until this stack existed no
test had ever exercised the transaction path.

```
Browser -> nginx :8080 -> SPA + /api, /uploads proxied -> API -> MongoDB rs0
                                                       \-> Redis <- worker
```

```bash
cp .env.compose.example .env.compose     # then put real secrets in it
docker compose build
docker compose up -d
open http://localhost:8080
```

Only nginx publishes a port. MongoDB and Redis are reachable on the internal
network and nowhere else.

### Operating

```bash
docker compose ps                        # state and health
docker compose logs -f api               # or worker, web, mongo, redis
docker compose restart api               # one service
docker compose stop                      # SIGTERM; both app containers exit 0
docker compose down                      # remove containers, KEEP volumes
docker compose down -v                   # also DESTROYS mongo, redis and uploads
```

`docker compose down -v` is the destructive one. Plain `down` keeps all three
named volumes, and an upload written before a restart is still there after it.

### Inspecting the infrastructure

```bash
# Replica set status, and that transactions are really available
docker compose exec mongo mongosh --quiet --eval 'rs.status().set'
docker compose logs mongo-init | tail -3

# Redis
docker compose exec redis redis-cli ping
docker compose exec redis redis-cli --scan --pattern 'retailersuites:*' | head
docker compose exec redis redis-cli config get maxmemory-policy

# Seed a demo workspace (destroys existing data in that database)
docker compose exec api node dist/seed/seed.js --reset
```

### Integration tests

Two layers. First, the infrastructure itself, from inside the API container:

```bash
docker compose exec api node dist/seed/infraIntegration.check.js
```

It proves the replica set is real, that transactions commit and roll back with
no partial write, that Redis answers, that the rate limiter's Lua is atomic
under 25 concurrent increments, and that BullMQ enqueues, processes, retries,
exhausts and shuts down against a real Redis.

Second, the application's own end-to-end suite, against the stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.test.yml up -d
docker compose exec mongo mongosh retailersuites --quiet --eval 'db.dropDatabase()'
docker compose exec api node dist/seed/seed.js --reset
docker compose -f docker-compose.yml -f docker-compose.test.yml restart api worker
API_BASE=http://localhost:8080/api node scripts/smoke-test.mjs
```

The order matters. The suite is **stateful and expects a fresh database**: it
asserts exact branch counts and plan limits, so a second run against the same
data fails on accumulated state. Dropping the database and restarting the API
afterwards is what makes it repeatable — the restart is needed because the API
caches its pricing catalogue for a minute and a reset underneath it leaves that
cache stale.

`docker-compose.test.yml` exists because the suite cannot run against a
production-mode API: it signs in as dozens of accounts, which the strict
production rate limits throttle on purpose. The override switches the two
containers to `NODE_ENV=development` (the application's own relaxed limits) and
enables the SMS test double so campaigns can be delivered end to end without
messaging anyone. Everything else is identical — the same image, the same
replica set, the same Redis, the same worker.

Six assertions in that suite cannot pass against a containerised stack, and they
are limitations of running the host suite against containers rather than
product failures:

- four payment tests need mock gateways that the harness starts **on the host**,
  which the API cannot reach from inside the Compose network;
- two upload tests check for files with `existsSync` **on the host filesystem**,
  where a file written into the container's volume is not visible.

All six pass in the ordinary host run (`npm test`).

### Apple Silicon

The stack was built and run on an M-series Mac: Docker 29.8, `linux/aarch64`,
Compose v5. Nothing is pinned to amd64, and both native modules have arm64
prebuilds (`sharp` reports libvips 8.18.7 inside the container). To build for an
amd64 VPS from a Mac, pass `--platform linux/amd64` — it will emulate, so expect
it to be slow.

### Resource expectations

Approximate, from `docker stats` on an idle-to-light stack; **not** a measured
capacity figure, and no load test was run:

| Service | Memory limit set | Idle use |
|---|---|---|
| mongo | 1 GB | ~200 MB |
| api | 768 MB | ~100 MB |
| worker | 640 MB | ~90 MB |
| redis | 320 MB | ~10 MB |
| web | 128 MB | ~5 MB |

That fits a 2 vCPU / 4 GB VPS with room to spare, which is the Phase 8 target.
The limits are ceilings to stop one service starving the others, not reservations.

### Redis durability and eviction

`appendonly yes`, `maxmemory 256mb`, `maxmemory-policy noeviction`.

The policy is the important one. BullMQ's queues are **data**, not cache: under
an LRU policy Redis would evict job and lock keys to make room and jobs would
disappear with no error anywhere. `noeviction` makes a full Redis refuse writes
instead, which fails loudly. The append-only file means queued jobs survive a
Redis restart; it is not a backup strategy, and rate-limit counters are
deliberately disposable.

## Verified in Phase 7

Everything Phase 6 listed as unverified has now been run:

| | Result |
|---|---|
| The image builds | Yes — 53s, `linux/arm64` |
| Runs as non-root | `uid=1000(node)`, cwd `/app/server` |
| Linux native prebuilds load | `sharp` + libvips 8.18.7, `msgpackr`, `bullmq`, `ioredis`, `mongoose`, `express` |
| No dev tooling in the runtime | typescript, vite, tsx, eslint all absent |
| API starts and serves | `/api/health` 200 through nginx |
| Worker starts | registers `campaign-delivery`, concurrency 1 |
| MongoDB replica set | `rs0`, writable primary, **transactions ENABLED** |
| Transactions commit and roll back | 9 assertions, including no partial write after rollback |
| Redis from API and worker | connected, PING, namespaced keys |
| BullMQ against real Redis | enqueue, process, retry, exhaustion, jobId dedupe, clean shutdown |
| Rate limiting | 429 through nginx, real client IP, **counter shared across two API instances** |
| Idempotency | 37 assertions against the replica set |
| Campaign queue | API enqueues, worker delivers, every recipient terminal |
| Frontend | SPA served, deep routes fall back, `index.html` not cached, assets immutable |
| Persistence | uploads and MongoDB data survive a full restart |
| Graceful shutdown | API and worker both exit **0** on SIGTERM |
| Dependency restarts | API recovers from both a Redis and a MongoDB restart |
| Restart loops | none; every `RestartCount` is 0 |

### Still not verified

- **No load test.** The resource figures above are idle observations.
- **Multiple API replicas are not production-safe**, and running two was a
  temporary test only. The subscription scheduler still runs inside every API
  process, and uploads are on a local volume.
- **amd64 was not built.** Everything here is arm64.
- **Nothing was deployed.** No TLS, no Cloudflare, no VPS; those are Phases 8-9.

---

## Production

This file covers the **local** stack. The single-VPS production stack is
separate — `docker-compose.prod.yml`, the `deploy/` scripts and
[VPS_DEPLOYMENT.md](VPS_DEPLOYMENT.md) — and is deliberately not an override of
the local one, so none of its test assumptions can be inherited by accident.
It is prepared and locally validated; nothing has been deployed.
