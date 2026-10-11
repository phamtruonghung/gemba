#!/usr/bin/env bash
# deploy/docker-smoke.sh — build the image, run it, walk the ladder through the container, clean up.
#
# "It builds" is not "it works": this starts the container the way a deployment would, checks the
# front gate from the outside, asks a real question (so a missing key or no outbound network shows
# up here rather than in front of a customer), shows what landed in the volume, and removes
# everything afterwards.
#
# Usage:  [ENV_FILE=/etc/xuong/xuong.env] [PORT=8091] deploy/docker-smoke.sh
set -euo pipefail

ENV_FILE="${ENV_FILE:-}"
PORT="${PORT:-8091}"
NAME="${NAME:-xuong-smoke}"
VOL="${NAME}-data"
IMAGE="${IMAGE:-xuong:smoke}"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "-> build $IMAGE"
docker build -t "$IMAGE" .

ARGS=(-d --name "$NAME" -p "$PORT:8090" -v "$VOL:/data")
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  ARGS+=(--env-file "$ENV_FILE")
  echo "-> configuration from $ENV_FILE"
fi
docker run "${ARGS[@]}" "$IMAGE" >/dev/null

echo "-> wait for the health probe"
ok=""
for _ in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then ok=1; break; fi
  sleep 2
done
if [ -z "$ok" ]; then
  echo "!! the container never became healthy"
  docker logs "$NAME"
  exit 1
fi
curl -s "http://127.0.0.1:$PORT/healthz"; echo
echo "-> container log (first lines)"
# sed, not head: under `set -o pipefail` a reader that exits early sends SIGPIPE to docker and the
# pipeline reports failure, which `set -e` then treats as a script error.
docker logs "$NAME" 2>&1 | sed -n '1,6p'

# The gate. If XUONG_USER/XUONG_PASS came in through the environment, the container must refuse an
# open request and admit a credentialed one — this is the check that catches the "gate configured
# but instance still open" class of defect.
U="$(grep -m1 '^XUONG_USER=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
P="$(grep -m1 '^XUONG_PASS=' "$ENV_FILE" 2>/dev/null | cut -d= -f2- || true)"
if [ -n "$U" ] && [ -n "$P" ]; then
  code_open="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
  code_auth="$(curl -s -o /dev/null -w '%{http_code}' -u "$U:$P" "http://127.0.0.1:$PORT/")"
  echo "-> front gate: unauth=$code_open auth=$code_auth"
  [ "$code_open" = "401" ] || { echo "!! the container answered $code_open without credentials"; exit 1; }
  [ "$code_auth" = "200" ] || { echo "!! the credentials did not get in ($code_auth)"; exit 1; }
  AUTH=(-u "$U:$P")
else
  echo "-> front gate: not configured (local-development run)"
  AUTH=()
fi

echo "-> a real question through the container"
curl -s -m 120 "${AUTH[@]}" -X POST "http://127.0.0.1:$PORT/api/ask" \
  -H 'content-type: application/json' \
  -d '{"question":"the machine stops mid-shift — what should I check, and in what order?"}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print("   coverage:", d["coverage"], "| mode:", d["mode"], "| cited:", [c["title"] for c in d["citations"]])'

echo "-> what the container wrote to its volume"
docker run --rm -v "$VOL:/data" alpine ls -l /data

echo "-> image size: $(docker images "$IMAGE" --format '{{.Size}}')"
echo "OK — container and volume removed"
