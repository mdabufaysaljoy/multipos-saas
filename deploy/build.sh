#!/usr/bin/env bash
# Builds the two production images, tagged with the git revision.
#
#   deploy/build.sh                      # for this machine's architecture
#   PLATFORM=linux/amd64 deploy/build.sh # for an amd64 VPS, from an arm64 Mac
#   TLS=1 deploy/build.sh                # also build the TLS-terminating web image
#
# Building ON the target server is simplest and avoids emulation entirely. Only
# cross-build when you cannot.
source "$(dirname "$0")/lib.sh"

TAG="$(resolve_tag)"
REPO="${IMAGE_REPO:-retailer-suites}"
# Built as a string rather than an array: an empty array expansion trips
# `set -u` on bash 3.2, which is what macOS still ships.
PLATFORM_ARG=""
[ -n "${PLATFORM:-}" ] && PLATFORM_ARG="--platform $PLATFORM"

echo "Building ${REPO}:${TAG}${PLATFORM:+ for $PLATFORM}"
[ -n "${PLATFORM:-}" ] && [ "$PLATFORM" != "linux/$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')" ] \
  && c_yellow "NOTE: cross-building under emulation. It proves the image BUILDS; it is not a substitute for starting it on the real architecture."

# shellcheck disable=SC2086 # intentional word splitting for the optional flag
docker build $PLATFORM_ARG -f docker/Dockerfile --target server -t "${REPO}:${TAG}" .
# shellcheck disable=SC2086
docker build $PLATFORM_ARG -f docker/Dockerfile --target web    -t "${REPO}-web:${TAG}" .

# The TLS-terminating variant, for a deployment behind Cloudflare with an
# origin certificate. Opt-in because it is only useful once a certificate
# exists on the host; see docs/CLOUDFLARE_SSL.md.
if [ "${TLS:-0}" = "1" ]; then
  # shellcheck disable=SC2086
  docker build $PLATFORM_ARG -f docker/Dockerfile --target web-tls -t "${REPO}-web-tls:${TAG}" .
fi

echo
c_green "Built:"
docker image ls --format '  {{.Repository}}:{{.Tag}}  {{.Size}}' | grep -E "^  ${REPO}(-web|-web-tls)?:${TAG}" || true
echo
echo "Deploy it with:  IMAGE_TAG=${TAG} deploy/deploy.sh"
