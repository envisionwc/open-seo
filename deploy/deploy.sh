#!/usr/bin/env bash
# Deploy OpenSEO to the MCAG VPS from this fork.
#
# Pulls this fork's main into the VPS checkout, rebuilds the image, recreates
# ONLY the open-seo service, then waits for the health endpoint.
#
# Deliberately touches nothing else on the host: the crew stack is a separate
# compose project ("deploy") on a separate network, and is never referenced
# here. There is no rsync and no --delete anywhere in this script.
#
# Usage:  ./deploy/deploy.sh [--no-build]
set -euo pipefail

VPS_HOST="${VPS_HOST:-mcag-vps}"
VPS_PATH="${VPS_PATH:-/root/open-seo}"
COMPOSE="${VPS_PATH}/deploy/docker-compose.yml"
HEALTH_PORT="${HEALTH_PORT:-3001}"
DO_BUILD=1

[ "${1:-}" = "--no-build" ] && DO_BUILD=0

say() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

say "Syncing ${VPS_HOST}:${VPS_PATH} to origin/main"
ssh "$VPS_HOST" "git -C ${VPS_PATH} fetch --prune origin"
ssh "$VPS_HOST" "git -C ${VPS_PATH} reset --hard origin/main"
ssh "$VPS_HOST" "git -C ${VPS_PATH} log --oneline -1"

# deploy/.env lives only on the VPS and is gitignored, so reset --hard above
# leaves it alone. Fail loudly rather than booting a container with no config.
say "Checking deploy/.env exists on the VPS"
ssh "$VPS_HOST" "test -f ${VPS_PATH}/deploy/.env" || {
  echo "MISSING ${VPS_PATH}/deploy/.env — copy deploy/.env.example there and fill it in." >&2
  exit 1
}

if [ "$DO_BUILD" = 1 ]; then
  say "Building image (slow: full pnpm install on 2 cores)"
  ssh "$VPS_HOST" "docker compose -f ${COMPOSE} build open-seo"
fi

say "Recreating the open-seo service"
ssh "$VPS_HOST" "docker compose -f ${COMPOSE} up -d open-seo"

# First start after a fresh container runs the vite SSR build before it serves,
# so allow several minutes before calling it a failure.
say "Waiting for /api/health (up to 10 min; first start builds the app)"
for i in $(seq 1 60); do
  if ssh "$VPS_HOST" "curl -fsS -m 5 http://127.0.0.1:${HEALTH_PORT}/api/health" >/dev/null 2>&1; then
    say "Healthy."
    ssh "$VPS_HOST" "curl -fsS http://127.0.0.1:${HEALTH_PORT}/api/health"
    echo
    exit 0
  fi
  printf '.'
  sleep 10
done

echo
echo "Never became healthy. Last 40 log lines:" >&2
ssh "$VPS_HOST" "docker compose -f ${COMPOSE} logs --tail=40 open-seo" >&2
exit 1
