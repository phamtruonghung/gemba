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
  -d '{"question":"thủ tục tuyển dụng nhân viên văn phòng và chính sách lương thưởng thì làm thế nào?","asker":"Khách thử","contact":"thu@example.com"}' \
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
curl -s -o /dev/null -w '   POST /q/%{url_effective} → %{http_code}\n' -X POST "$BASE/q/$REF/hoi-chuyen-gia" \
  --data-urlencode "asker=Khách thử" --data-urlencode "contact=thu@example.com"
curl -s "$BASE/api/question/$REF" | python3 -c "import json,sys;d=json.load(sys.stdin);print('   status:',d['status'],'| due:',d['due_at'],'| expert_id:',d['expert_id'])"

echo
echo "── 4. the expert works the queue"
curl -s -o /dev/null -w '   GET /c/<token> → %{http_code}\n' "$BASE/c/$EXPERT"
curl -s -o /dev/null -w '   POST answer → %{http_code}\n' -X POST "$BASE/c/$EXPERT/tra-loi" \
  --data-urlencode "ref=$REF" --data-urlencode "body=Hợp đồng thời vụ phải nêu rõ thời hạn và phụ lục; kiểm tra lại điều khoản chấm dứt trước khi ký."
curl -s "$BASE/api/question/$REF" | python3 -c "import json,sys;d=json.load(sys.stdin);print('   status:',d['status'],'| answers:',len(d['answers']))"

echo
echo "── 5. booking: VND, split, transfer instruction, operator confirms"
LOC=$(curl -s -o /dev/null -w '%{redirect_url}' -X POST "$BASE/dat-lich" \
  --data-urlencode "expert=hung-qa" --data-urlencode "minutes=60" --data-urlencode "starts_at=2026-10-20 20:00" \
  --data-urlencode "asker=Khách thử" --data-urlencode "contact=thu@example.com" --data-urlencode "topic=tpm" \
  --data-urlencode "agenda=Chuyền hay dừng ở trạm cuối, cần lộ trình kiểm tra.")
BREF="${LOC##*/}"
echo "   booking  : $LOC"
curl -s "$BASE$LOC" | grep -oE '(800\.000đ|640\.000đ|160\.000đ|img\.vietqr\.io[^"]{0,40}|requested)' | sort -u | sed 's/^/     /'
curl -s -o /dev/null -w '   customer says paid → %{http_code}\n' -X POST "$BASE/b/$BREF/da-chuyen"
if [ -n "$ADMIN" ]; then
  curl -s -o /dev/null -w '   operator confirms  → %{http_code}\n' -X POST "$BASE/qt/$ADMIN/xac-nhan" --data-urlencode "ref=$BREF"
  curl -s "$BASE/b/$BREF" | grep -oE 'awaiting_payment|>paid<|paid' | head -2 | sed 's/^/     /'
fi

echo
echo "── 6. the gate at the door"
curl -s -o /tmp/smoke-gate.html -w '   note with PO number + price → %{http_code}\n' -X POST "$BASE/c/$EXPERT/ghi-chu" \
  --data-urlencode "title=Kinh nghiệm lô hàng" --data-urlencode "topic=chat-luong" --data-urlencode "attested=1" \
  --data-urlencode "body=$(printf '# Kinh nghiệm\n\n## Bối cảnh\nLô theo PO 45123 lỗi, đơn giá nhập cao hơn kế hoạch.\n\n## Cách làm\nKiểm tra theo thứ tự trước khi sửa.')"
grep -oE 'document|person_name|figure|block_term' /tmp/smoke-gate.html | sort -u | sed 's/^/     rule: /'

echo
echo "── 7. counters"
curl -s "$BASE/healthz" | j 200
