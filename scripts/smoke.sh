#!/usr/bin/env bash
# scripts/smoke.sh — walk the live instance the way a customer does, and print what came back.
# Usage: BASE=http://127.0.0.1:8090 EXPERT_TOKEN=… ADMIN=… scripts/smoke.sh
set -u
BASE="${BASE:-http://127.0.0.1:8090}"
EXPERT="${EXPERT_TOKEN:-demo-hung-7f3a91}"
ADMIN="${ADMIN:-$(cat data/admin.token 2>/dev/null || true)}"
j() { python3 -c "import json,sys;d=json.load(sys.stdin);print(json.dumps(d,ensure_ascii=False)[:$1])"; }

echo "── 1. health"
curl -s "$BASE/healthz" | j 400

echo
echo "── 2. an off-corpus question must refuse, not guess"
REF=$(curl -s -X POST "$BASE/api/ask" -H 'content-type: application/json' \
  -d '{"question":"how do I handle office recruitment and the salary policy?","asker":"Test client","contact":"thu@example.com"}' \
  | tee /tmp/smoke-ask.json | python3 -c "import json,sys;print(json.load(sys.stdin)['ref'])")
python3 - <<'PY'
import json
d = json.load(open('/tmp/smoke-ask.json'))
print('   coverage :', d['coverage'], '| mode:', d['mode'])
print('   why      :', d['why'])
print('   answer   :', d['answer'][:160].replace('\n', ' '))
PY
echo "   ref      : $REF"

echo
echo "── 3. escalate it to a practitioner"
curl -s -o /dev/null -w '   POST /q/<ref>/ask-expert → %{http_code}\n' -X POST "$BASE/q/$REF/ask-expert" \
  --data-urlencode "asker=Test client" --data-urlencode "contact=thu@example.com"
curl -s "$BASE/api/question/$REF" | python3 -c "import json,sys;d=json.load(sys.stdin);print('   status:',d['status'],'| due:',d['due_at'],'| expert_id:',d['expert_id'])"

echo
echo "── 4. the expert works the queue"
curl -s -o /dev/null -w '   GET /c/<token> → %{http_code}\n' "$BASE/c/$EXPERT"
curl -s -o /dev/null -w '   POST answer → %{http_code}\n' -X POST "$BASE/c/$EXPERT/answer" \
  --data-urlencode "ref=$REF" --data-urlencode "body=A seasonal contract has to state its term and any annex; check the termination clause before signing."
curl -s "$BASE/api/question/$REF" | python3 -c "import json,sys;d=json.load(sys.stdin);print('   status:',d['status'],'| answers:',len(d['answers']))"

echo
echo "── 5. booking: VND, split, transfer instruction, operator confirms"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/book" \
  --data-urlencode "expert=hung-qa" --data-urlencode "minutes=60" --data-urlencode "starts_at=2026-10-20 20:00" \
  --data-urlencode "asker=Test client" --data-urlencode "contact=thu@example.com" --data-urlencode "topic=tpm" \
  --data-urlencode "agenda=The line keeps stopping at the last station; I need an order to check things in.")
BREF="${LOC##*/}"
echo "   booking  : $LOC"
curl -s "$BASE$LOC" | grep -oE '(800,000 VND|640,000 VND|160,000 VND|img\.vietqr\.io[^"]{0,40}|waiting for transfer instructions)' | sort -u | sed 's/^/     /'
curl -s -o /dev/null -w '   customer says paid → %{http_code}\n' -X POST "$BASE/b/$BREF/transferred"
if [ -n "$ADMIN" ]; then
  curl -s -o /dev/null -w '   operator confirms  → %{http_code}\n' -X POST "$BASE/qt/$ADMIN/confirm" --data-urlencode "ref=$BREF"
  curl -s "$BASE/b/$BREF" | grep -oE 'payment received' | head -2 | sed 's/^/     /'
fi

echo
echo "── 6. the gate at the door"
# Deliberately a Vietnamese note with an employer's order number and price: the corpus is published
# in English, but the rules have to catch a Vietnamese note too — that is the language the raw notes
# are actually written in, so this is the case that matters most.
curl -s -o /tmp/smoke-gate.html -w '   note with an order number + price → %{http_code}\n' -X POST "$BASE/c/$EXPERT/note" \
  --data-urlencode "title=Handling a bad batch" --data-urlencode "topic=quality" --data-urlencode "attested=1" \
  --data-urlencode "body=$(printf '# Kinh nghiệm\n\n## Bối cảnh\nLô theo PO 45123 lỗi, đơn giá nhập cao hơn kế hoạch.\n\n## Cách làm\nKiểm tra theo thứ tự trước khi sửa.')"
grep -oE 'document|person_name|figure|block_term' /tmp/smoke-gate.html | sort -u | sed 's/^/     rule: /'

echo
echo "── 7. counters"
curl -s "$BASE/healthz" | j 200
