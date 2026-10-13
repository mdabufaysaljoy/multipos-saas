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

## What has not been verified

**The image has never been built or run.** There is no Docker and no container
runtime on the machine this was written on, and none was installed. Everything
below was checked another way, and the gap is listed so nobody mistakes it for
a tested artifact:

| Checked | How |
|---|---|
| Every `COPY` source exists in the build context | Static parse of the Dockerfile against the tree |
| `npm ci --omit=dev --workspace server --include-workspace-root` resolves and scopes correctly | Run for real; the client's runtime dependencies are absent from the result |
| The runtime file set is sufficient | The image's layout was reproduced on disk — prod-only `node_modules`, `server/dist`, the two manifests — and the API and worker were started from it |
| Module resolution from `/app/server` with `node_modules` one level up | Same run |
| `express`, `mongoose`, `ioredis`, `bullmq`, `sharp`, `msgpackr`, `exceljs`, `pdfkit`, `nodemailer` all load under a production-only tree | Required each one from that layout |
| The API serves `/api/health` and exits 0 on SIGTERM | Same run |
| The worker registers `campaign-delivery` and exits 0 on SIGTERM | Same run — and this is how a real shutdown bug was found and fixed |
| Linux prebuilds exist for both native packages | Read from `package-lock.json` |

| **Not checked** | Why |
|---|---|
| That the image builds | No Docker |
| That the Linux `sharp` and `msgpackr-extract` prebuilds load | No Linux runtime; only their presence in the lockfile is confirmed |
| `HEALTHCHECK`, `USER`, volume ownership as Docker applies them | No Docker |
| The client build inside a container | No Docker; it builds on the host |

Phase 7 builds and runs these images for the first time.
