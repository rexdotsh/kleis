#!/usr/bin/env bash
# Zero-downtime release on the deploy host. Runs from the directory holding
# docker-compose.deploy.yml and .env, with KLEIS_APP_IMAGE and
# KLEIS_MIGRATE_IMAGE set.
#
# Caddy proxies to 127.0.0.1:3003 (blue) and 127.0.0.1:3004 (green) with
# active health checks on /healthz, so traffic follows whichever is healthy.
set -euo pipefail

: "${KLEIS_APP_IMAGE:?set KLEIS_APP_IMAGE}"
: "${KLEIS_MIGRATE_IMAGE:?set KLEIS_MIGRATE_IMAGE}"

compose() {
  docker compose -f docker-compose.deploy.yml "$@"
}

is_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

healthy() {
  curl -fsS --max-time 2 "http://127.0.0.1:$1/healthz" >/dev/null 2>&1
}

# Deploy to the slot that is not serving. Health probes can't decide this: a
# slot that just started draining still passes for a few seconds. With no
# record yet, the pre-blue/green container owns :3003, so start with green.
state_file=active-slot
if [ "$(cat "$state_file" 2>/dev/null || true)" = "green" ]; then
  target=blue
  target_port=3003
else
  target=green
  target_port=3004
fi
target_container="kleis-$target"
echo "Deploying $KLEIS_APP_IMAGE to $target (:$target_port)"

compose pull migrate "app-$target"
compose run --rm --interactive=false migrate

# Back-to-back releases: the target port may still be held by a release that
# is finishing its streams. Wait for it rather than cutting those streams.
port_holders=("$target_container")
if [ "$target" = "blue" ]; then
  port_holders+=(kleis-app)
fi
for holder in "${port_holders[@]}"; do
  if is_running "$holder"; then
    echo "Waiting for $holder to finish draining"
    if ! timeout 960 docker wait "$holder" >/dev/null; then
      docker stop -t 10 "$holder" >/dev/null
    fi
  fi
done
compose up -d --no-deps "app-$target"

for _ in $(seq 1 60); do
  if healthy "$target_port"; then
    break
  fi
  sleep 1
done
if ! healthy "$target_port"; then
  echo "New release never became healthy; the previous release keeps serving." >&2
  docker logs --tail 50 "$target_container" >&2 || true
  docker stop -t 5 "$target_container" >/dev/null || true
  exit 1
fi

echo "$target" >"$state_file"

# Let Caddy's 2s health check mark the new slot healthy before draining.
sleep 4

# SIGTERM makes the old release fail health checks, refuse new connections
# after a short grace period, and exit once in-flight streams finish. Run it
# detached so the deploy does not wait for long streams.
for old in kleis-app kleis-blue kleis-green; do
  if [ "$old" = "$target_container" ] || ! is_running "$old"; then
    continue
  fi
  echo "Draining $old"
  if [ "$old" = "kleis-app" ]; then
    # Container from before blue/green; remove it once stopped.
    setsid nohup sh -c "docker stop -t 900 $old && docker rm $old" \
      >/dev/null 2>&1 </dev/null &
  else
    setsid nohup docker stop -t 900 "$old" >/dev/null 2>&1 </dev/null &
  fi
done

docker image prune -af >/dev/null
echo "Release live on $target"
