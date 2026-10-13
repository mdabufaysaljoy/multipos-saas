# syntax=docker/dockerfile:1
#
# Retailer Suites - production image.
#
# ONE IMAGE, TWO ROLES. The API and the background worker are the same compiled
# server and the same dependencies; they differ only in which entrypoint runs.
# Building them as one image means the worker can never drift from the API it
# shares a database with, and a deployment promotes one artifact rather than
# hoping two were built from the same commit:
#
#   API     docker run ... retailer-suites:TAG                  (the default CMD)
#   Worker  docker run ... retailer-suites:TAG node dist/worker.js
#
# The API starts no worker and the worker starts no HTTP server - that
# separation is in the application, not in this file.
#
# WHY DEBIAN AND NOT ALPINE. Two native dependencies decide it, and the
# lockfile was checked rather than guessed. `sharp` ships prebuilt binaries for
# both glibc (`@img/sharp-linux-x64`) and musl (`@img/sharp-linuxmusl-x64`), so
# either base would work for it. `msgpackr-extract`, which arrives through
# BullMQ, ships `@msgpackr-extract/msgpackr-extract-linux-x64` and NO musl
# build - so on Alpine it would fall back to compiling with node-gyp, which
# means putting python3, make and g++ into the image to build a module that has
# a ready binary for Debian. Debian's prebuilds mean no compiler in any stage
# and no apt packages at all: `sharp`'s libvips arrives inside its own prebuilt
# package rather than from the system.
#
# Build (from the repository root):
#   docker build -f docker/Dockerfile -t retailer-suites:dev .
#
# See docs/DOCKER.md for running, environment, volumes and health checks.

ARG NODE_VERSION=22-bookworm-slim

# ---------------------------------------------------------------- dependencies
# Only the manifests are copied, so this layer - the slow one - is reused for
# every build that does not change a dependency.
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
# `ci` and not `install`: the lockfile is the input, and a build must not be
# free to resolve a different tree than the one that was tested.
RUN npm ci

# --------------------------------------------------------------- build: server
FROM deps AS build-server
COPY server/tsconfig.json server/
COPY server/src server/src
RUN npm run build --workspace server

# --------------------------------------------------------------- build: client
# The SPA is built here so the artifact is reproducible, but it is NOT served by
# the API container - the API serves `/api` and uploaded files only. The client
# calls a relative `/api`, so whatever serves these files must also proxy `/api`
# to the API container on the same origin. That reverse proxy is Phase 8/9.
#
# `PRERENDER_API_URL` is optional. The prerender step reads the admin's live SEO
# settings when it can reach an API and falls back to the built-in copy when it
# cannot, which is the normal case inside a container. A RELEASE build that must
# not ship stale marketing copy passes PRERENDER_REQUIRE_API=true and a
# reachable URL, and the build then fails rather than falling back quietly.
FROM deps AS build-client
ARG PRERENDER_API_URL
ARG PRERENDER_REQUIRE_API
ENV PRERENDER_API_URL=${PRERENDER_API_URL}
ENV PRERENDER_REQUIRE_API=${PRERENDER_REQUIRE_API}
COPY client/tsconfig.json client/vite.config.ts client/tailwind.config.js client/postcss.config.js client/index.html client/
COPY client/public client/public
COPY client/scripts client/scripts
COPY client/src client/src
RUN npm run build --workspace client

# ------------------------------------------------------------ client artifacts
# Extract the built SPA without running anything:
#   docker build -f docker/Dockerfile --target client-assets \
#     --output type=local,dest=./client-dist .
FROM scratch AS client-assets
COPY --from=build-client /app/client/dist /

# ----------------------------------------------------- runtime dependencies
# Production dependencies for the SERVER workspace only. Scoping it keeps
# React, Recharts and the rest of the client's runtime out of a server image
# that will never render a page.
FROM node:${NODE_VERSION} AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
# Both manifests: npm reads every workspace it is told about, even when the
# install is scoped to one of them.
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev --workspace server --include-workspace-root \
 && npm cache clean --force

# -------------------------------------------------------------------- runtime
FROM node:${NODE_VERSION} AS server
ENV NODE_ENV=production
# Node is PID 1 here and the application registers SIGTERM/SIGINT handlers of
# its own, so signals are handled by the code rather than by a supervisor.
# Run with `--init` to get a reaper for any grandchild processes.
WORKDIR /app

# The official image already provides an unprivileged `node` user (uid 1000);
# inventing another would only make volume ownership harder to reason about.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/package.json ./package.json
COPY --from=prod-deps --chown=node:node /app/server/package.json ./server/package.json
COPY --from=build-server --chown=node:node /app/server/dist ./server/dist

# The only path the application writes to at runtime. `STORAGE_LOCAL_DIR`
# resolves against the working directory, so this is `/app/server/uploads`, and
# it needs a volume in any deployment that expects uploads to survive a deploy
# (docs/DOCKER.md, "Persistence").
RUN mkdir -p /app/server/uploads && chown -R node:node /app/server/uploads

USER node
# Matches the `start` script's own working directory, so `dist/server.js` and
# the uploads path resolve exactly as they do outside a container.
WORKDIR /app/server

# `PORT` is read from the environment at runtime; this only documents the
# default. The server binds every interface, which is what a container needs.
EXPOSE 4000

# LIVENESS, not readiness. `/api/health` answers 200 whenever the process is
# serving, and deliberately does not fail when Redis is unavailable - Redis is
# optional for the API, so a dependency-aware check here would kill healthy
# containers. It does not prove MongoDB is reachable either. Readiness is a
# later phase; see docs/DOCKER.md, "Health".
#
# The worker has no HTTP server, so a worker container must be started with
# `--no-healthcheck`; docs/DOCKER.md says how its readiness is judged instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The API. A worker container overrides this with `node dist/worker.js`.
CMD ["node", "dist/server.js"]
