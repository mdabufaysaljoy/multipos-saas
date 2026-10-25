#!/usr/bin/env bash
# Rolls the APPLICATION back to a previous image revision.
#
#   deploy/rollback.sh              # to the recorded previous revision
#   deploy/rollback.sh abc1234      # to a specific one
#
# WHAT THIS DOES NOT DO, and the distinction matters:
#
# It changes which IMAGE runs. It does not touch MongoDB, Redis or the uploads
# volume, and it does not undo a data change. If the revision you are leaving
# wrote data in a shape the older code cannot read - a new required field, a
# renamed field, a migration - then rolling the image back is not enough and you
# need a database restore as well, which is a separate, slower decision with
# data loss attached. Application rollback and data recovery are different
# operations; see docs/VPS_DEPLOYMENT.md, "Rollback".
source "$(dirname "$0")/lib.sh"
require_env_file

TARGET="${1:-$(cat deploy/state/previous 2>/dev/null || true)}"
[ -n "$TARGET" ] || die "No previous revision recorded. Pass one explicitly: deploy/rollback.sh <git-rev>"

for img in "${IMAGE_REPO:-retailer-suites}:${TARGET}" "${IMAGE_REPO:-retailer-suites}-web:${TARGET}"; do
  docker image inspect "$img" >/dev/null 2>&1 \
    || die "Image $img is not on this host. Rebuild it from that revision: IMAGE_TAG=$TARGET deploy/build.sh"
done

current=$(cat deploy/state/current 2>/dev/null || echo unknown)
echo
c_yellow "Rolling back:  ${current}  ->  ${TARGET}"
echo "Volumes (MongoDB, Redis, uploads) are left untouched."
echo
printf 'Type the target revision to confirm: '
read -r answer
[ "$answer" = "$TARGET" ] || die "Not confirmed."

export IMAGE_TAG="$TARGET"
compose up -d --no-build
echo "$TARGET" > deploy/state/current
echo
compose ps
echo
echo "Verify it:  IMAGE_TAG=$TARGET deploy/health.sh"
