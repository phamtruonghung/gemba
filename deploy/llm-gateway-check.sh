#!/usr/bin/env bash
# Prove the answering tier actually works through the configured gateway, before any deploy.
#
# Two questions, because one is not evidence: a gateway that answers everything (or nothing) passes
# a single probe. This asks something the corpus covers and expects a *cited* answer, then asks
# something it does not cover and expects a refusal — the contract the product is sold on.
#
# Usage: bash deploy/llm-gateway-check.sh [base_url] [model]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CHECK_PORT:-8096}"
DB="$(mktemp -u)/gemba-check.db"
mkdir -p "$(dirname "$DB")"
BASE_URL="${1:-${GEMBA_LLM_BASE_URL:-https://opencode.ai/zen/go/v1}}"
MODEL="${2:-${GEMBA_LLM_MODEL:-deepseek-v4.1-flash}}"

if [ -f /root/.hermes/.env ]; then
  set -a; . /root/.hermes/.env; set +a
fi
for candidate in GEMBA_LLM_KEY OPENCODE_GO_API_KEY OPENROUTER_API_KEY; do
  if [ -n "${!candidate:-}" ]; then KEY="${!candidate}"; KEY_FROM="$candidate"; break; fi
done
[ -n "${KEY:-}" ] || { echo "no LLM key in the environment — refusing to run"; exit 2; }

echo "gateway: $BASE_URL"
echo "model:   $MODEL"
echo "key:     from \$$KEY_FROM (not printed)"

( cd "$ROOT" && GEMBA_DB="$DB" node scripts/seed.mjs >/dev/null )
GEMBA_PORT="$PORT" GEMBA_DB="$DB" GEMBA_LLM_KEY="$KEY" GEMBA_LLM_BASE_URL="$BASE_URL" GEMBA_LLM_MODEL="$MODEL" \
  setsid node src/server.mjs >/tmp/gemba-gateway-check.log 2>&1 < /dev/null &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 40); do
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/healthz")" = "200" ]; then break; fi
  sleep 0.25
done
echo "--- what the app thinks it is talking to:"
curl -s "http://127.0.0.1:$PORT/healthz"

ask() {
  curl -s -X POST "http://127.0.0.1:$PORT/api/ask" \
    -H 'content-type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"question": sys.argv[1], "plant_type": "electronics assembly"}))' "$1")"
}

echo "--- on-corpus question: expect mode llm and at least one cited note"
ON="$(ask 'the machine stops mid-shift, what should I check and in what order')"
echo "$ON" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("mode:", d.get("mode"), "| coverage:", d.get("coverage"), "| why:", (d.get("why") or "")[:60])
print("citations:", [c.get("title") for c in d.get("citations", [])])
print("answer starts:", (d.get("answer") or "")[:160].replace("\n"," "))
assert d.get("mode") == "llm", "not answered by the model"
assert d.get("citations"), "no citations returned"
'

echo "--- off-corpus question: expect a refusal, not a plausible guess"
OFF="$(ask 'what is a good CRM for my sales team')"
echo "$OFF" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("mode:", d.get("mode"), "| coverage:", d.get("coverage"), "| why:", (d.get("why") or "")[:60])
print("refused:", d.get("coverage") == "thin")
print("answer starts:", (d.get("answer") or "")[:160].replace("\n"," "))
assert d.get("coverage") == "thin", "an off-corpus question was not refused"
'

echo "OK — the gateway answers with citations, and refuses what the corpus cannot cover"
