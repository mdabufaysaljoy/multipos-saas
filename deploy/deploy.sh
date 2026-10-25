#!/usr/bin/env bash
# Starts or updates the production stack at a given revision.
#
# Safe by default: it never removes a volume, never prunes, and refuses to run
# with uncommitted changes. It is idempotent - running it twice at the same
# revision leaves the same thing running.
#
#   deploy/deploy.sh                 # deploy HEAD
#   IMAGE_TAG=abc1234 deploy/deploy.sh
source "$(dirname "$0")/lib.sh"

require_env_file
[ "${ALLOW_DIRTY:-0}" = "1" ] || require_clean_tree
TAG="$(resolve_tag)"
export IMAGE_TAG="$TAG"

echo
echo "Deploying revision ${TAG}"
[ "${SELF_HOSTED_MONGO:-0}" = "1" ] && c_yellow "Self-hosted MongoDB override is ON." || echo "Database: external (Atlas), per MONGODB_URI"
echo

# The image must already exist. Building is a separate, explicit step so a
# deploy never silently ships something that was never built or tested.
for img in "${IMAGE_REPO:-retailer-suites}:${TAG}" "${IMAGE_REPO:-retailer-suites}-web:${TAG}"; do
  docker image inspect "$img" >/dev/null 2>&1 || die "Image $img not found. Run deploy/build.sh first."
done

# Record what is running now, so rollback has a target.
mkdir -p deploy/state
if [ -f deploy/state/current ]; then cp deploy/state/current deploy/state/previous; fi
echo "$TAG" > deploy/state/current

compose up -d --no-build
echo
echo "Waiting for health..."
for i in $(seq 1 90); do
  api=$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q api)" 2>/dev/null || echo starting)
  web=$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q web)" 2>/dev/null || echo starting)
  [ "$api" = "healthy" ] && [ "$web" = "healthy" ] && { c_green "api and web healthy after ${i}s"; break; }
  sleep 1
done

echo
compose ps
echo
echo "Verify it:  deploy/health.sh"
echo "Roll back:  deploy/rollback.sh"
