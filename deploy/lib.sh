#!/usr/bin/env bash
# Shared helpers. Sourced by the other scripts; not run on its own.
set -euo pipefail

COMPOSE_FILES=(-f docker-compose.prod.yml)
[ -f docker-compose.prod.mongo.yml ] && [ "${SELF_HOSTED_MONGO:-0}" = "1" ] && COMPOSE_FILES+=(-f docker-compose.prod.mongo.yml)

ENV_FILE="${ENV_FILE:-.env.production}"

c_red() { printf '\033[31m%s\033[0m\n' "$*"; }
c_green() { printf '\033[32m%s\033[0m\n' "$*"; }
c_yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
die() { c_red "ERROR: $*" >&2; exit 1; }

# Everything runs from the repository root, whatever directory it was invoked in.
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

require_env_file() {
  [ -f "$ENV_FILE" ] || die "$ENV_FILE is missing. Copy .env.production.example and fill it in."
  local perms
  perms=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%A' "$ENV_FILE")
  case "$perms" in
    600|400) ;;
    *) c_yellow "WARNING: $ENV_FILE is mode $perms. It holds every production secret; run: chmod 600 $ENV_FILE" ;;
  esac
}

# The image tag is a git revision, deliberately. A mutable tag makes "which code
# is running?" unanswerable, and makes rollback guesswork.
resolve_tag() {
  if [ -n "${IMAGE_TAG:-}" ]; then echo "$IMAGE_TAG"; return; fi
  git rev-parse --short HEAD 2>/dev/null || die "Not a git checkout and IMAGE_TAG is unset."
}

require_clean_tree() {
  git diff --quiet && git diff --cached --quiet \
    || die "The working tree has uncommitted changes. Deploy a committed revision, so the running image can be traced to source."
}

# `--env-file` is NOT optional here, and the reason is easy to miss.
#
# A service's `env_file:` supplies the CONTAINER's environment. It does not
# supply Compose's own `${...}` interpolation, which reads the shell and a file
# literally named `.env`. So without this flag every interpolated tunable in
# .env.production - WEB_PORT, WEB_BIND, the memory limits, the heap sizes, TZ,
# IMAGE_REPO - is silently ignored and the built-in default is used instead. The
# application still works, which is what makes it hard to notice: it was found
# by setting WEB_BIND=127.0.0.1 and watching the container publish on
# 0.0.0.0 anyway.
#
# Any manual `docker compose` call against the production files needs the same
# flag.
compose() { docker compose --env-file "$ENV_FILE" "${COMPOSE_FILES[@]}" "$@"; }

# Reads one key out of the env file without echoing its value.
env_has() { grep -qE "^${1}=.+" "$ENV_FILE"; }
