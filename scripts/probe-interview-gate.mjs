// scratch probe: why did the interview draft fail the gate?
import { checkNote, loadRules } from '../src/gate.mjs';
import { draftNoteFromInterview } from '../src/interview.mjs';

const answers = [
  'Tôi làm nghề này hai mươi năm, phụ trách khu vực lắp ráp và bảo trì cơ bản.',
  'Vấn đề lặp lại nhiều nhất là vật tư sai quy cách ở trạm cuối làm dừng chuyền.',
  'Dấu hiệu đầu tiên là đèn báo trạm cuối nhấp nháy và người kiểm hàng cuối cùng phát hiện ra.',
  'Nguyên nhân gốc thường là nhập sai lô vật tư; kiểm chứng bằng cách đối chiếu bao bì với phiếu giao.',
  'Cách xử lý: dừng trạm, cách ly vật tư nghi ngờ, báo tổ trưởng, ghi lại hiện tượng rồi mới chạy lại.',
  'Người mới hay đổi cảm biến trước khi kiểm vật tư, nên mất thời gian mà lỗi vẫn còn.',
  'Tiêu chuẩn là kiểm vật tư trước cảm biến, ai cũng làm theo đúng thứ tự đó.',
  'Cách này dùng được cho chuyền lắp ráp nhiều trạm, không dùng khi vật tư do khách cấp và không được mở bao bì.'
];

const draft = draftNoteFromInterview({ expert: { slug: 'x' }, topic: 'tpm', answers, title: 'Kinh nghiệm: tpm' });
const report = checkNote({ title: draft.title, body: draft.body }, loadRules());
console.log('verdict:', report.verdict, 'ok:', report.ok);
for (const f of report.findings) console.log(' ', f.severity, f.rule, JSON.stringify(f.match), '|', f.hint);
