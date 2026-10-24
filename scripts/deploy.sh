#!/usr/bin/env bash
# Deploys a published image of the hub and goes back to the previous one when the new one does not become healthy.
#
#   scripts/deploy.sh            # the newest image (the `latest` tag)
#   scripts/deploy.sh sha-1a2b3c4   # a given tag: also how you roll back by hand
#
# Run it in gate/ (next to docker-compose.yml) as a user that may use Docker. Each deployment prints the tag it replaced.
set -euo pipefail

cd "$(dirname "$0")/../gate"

tag="${1:-latest}"
service="gate"
container="mindgate-gate"
image="ghcr.io/prod-explore/mindgate-hub"
wait_seconds="${DEPLOY_WAIT_SECONDS:-90}"

previous_id="$(docker inspect --format '{{.Image}}' "$container" 2>/dev/null || true)"
previous_ref="$(docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true)"

healthy() {
  local deadline=$((SECONDS + wait_seconds))
  while ((SECONDS < deadline)); do
    case "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container" 2>/dev/null)" in
      healthy) return 0 ;;
      unhealthy | exited | dead) return 1 ;;
    esac
    sleep 2
  done
  return 1
}

echo "Pulling ${image}:${tag}"
MINDGATE_IMAGE_TAG="$tag" docker compose pull "$service"

echo "Starting it (was: ${previous_ref:-nothing})"
MINDGATE_IMAGE_TAG="$tag" docker compose up -d --no-deps "$service"

if healthy; then
  echo "${container} is healthy on ${image}:${tag}"
  exit 0
fi

echo "${container} did not become healthy within ${wait_seconds}s" >&2
docker logs --tail 20 "$container" >&2 || true
if [[ -n "$previous_id" ]]; then
  echo "Going back to the previous image (${previous_id#sha256:})" >&2
  docker tag "$previous_id" "${image}:rollback"
  MINDGATE_IMAGE_TAG=rollback docker compose up -d --no-deps "$service"
  healthy && echo "Rolled back; ${container} is healthy again" >&2 || echo "The rollback is not healthy either" >&2
fi
exit 1
