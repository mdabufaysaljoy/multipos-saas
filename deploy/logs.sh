#!/usr/bin/env bash
# Log inspection. Read-only.
#
#   deploy/logs.sh              # follow everything
#   deploy/logs.sh api          # one service
#   deploy/logs.sh worker 200   # last 200 lines, no follow
source "$(dirname "$0")/lib.sh"
export IMAGE_TAG="${IMAGE_TAG:-$(cat deploy/state/current 2>/dev/null || resolve_tag)}"

svc="${1:-}"
tail_n="${2:-}"
if [ -n "$tail_n" ]; then compose logs --tail "$tail_n" ${svc:+"$svc"}; else compose logs -f --tail 100 ${svc:+"$svc"}; fi
