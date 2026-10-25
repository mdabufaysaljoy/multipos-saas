#!/usr/bin/env bash
# Checks everything that can be checked WITHOUT touching the deployment.
# Read-only and safe to run at any time, including on a live server.
source "$(dirname "$0")/lib.sh"

fail=0
note() { printf '  %-52s %s\n' "$1" "$2"; }
ok()   { note "$1" "$(c_green OK)"; }
bad()  { note "$1" "$(c_red FAIL)"; fail=$((fail+1)); }
warn() { note "$1" "$(c_yellow WARN)"; }

echo
echo "Retailer Suites - production configuration check"
echo

# ---- tooling -------------------------------------------------------------
command -v docker >/dev/null && ok "docker present" || bad "docker present"
docker compose version >/dev/null 2>&1 && ok "docker compose v2 present" || bad "docker compose v2 present"
docker info >/dev/null 2>&1 && ok "docker daemon reachable" || bad "docker daemon reachable"

# ---- architecture --------------------------------------------------------
host_arch=$(uname -m)
docker_arch=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo unknown)
note "host architecture" "$host_arch / docker: $docker_arch"
case "$docker_arch" in
  x86_64|aarch64) ok "architecture supported" ;;
  *) warn "architecture unrecognised - build explicitly with --platform" ;;
esac

# ---- environment ---------------------------------------------------------
require_env_file
ok "$ENV_FILE present"

for key in MONGODB_URI JWT_ACCESS_SECRET JWT_REFRESH_SECRET CLIENT_ORIGIN PUBLIC_BASE_URL TRUST_PROXY_HOPS; do
  env_has "$key" && ok "$key set" || bad "$key set"
done

# Secret length, without printing the secret.
for key in JWT_ACCESS_SECRET JWT_REFRESH_SECRET; do
  len=$(grep -E "^${key}=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r\n' | awk '{print length}')
  len=${len:-0}
  [ "$len" -ge 32 ] && ok "$key is at least 32 chars" || bad "$key is at least 32 chars (found $len)"
done

# The two must differ, or one leak compromises both token types.
a=$(grep -E '^JWT_ACCESS_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
b=$(grep -E '^JWT_REFRESH_SECRET=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$a" ] && [ "$a" != "$b" ] && ok "the two JWT secrets differ" || bad "the two JWT secrets differ"

# Placeholders left in by mistake.
grep -qE '^(JWT_|MONGODB_URI).*(REPLACE|replace_me|USER:PASSWORD|example\.mongodb\.net)' "$ENV_FILE" \
  && bad "no example placeholders remain" || ok "no example placeholders remain"

grep -qE '^NODE_ENV=production' "$ENV_FILE" && ok "NODE_ENV=production" || bad "NODE_ENV=production"

# An EMPTY variable is worse than a missing one: the environment schema
# validates these as email addresses, so a bare `SEED_STAFF_EMAIL=` makes the
# server refuse to boot. Absent is correct for production.
if grep -qE '^SEED_[A-Z_]*EMAIL=$' "$ENV_FILE"; then
  bad "no empty SEED_*_EMAIL (an empty one breaks startup - remove the line)"
else
  ok "no empty SEED_*_EMAIL"
fi
if grep -qE '^SEED_[A-Z_]*PASSWORD=.+' "$ENV_FILE"; then
  warn "SEED_* credentials are present - remove them once the database is seeded"
fi
grep -qE '^SMS_MOCK_ENABLED=true' "$ENV_FILE" && bad "SMS test double is OFF" || ok "SMS test double is OFF"

# A replica set is required: this application opens transactions.
if grep -qE '^MONGODB_URI=mongodb\+srv://' "$ENV_FILE"; then
  ok "MongoDB is Atlas (mongodb+srv, a replica set)"
elif grep -qE '^MONGODB_URI=.*replicaSet=' "$ENV_FILE"; then
  ok "MongoDB names a replica set"
else
  bad "MongoDB is a replica set (transactions need one)"
fi

# HTTP origin is expected in Phase 8 and must not be mistaken for ready.
if grep -qE '^CLIENT_ORIGIN=http://' "$ENV_FILE"; then
  warn "CLIENT_ORIGIN is plain HTTP - restricted validation only (see Phase 9)"
fi

# ---- compose -------------------------------------------------------------
IMAGE_TAG="$(resolve_tag)" compose config --quiet >/dev/null 2>&1 \
  && ok "compose configuration valid" || bad "compose configuration valid"

# Nothing but the web port may be published.
published=$(IMAGE_TAG="$(resolve_tag)" compose config 2>/dev/null | grep -A2 'published:' | grep -oE '"?[0-9]+"?' | sort -u | tr '\n' ' ')
host_binds=$(IMAGE_TAG="$(resolve_tag)" compose config 2>/dev/null | grep -E 'host_ip:' | sort -u | tr '\n' ' ')
note "published bind addresses" "${host_binds:-default (all interfaces)}"
note "published host ports" "${published:-none}"
echo "$published" | grep -qE '6379|27017' && bad "Redis/MongoDB are NOT published" || ok "Redis/MongoDB are NOT published"

# ---- git -----------------------------------------------------------------
if git rev-parse --git-dir >/dev/null 2>&1; then
  if git diff --quiet && git diff --cached --quiet; then ok "working tree clean"; else warn "working tree has uncommitted changes"; fi
  note "revision to deploy" "$(resolve_tag)"
fi

# ---- disk ----------------------------------------------------------------
avail=$(df -Pk . | awk 'NR==2 {print int($4/1048576)}')
note "disk available" "${avail} GB"
[ "$avail" -ge 5 ] && ok "disk headroom" || bad "disk headroom (need >= 5 GB)"

echo
if [ "$fail" -gt 0 ]; then c_red "$fail check(s) failed - do not deploy."; exit 1; fi
c_green "All checks passed."
