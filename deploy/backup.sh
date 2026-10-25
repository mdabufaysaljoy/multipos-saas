#!/usr/bin/env bash
# Takes an encrypted backup of the data that cannot be rebuilt.
#
#   deploy/backup.sh                 # MongoDB (if self-hosted) + uploads
#   RESTORE_TEST=1 deploy/backup.sh  # ...and verify the archive can be read back
#
# WHAT IS AND IS NOT COVERED
#
#   uploads       always. Product images and logos exist nowhere else.
#   MongoDB       only when self-hosted. With Atlas, Atlas takes the backups -
#                 but check what your TIER actually provides: the M0 free tier
#                 has no scheduled backups and no point-in-time restore, so a
#                 free-tier production deployment has NO database backup unless
#                 you add one. This script will say so.
#   secrets       NOT backed up, deliberately. .env.production is the one file
#                 that must be kept somewhere else entirely - a password
#                 manager, not an archive sitting next to the data it unlocks.
#
# OFF-SERVER IS THE POINT. A backup on the same disk as the database protects
# against a bad deploy and nothing else - not disk failure, not a lost server,
# not ransomware. BACKUP_DEST must be somewhere else; the script refuses to
# pretend a local-only copy is a backup.
source "$(dirname "$0")/lib.sh"
require_env_file
# The compose files declare IMAGE_TAG as required, so even a read-only
# `compose ps` needs it resolved.
export IMAGE_TAG="${IMAGE_TAG:-$(cat deploy/state/current 2>/dev/null || resolve_tag)}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT="${BACKUP_DIR:-./backups}"
mkdir -p "$OUT"

[ -n "${BACKUP_PASSPHRASE:-}" ] || die "BACKUP_PASSPHRASE is unset. An unencrypted backup of a POS database is a data breach waiting for a lost disk."
command -v openssl >/dev/null || die "openssl is required to encrypt the archive."

echo "Backup ${STAMP}"

# ---- uploads -------------------------------------------------------------
echo "  uploads..."
api_id="$(compose ps -q api 2>/dev/null || true)"
[ -n "$api_id" ] || die "The api container is not running; cannot read the uploads volume."
docker run --rm --volumes-from "$api_id" -v "$WORK:/out" alpine:3.20 \
  tar czf /out/uploads.tar.gz -C /app/server uploads
echo "    $(du -h "$WORK/uploads.tar.gz" | cut -f1)"

# ---- MongoDB -------------------------------------------------------------
if [ "${SELF_HOSTED_MONGO:-0}" = "1" ]; then
  echo "  mongodb (self-hosted)..."
  compose exec -T mongo mongodump --archive --gzip --quiet > "$WORK/mongo.archive.gz"
  echo "    $(du -h "$WORK/mongo.archive.gz" | cut -f1)"
else
  echo "  mongodb: SKIPPED - external (Atlas)."
  c_yellow "    Confirm your Atlas tier actually takes backups. The M0 free tier does not."
  echo "atlas: backups are the provider's responsibility for this deployment" > "$WORK/mongo.README"
fi

# ---- configuration (no secrets) -----------------------------------------
tar czf "$WORK/config.tar.gz" docker-compose.prod.yml docker/ deploy/ \
  --exclude='deploy/state' 2>/dev/null || true

# ---- one encrypted archive ----------------------------------------------
ARCHIVE="$OUT/retailer-suites-${STAMP}.tar.gz.enc"
tar czf - -C "$WORK" . | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -pass env:BACKUP_PASSPHRASE -out "$ARCHIVE"
chmod 600 "$ARCHIVE"
echo "  encrypted -> $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"

# ---- prove it can be read back ------------------------------------------
if [ "${RESTORE_TEST:-0}" = "1" ]; then
  echo "  restore test..."
  V="$(mktemp -d)"; trap 'rm -rf "$WORK" "$V"' EXIT
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:BACKUP_PASSPHRASE -in "$ARCHIVE" | tar xzf - -C "$V"
  [ -f "$V/uploads.tar.gz" ] && tar tzf "$V/uploads.tar.gz" >/dev/null && c_green "    uploads archive is readable"
  [ -f "$V/mongo.archive.gz" ] && { gzip -t "$V/mongo.archive.gz" && c_green "    mongo archive is readable"; }
  c_green "    decryption and listing succeeded"
  echo "    NOTE: this proves the archive is intact. It does NOT prove a restore"
  echo "          into a running system works - that needs a real restore drill"
  echo "          against a scratch database. See docs/VPS_DEPLOYMENT.md."
fi

# ---- off-server ----------------------------------------------------------
if [ -n "${BACKUP_DEST:-}" ]; then
  echo "  copying off-server to ${BACKUP_DEST}..."
  case "$BACKUP_DEST" in
    s3://*|r2://*) command -v aws >/dev/null && aws s3 cp "$ARCHIVE" "$BACKUP_DEST/" || die "aws CLI not installed." ;;
    *:*)           scp "$ARCHIVE" "$BACKUP_DEST/" ;;
    *)             cp "$ARCHIVE" "$BACKUP_DEST/" ;;
  esac
  c_green "  copied off-server"
else
  c_red "  BACKUP_DEST is unset: this copy is on the SAME SERVER as the data."
  c_red "  That is not a backup. Set BACKUP_DEST before relying on this."
fi

# Retention, local copies only.
KEEP="${BACKUP_KEEP:-7}"
ls -1t "$OUT"/retailer-suites-*.tar.gz.enc 2>/dev/null | tail -n +$((KEEP+1)) | while read -r old; do
  echo "  pruning local $old"; rm -f "$old"
done
echo
c_green "Done."
