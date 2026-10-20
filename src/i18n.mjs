// src/i18n.mjs — the strings that decide whether a Vietnamese supervisor trusts the page.
//
// Not a framework, and deliberately small: the nine places where a person decides whether to believe the
// product (the refusal, the way to a practitioner, what it costs, how to pay, what happens next, the ask
// box, the answer's header, signing in, an error). Every other page is still English; translating all of
// them, with a language switch on notes, is a later slice and is not started here.
//
// A page about a question or a booking speaks the language the question was asked in. A page with no
// question (the home ask box, sign-in, an error) shows Vietnamese first and the English beneath it, which
// needs no cookie and no toggle. Placeholders are {name}; the views escape the result.
//
// Draft Vietnamese: written for review by a native-speaking practitioner before it is relied on.

export const STRINGS = Object.freeze({
  // 1. the refusal
  refusal_heading: { vi: 'Thư viện chưa trả lời được câu này', en: 'The library cannot cover this one yet' },
  // 2. the way to a practitioner
  ask_practitioner: { vi: 'Hỏi một chuyên gia', en: 'Ask a practitioner' },
  contact_name: { vi: 'Tên của bạn', en: 'Your name' },
  contact_label: { vi: 'Email hoặc số điện thoại, để câu trả lời đến được với bạn', en: 'Email or phone, so the answer can reach you' },
  route_hint: {
    vi: 'Câu hỏi sẽ được gửi tới chuyên gia phụ trách “{topic}”, miễn phí, trong vòng 48 giờ. Bạn cũng có thể đặt một buổi tư vấn 1:1 có phí ngay trên trang này.',
    en: 'There is one more rung: the question goes to the practitioner covering “{topic}”, free, with a 48-hour answer window. A paid 1:1 session is available on the same page.'
  },
  // 3. what it costs
  cost_heading: { vi: 'Chi phí', en: 'What it costs' },
  cost_session: { vi: 'Buổi tư vấn', en: 'Session' },
  cost_session_value: { vi: '{minutes} phút, {rate} một giờ', en: '{minutes} minutes at {rate} an hour' },
  cost_when: { vi: 'Thời gian', en: 'When' },
  cost_when_value: { vi: '{when} (giờ Việt Nam, UTC+7)', en: '{when} (Vietnam time, UTC+7)' },
  cost_total: { vi: 'Tổng cộng', en: 'Total' },
  cost_fee: { vi: 'Phí nền tảng (20%)', en: 'Platform fee (20%)' },
  cost_payout: { vi: 'Chuyên gia nhận', en: 'Paid to the practitioner' },
  cost_hint: {
    vi: 'Chỉ tính bằng đồng, không có số lẻ. Nền tảng hướng dẫn thanh toán nhưng không giữ tiền của bạn.',
    en: 'Whole VND only, and the platform instructs the payment — it never holds the money.'
  },
  // 4. how to pay
  pay_heading: { vi: 'Cách thanh toán', en: 'How to pay' },
  pay_text: {
    vi: 'Giờ hẹn đã được xác nhận. Số tiền {amount}. Ghi đúng mã này vào nội dung chuyển khoản: {ref}',
    en: 'The time is confirmed. Amount {amount} — put exactly this reference in the transfer note: {ref}'
  },
  pay_done: { vi: 'Tôi đã chuyển tiền', en: 'I have transferred the money' },
  // 5. what happens next
  step_requested: { vi: 'Chờ chuyên gia xác nhận giờ hẹn', en: 'Waiting for the practitioner to confirm the time' },
  step_awaiting_payment: { vi: 'Đã xác nhận giờ hẹn — chuyển khoản theo hướng dẫn bên dưới', en: 'Time confirmed — transfer the amount below' },
  step_paid: { vi: 'Đã nhận thanh toán — đường dẫn buổi họp ở bên dưới', en: 'Payment received — meeting link below' },
  step_completed: { vi: 'Buổi tư vấn đã xong', en: 'Session completed' },
  step_here: { vi: 'bạn đang ở bước này', en: 'you are here' },
  process_heading: { vi: 'Các bước', en: 'Process' },
  routed_notice: {
    vi: 'Đã gửi tới {n} chuyên gia phụ trách chủ đề này ({names}). Câu trả lời sẽ hiện ngay trên trang này.',
    en: 'Sent to {n} practitioner{s} covering this topic ({names}). The answer will appear on this page.'
  },
  // 6. the ask box
  ask_heading: { vi: 'Câu hỏi của bạn về sản xuất', en: 'Your question about production' },
  ask_label: { vi: 'Câu hỏi của bạn', en: 'Your question' },
  ask_hint: {
    vi: 'Một câu hỏi, như bạn hỏi đồng nghiệp. Càng cụ thể, câu trả lời càng tốt.',
    en: 'One question, as you would ask a colleague. The more specific it is, the better the answer.'
  },
  ask_submit: { vi: 'Hỏi thư viện', en: 'Ask the library' },
  // 7. the answer's header
  answer_heading: { vi: 'Câu trả lời từ thư viện ghi chú', en: 'Answer from the note library' },
  extractive_header: { vi: 'Trích nguyên văn từ ghi chú (tiếng Anh)', en: 'Quoted from the notes' },
  // 8. signing in
  signin_heading: { vi: 'Đăng nhập', en: 'Sign in' },
  signin_button: { vi: 'Đăng nhập', en: 'Sign in' },
  // 9. an error
  error_lead: { vi: 'Không có gì được đoán mò ở đây — trang này đơn giản là không tồn tại.', en: 'Nothing is guessed here either — this page is simply missing.' },
  error_404: { vi: 'Không tìm thấy trang này', en: 'Not found' },
  error_403: { vi: 'Bạn không có quyền mở trang này', en: 'Not allowed' },
  error_429: { vi: 'Bạn thao tác quá nhanh — vui lòng chờ một chút', en: 'Too many tries' },
  error_500: { vi: 'Hệ thống gặp lỗi — câu hỏi của bạn không bị mất', en: 'Something went wrong' },
  error_back: { vi: 'Quay lại và thử lại', en: 'Go back and try again' }
});

/** The string for `key` in `lang` ('vi' | 'en'; anything else is English), with {placeholders} filled. */
export function t(key, lang = 'en', vars = {}) {
  const entry = STRINGS[key];
  if (!entry) throw new Error(`i18n: no string called ${key}`);
  const text = lang === 'vi' ? entry.vi : entry.en;
  return text.replace(/\{(\w+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}
