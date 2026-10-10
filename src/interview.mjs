// src/interview.mjs — the capture mechanism.
//
// Copied deliberately from the market: the hardest part of a practitioner platform is not the
// answer, it is getting a busy practitioner to write anything at all (Tacivo's answer is an
// AI-moderated interview; Delphi's is "hand us your existing talks"). Xưởng does the interview,
// but the script itself enforces the boundary the gate will check afterwards: the questions ask
// for craft, never for the plant's numbers.

export const SCRIPT = [
  {
    id: 'scope',
    ask: 'Anh/chị làm nghề này bao lâu, phụ trách khu vực nào (ví dụ: lắp ráp, ép nhựa, bảo trì, kho)?',
    hint: 'Chỉ cần phạm vi công việc, không cần tên nhà máy hay tên khách hàng.'
  },
  {
    id: 'problem',
    ask: 'Vấn đề nào trên chuyền anh/chị phải xử lý nhiều lần nhất trong một tháng?',
    hint: 'Mô tả hiện tượng, đừng nêu số liệu của nhà máy — chỉ nói nó hay xảy ra thế nào.'
  },
  {
    id: 'symptom',
    ask: 'Dấu hiệu đầu tiên để nhận ra vấn đề đó là gì, và ai thường phát hiện ra trước?',
    hint: 'Nghe, thấy, ngửi, đo — cái gì đổi trước tiên?'
  },
  {
    id: 'cause',
    ask: 'Nguyên nhân gốc thường gặp nhất mà anh/chị đã kiểm chứng bằng cách nào?',
    hint: 'Kể cách kiểm chứng, không cần kể kết quả bằng số.'
  },
  {
    id: 'countermeasure',
    ask: 'Cách xử lý anh/chị dùng lại nhiều lần, làm theo thứ tự nào?',
    hint: 'Từng bước, đủ để người khác làm theo.'
  },
  {
    id: 'mistake',
    ask: 'Cách làm mà anh/chị thấy nhiều người mới làm sai ở chỗ đó là gì?',
    hint: 'Đây thường là phần giá trị nhất của ghi chú.'
  },
  {
    id: 'standard',
    ask: 'Nếu phải viết một dòng tiêu chuẩn để không tái diễn, anh/chị viết gì?',
    hint: 'Một dòng, ai đọc cũng làm được.'
  },
  {
    id: 'transfer',
    ask: 'Cách này còn dùng được ở nhà máy khác, ngành khác không? Giới hạn của nó là gì?',
    hint: 'Nói rõ khi nào thì KHÔNG nên áp dụng.'
  }
];

const HEAD = {
  scope: 'Phạm vi và kinh nghiệm',
  problem: 'Vấn đề hay gặp',
  symptom: 'Dấu hiệu nhận biết',
  cause: 'Nguyên nhân gốc và cách kiểm chứng',
  countermeasure: 'Cách xử lý theo thứ tự',
  mistake: 'Lỗi người mới hay mắc',
  standard: 'Tiêu chuẩn một dòng',
  transfer: 'Dùng được ở đâu, giới hạn ở đâu'
};

export function questionAt(step) {
  return SCRIPT[step] ?? null;
}

export function progress(step) {
  return { step, total: SCRIPT.length, done: step >= SCRIPT.length };
}

export function draftNoteFromInterview({ expert, topic, answers, title }) {
  const sections = SCRIPT.map((q, i) => {
    const a = String(answers[i] ?? '').trim();
    if (!a) return '';
    return `## ${HEAD[q.id]}\n${a}`;
  }).filter(Boolean);
  const body = `# ${title}\n\n${sections.join('\n\n')}\n`;
  return { title, topic, body, expert_slug: expert?.slug ?? '', origin: 'interview' };
}

export function slugify(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'ghi-chu';
}
