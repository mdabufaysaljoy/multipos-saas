#!/usr/bin/env bash
# Verifies a LIVE HTTPS deployment from the outside, after the Cloudflare and
# origin changes in docs/CLOUDFLARE_SSL.md.
#
#   deploy/verify-tls.sh app.example.com              # through Cloudflare
#   ORIGIN_IP=203.0.113.10 deploy/verify-tls.sh app.example.com
#
# With ORIGIN_IP set it also checks the origin directly, which is the only way
# to tell a correct Full (strict) setup from one where Cloudflare is quietly
# papering over a broken origin.
#
# Read-only on purpose. Every request below is an ordinary GET or HEAD that a
# browser makes anyway - this is a configuration check, not a penetration test,
# and it is safe to run against production. It does not attempt to bypass the
# WAF, does not flood the rate limiter and does not touch payment endpoints.
#
# Two switches exist so the script can be exercised against a local container
# before a domain exists - which is the only way to know the checks themselves
# work rather than merely that they run:
#   VERIFY_PORT=18443    talk to this port instead of 443
#   VERIFY_INSECURE=1    accept a self-signed certificate, and downgrade the
#                        chain and DNS checks to warnings
# Never set either against production: VERIFY_INSECURE turns off the one check
# that tells you Full (strict) will work.
source "$(dirname "$0")/lib.sh"
# lib.sh sets -e, which is right for a deploy script and wrong for this one:
# every check below is a command whose failure is the RESULT, counted and
# reported, not a reason to abandon the run half-way through. Keep -u, so a
# mistyped variable is still caught.
set +e +o pipefail
set -u

DOMAIN="${1:-}"
[ -n "$DOMAIN" ] || die "usage: deploy/verify-tls.sh <domain> (e.g. app.example.com)"
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"

PORT="${VERIFY_PORT:-443}"
HTTP_PORT="${VERIFY_HTTP_PORT:-80}"
LOCAL="${VERIFY_INSECURE:-0}"
BASE="https://$DOMAIN$([ "$PORT" = 443 ] || printf ':%s' "$PORT")"
HTTP_BASE="http://$DOMAIN$([ "$HTTP_PORT" = 80 ] || printf ':%s' "$HTTP_PORT")"
CURL_TLS=""
[ "$LOCAL" = "1" ] && CURL_TLS="-k"

fail=0; warned=0
note() { printf '  %-54s %s\n' "$1" "$2"; }
ok()   { note "$1" "$(c_green OK)"; }
bad()  { note "$1" "$(c_red FAIL)"; fail=$((fail+1)); }
warn() { note "$1" "$(c_yellow WARN)"; warned=$((warned+1)); }

# Headers for a URL. Follows nothing: a redirect is a result, not a detour.
# shellcheck disable=SC2086 # intentional word splitting for the optional flag
hdrs() { curl -sS $CURL_TLS --max-time 15 -o /dev/null -D - "$@" 2>/dev/null; }
hval() { printf '%s' "$1" | grep -i "^$2:" | head -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }

echo
echo "Verifying $BASE"
echo

# ---- DNS and the edge ----------------------------------------------------
echo "DNS and edge"
ips=$(dig +short "$DOMAIN" A 2>/dev/null | grep -E '^[0-9]' | tr '\n' ' ')
if [ -n "$ips" ]; then note "A records" "$ips"
elif [ "$LOCAL" = "1" ]; then warn "no A records (local run)"
else bad "A records resolve"; fi

# Proxied records answer from Cloudflare, so the response carries its headers.
root_h=$(hdrs "$BASE/")
if printf '%s' "$root_h" | grep -qi '^cf-ray:\|^server: cloudflare'; then
  ok "served through Cloudflare"
elif [ "$LOCAL" = "1" ]; then
  note "Cloudflare headers" "n/a (local run)"
else
  warn "no Cloudflare headers - is the DNS record proxied (orange cloud)?"
fi

# ---- TLS -----------------------------------------------------------------
echo
echo "TLS"
if echo | openssl s_client -connect "$DOMAIN:$PORT" -servername "$DOMAIN" 2>/dev/null | grep -q 'Verify return code: 0'; then
  ok "certificate chain valid for the public name"
elif [ "$LOCAL" = "1" ]; then
  warn "certificate not publicly valid (expected on a local run)"
else
  bad "certificate chain valid for the public name"
fi

for flag in tls1 tls1_1; do
  out=$(echo | openssl s_client -connect "$DOMAIN:$PORT" -servername "$DOMAIN" -$flag 2>&1)
  if printf '%s' "$out" | grep -q 'Protocol *: *TLSv1'  && printf '%s' "$out" | grep -q 'Cipher is [^(]'; then
    warn "${flag} accepted at the edge (a Cloudflare setting, not nginx)"
  else
    ok "${flag} refused"
  fi
done

