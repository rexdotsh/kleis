#!/usr/bin/env bash
set -euo pipefail

CADDY_ADMIN="${CADDY_ADMIN:-http://localhost:2019}"
STATE_FILE="active-slot"
LEGACY_CONTAINER=kleis-app

log() {
  printf '[%ss] %s\n' "$SECONDS" "$*"
}

compose() {
  docker compose -f docker-compose.deploy.yml "$@"
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

healthy() {
  curl -fsS --max-time 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1
}

in_flight() {
  curl -fsS --max-time 2 "$CADDY_ADMIN/reverse_proxy/upstreams" |
    jq -r --arg address "127.0.0.1:$1" \
      '[.[] | select(.address == $address) | .num_requests] | add // 0'
}

# The legacy container exits on SIGTERM without draining, so wait until Caddy
# has no requests in flight to it.
retire_legacy() {
  local deadline
  deadline=$(($(date +%s) + 900))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if [ "$(in_flight 3003 2>/dev/null || true)" = "0" ]; then
      break
    fi
    sleep 2
  done
  docker stop -t 10 "$LEGACY_CONTAINER" >/dev/null 2>&1 || true
  docker rm "$LEGACY_CONTAINER" >/dev/null 2>&1 || true
}

if [ "${1:-}" = "retire-legacy" ]; then
  retire_legacy
  exit 0
fi

: "${KLEIS_APP_IMAGE:?set KLEIS_APP_IMAGE}"
: "${KLEIS_MIGRATE_IMAGE:?set KLEIS_MIGRATE_IMAGE}"

case "$(cat "$STATE_FILE" 2>/dev/null || true)" in
  blue) active=blue active_container=kleis-blue active_port=3003 target=green ;;
  green) active=green active_container=kleis-green active_port=3004 target=blue ;;
  *) active=legacy active_container=$LEGACY_CONTAINER active_port=3003 target=green ;;
esac
if [ "$target" = "blue" ]; then
  target_port=3003
else
  target_port=3004
fi
target_container="kleis-$target"
log "Deploying $KLEIS_APP_IMAGE to $target (:$target_port); $active is serving"

if ! healthy "$active_port"; then
  if is_running "$target_container" && healthy "$target_port"; then
    echo "$STATE_FILE says $active, but only $target is serving. Fix $STATE_FILE by hand." >&2
    exit 1
  fi
  echo "Warning: nothing is serving; deploying anyway." >&2
fi

compose pull migrate "app-$target"
log "Images pulled; applying migrations"
# A stopped service container pins the migration image through image pruning.
compose up --no-deps --force-recreate --exit-code-from migrate migrate
log "Migrations complete"

if is_running "$target_container"; then
  log "Draining $target_container before reuse"
  docker stop -t 900 "$target_container" >/dev/null
  log "$target_container ready for reuse"
fi
if [ "$target" = "blue" ] && is_running "$LEGACY_CONTAINER"; then
  echo "Waiting for $LEGACY_CONTAINER to finish its requests"
  retire_legacy
fi

compose up -d --no-deps "app-$target"
log "New slot started; waiting for health"

for _ in $(seq 1 60); do
  if healthy "$target_port"; then
    break
  fi
  sleep 1
done
if ! healthy "$target_port"; then
  echo "New release never became healthy; $active keeps serving." >&2
  docker logs --tail 50 "$target_container" >&2 || true
  setsid nohup docker stop -t 900 "$target_container" >/dev/null 2>&1 </dev/null &
  exit 1
fi
log "New slot healthy"

printf '%s\n' "$target" >"$STATE_FILE.tmp"
mv "$STATE_FILE.tmp" "$STATE_FILE"

# Give Caddy's health check time to see the new slot before the old one drains.
sleep 4

if [ "$active" = "legacy" ]; then
  if is_running "$LEGACY_CONTAINER"; then
    echo "Retiring $LEGACY_CONTAINER after its in-flight requests"
    setsid nohup "$0" retire-legacy >/dev/null 2>&1 </dev/null &
  fi
elif is_running "$active_container"; then
  log "Draining $active_container in the background"
  setsid nohup docker stop -t 900 "$active_container" >/dev/null 2>&1 </dev/null &
fi

docker image prune -af >/dev/null
log "Release live on $target"