# ---- the redirect --------------------------------------------------------
echo
echo "HTTP to HTTPS"
h=$(hdrs "$HTTP_BASE/")
code=$(printf '%s' "$h" | awk 'NR==1{print $2}')
loc=$(hval "$h" location)
case "$code" in
  301|302|308) case "$loc" in https://*) ok "http redirects to $loc" ;; *) bad "redirects, but not to https: $loc" ;; esac ;;
  *) bad "http did not redirect (status $code)" ;;
esac

# ---- document headers ----------------------------------------------------
echo
echo "Document headers"
doc=$(hdrs "$BASE/")
check_header() {
  local name="$1" want="$2" got
  got=$(hval "$doc" "$name")
  if [ -z "$got" ]; then bad "$name present"
  elif [ -n "$want" ] && ! printf '%s' "$got" | grep -q "$want"; then warn "$name present but unexpected: $got"
  else ok "$name"
  fi
}
check_header "strict-transport-security" "max-age=31536000"
check_header "content-security-policy" "default-src"
check_header "x-content-type-options" "nosniff"
check_header "x-frame-options" ""
check_header "referrer-policy" ""
check_header "permissions-policy" ""

# A CSP that forgets these breaks fonts and, worse, silently stops thermal
# receipt printing on every till.
csp=$(hval "$doc" content-security-policy)
for needle in 'fonts.googleapis.com' 'fonts.gstatic.com' 'wss://localhost' 'blob:'; do
  printf '%s' "$csp" | grep -q -- "$needle" && ok "CSP allows $needle" || bad "CSP is missing $needle"
done

# index.html must never be cached: it names the current asset bundle.
cc=$(hval "$doc" cache-control)
printf '%s' "$cc" | grep -qi 'no-store' && ok "index.html is not cached" || bad "index.html Cache-Control is '$cc'"
ncc=$(printf '%s' "$doc" | grep -ci '^cache-control')
[ "$ncc" = "1" ] && ok "exactly one Cache-Control" || warn "$ncc Cache-Control headers on one response"

# ---- API behaviour -------------------------------------------------------
echo
echo "API"
api=$(hdrs "$BASE/api/health")
acode=$(printf '%s' "$api" | awk 'NR==1{print $2}')
[ "$acode" = "200" ] && ok "/api/health reachable (200)" || bad "/api/health returned $acode"

acc=$(hval "$api" cache-control)
printf '%s' "$acc" | grep -qi 'no-store\|no-cache\|private' && ok "API responses are not cacheable" \
  || bad "API Cache-Control is '$acc' - a shared cache could serve one tenant's data to another"

# If Cloudflare were caching the API, this is where it would show.
cfc=$(hval "$api" cf-cache-status)
case "$cfc" in
  ""|BYPASS|DYNAMIC|MISS) ok "Cloudflare is not caching /api (${cfc:-no header})" ;;
  HIT|EXPIRED|REVALIDATED) bad "Cloudflare cache status on /api is $cfc - add the bypass rule NOW" ;;
  *) warn "unrecognised cf-cache-status on /api: $cfc" ;;
esac

# Assets are fingerprinted and should be cacheable - the opposite requirement.
asset=$(curl -sS $CURL_TLS --max-time 15 "$BASE/" 2>/dev/null | grep -oE '/assets/[A-Za-z0-9._-]+\.js' | head -1)
if [ -n "$asset" ]; then
  ah=$(hdrs "$BASE$asset")
  hval "$ah" cache-control | grep -q 'immutable' && ok "assets are immutable" || warn "asset Cache-Control: $(hval "$ah" cache-control)"
else
  warn "could not find an asset URL in the document to check"
fi

# ---- origin exposure -----------------------------------------------------
echo
echo "Origin exposure"
if [ -n "${ORIGIN_IP:-}" ]; then
  # A plain TCP connect, nothing more. If the firewall is restricted to
  # Cloudflare this times out, which is the desired result.
  if curl -sS --max-time 8 -o /dev/null "http://$ORIGIN_IP/" 2>/dev/null; then
    bad "origin answers port 80 directly - the edge can be bypassed, so WAF and edge rate limits can be skipped"
  else
    ok "origin port 80 not reachable from here"
  fi
  if curl -sSk --max-time 8 -o /dev/null "https://$ORIGIN_IP/" 2>/dev/null; then
    warn "origin answers port 443 directly - acceptable only if ufw is restricted to Cloudflare and this host is allowed"
  else
    ok "origin port 443 not reachable from here"
  fi
else
  warn "ORIGIN_IP not set - skipped the direct-to-origin check (set it to verify the firewall)"
fi

# ---- summary -------------------------------------------------------------
echo
if [ "$fail" -gt 0 ]; then
  c_red "$fail check(s) failed, $warned warning(s)."
  exit 1
fi
[ "$warned" -gt 0 ] && c_yellow "All checks passed, with $warned warning(s)." || c_green "All checks passed."
exit 0
