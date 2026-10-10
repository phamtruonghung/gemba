# SPEC — Xưởng

What this product is, which market mechanisms it copies and why, what Vietnam requires of it, what
was decided, and what is still open. Written to be read before changing the code or spending money.

Companion to `README.md` (how to run it). Every figure carries its source on the line that uses it.

---

## 1. The bet

Vietnamese factories buy advice mostly by the day, from consultancies and from retired plant
managers, at prices set per engagement. The knowledge that would answer 80% of the questions —
the order of checks when a machine stops mid-shift, the countermeasure after a repeat defect —
already exists in the heads of people who are still working, and never gets written down.

Two things are true at once, and the product has to hold both:

1. That knowledge is **portable craft** (how to diagnose, what standard to hold) sitting inside
   **employer-owned facts** (this plant's output, this part number, this price).
2. An answer that is not traceable to a source is worthless to a supervisor who has to act on it —
   worse than no answer, because it costs him a shift to discover it was invented.

So: publish the craft, gate out the employer's facts, and make the machine's refusal the moment the
business starts.

## 2. Mechanism teardown — what is copied, from whom

Researched 2026-10-10. Quotes below were read on the named page; where I could not re-render the
page myself the row says so.

| Mechanism | Taken from | The evidence, in their words | How it appears here |
|---|---|---|---|
| Answer in the expert's own published material, not in general knowledge | Delphi (delphi.ai) | "Upload writing, videos, podcasts, or link to live feeds – Delphi indexes it all." (product page, read 2026-10-10) | The corpus *is* the answer space; the prompt forbids outside knowledge |
| Monetise access in tiers instead of only by the hour | Delphi | "Create flexible membership tiers or pay-as-you-go plans tailored to your clients' needs." | Roadmap: session now, subscription once a corpus exists |
| Price a session by the minute, hold the money before the call, settle on actual duration | Clarity.fm | "A *pre-charge* is a temporary hold on your card for the estimated cost of the call." / "You'll be charged based on the actual duration of the call at the expert's rate — not the estimated time." / "If the call ends sooner, you'll receive a refund or credit for the unused time." (help.startups.com, read 2026-10-10) | Session price = rate × minutes, minimum 30; payment is instructed by VietQR and confirmed by the operator (no card rails, and we never hold funds — §7) |
| Capture tacit knowledge by an AI-led interview instead of asking for documents | Tacivo | "AI-guided sessions capture what departing employees know." + use cases: exit interviews, handovers, SOPs, after-action reviews + pushes to Notion/Confluence/SharePoint/Drive and an MCP server (homepage, read 2026-10-10) | `/c/:token/phong-van`: a scripted interview drafts a note, which then has to pass the gate before it is published |
| Human experts positioned *against* chatbots, cheap 1:1 packages | Askany (Vietnam) | "Askany, startup tiên phong trong việc kết nối các chuyên gia tư vấn với doanh nghiệp nhỏ, startup tại Việt Nam. Startup này đã đầu tư đến 27 tỉ đồng để phát triển app và marketing." / "đặt lịch tư vấn theo gói 15 phút, theo giờ" (thanhnien.vn, read 2026-10-10) | The ladder's bottom rung: 15–30 minute packages, escalating from a machine answer |
| Expert vetting, tiered revenue share by sustained quality | JustAnswer (mechanism), AlphaSights/GLG (conflict + compliance checks) | JustAnswer's "paid $2-11 per question, depending on what tier you're in" is **third-party (search result), not read on their page**; AlphaSights/GLG's conflict checks and "interactive compliance training prior to your first interaction" were read by the research pass | Not built: vetting is manual for the prototype (see §10) |
| Answer-space boundary = "says I don't know" rather than a confident guess | SuperMe | Reported by the research pass, not re-read by me | Our version is stronger: a machine-readable marker (`THIEU_DU_LIEU`) that triggers escalation |

What is **not** copied: building a "digital twin" that speaks as the expert (Delphi, Qiri). In a
production context a fabricated diagnosis attributed to a named practitioner is a safety problem,
not a feature.

## 3. The refusal contract

`src/llm.mjs`. The model gets only retrieved published notes, and the system prompt states:

- answer **only** from the passages given; general knowledge is forbidden;
- every claim carries `[n]` pointing at the passage it came from;
- if the passages do not answer the question, reply with exactly `THIEU_DU_LIEU` and nothing else;
- the answer is short, in Vietnamese, and addressed to a supervisor who will act on it.

The reply is parsed for the marker; when it appears, the question is marked `coverage: thin` and the
UI offers escalation. Without an API key the same contract runs in a **labelled extractive mode**
(quote the closest note, say that is what happened) so the demo never fakes a model answer.

The refusal is verified live: an off-corpus question against the deployed instance returns
`THIEU_DU_LIEU`; an on-corpus question returns a cited answer.

## 4. Coverage — when the machine is allowed to answer

Measured on 2026-10-10 against the seeded corpus: share-of-question-words-in-hits scored
**0.44–0.55 off-corpus vs 1.00 on-corpus** — it cannot separate the two, because Vietnamese function
words dominate short questions.

What is used instead (`src/retrieval.mjs`): idf-weighted agreement between the question's
**distinctive** tokens and the retrieved hits, with a Vietnamese stop-word list and diacritic folding
(`đ → d`, tones stripped). Off-corpus questions fall under the threshold and go to escalation.

## 5. The publishability gate

`src/gate.mjs`. Rules that block (severity `block`), because they are the employer's, not the
expert's:

| Class | Examples matched |
|---|---|
| Named people | Vietnamese full names (per-token `\p{Lu}` + `\p{Ll}`, no `\b` — it does not work around accented letters) |
| Company documents | `PO 12345`, `LSX 88/2026`, `part no #`, `mã hàng`, `mã vật tư` |
| Commercial figures | prices (`đơn giá`, giá nhập/bán), output/rates, `%`, VND amounts, `OEE … 42`, ppm/pcs/kg/tấn, downtime durations, per-week/month frequencies |
| Employer scope paths | any path into the employer's own knowledge tree |

Severities `attest` (the author must assert it is portable) and `note` (advisory) also exist. Every
note carries `origin` and, where applicable, the author's attestation text. A blocked note is
**displayed with its reasons** to the person who submitted it (`views.blockedNotePage`), and a
blocked interview draft returns HTTP 422 with the same page — silently swallowing a rejection is the
failure mode that makes an expert stop contributing.

Known limit: this is a pattern gate, not a lawyer. It catches the shapes it knows; §10 lists the
vetting it does not replace.

## 6. Money

Whole VND integers only. `quote(rate, minutes)` → `{price, fee, payout}` with a 20% platform take and
a 30-minute minimum block (`src/pricing.mjs`).

Published VND anchors for a 1:1 session, read 2026-10-10:

| Anchor | Their words | Source |
|---|---|---|
| Freelance expert 1:1 | "Giá mỗi giờ đầu tiên: 650.000 VNĐ ($30)" / "Giá từ giờ thứ hai trở đi: 400.000 VNĐ ($20)" | vivu.edu.vn/book-tu-van |
| Vietnamese law firm, online | consultation channels offered: "Zalo Facebook Messenger Google Meet", blocks "30 / 60 / 90 / 120 / 150 / 180 phút" | luatsuantam.vn (the VND 350,000/30-min figure the research pass reported was **not** on the page I read — treat as unconfirmed) |

So a 45-minute session lands near VND 500–900k, i.e. ~USD 20–35: deliberately below the USD 250–1,600
platform day rate the research pass reported for independent consultants, because the buyer here is a
supervisor or a plant manager paying out of a small budget, not a consultancy.

## 7. Vietnam constraints

Engineering notes, **not legal advice**; every row names who says it. Rows marked *not re-verified*
came from the research pass and their page did not render for a second read by me — they are
directionally useful and must be confirmed with counsel before launch.

| Constraint | What it means here | Source | Status |
|---|---|---|---|
| Selling services online from Vietnam brings the platform under the e-commerce regime (Law on E-Commerce, alongside its implementing decree) | Registration duties, mandatory published policies, and liability for what the platform sells | Baker McKenzie; Duane Morris; Tilleke & Gibbins; CDLAF | not re-verified |
| Platforms may be **jointly liable** with sellers for consumer damages | The published notes are content the platform sells; the gate is also a liability control | Duane Morris | not re-verified |
| Platforms with an online ordering + payment function must **withhold and pay tax** on behalf of sellers/individuals, and domestic operators register a **separate TIN** for it | The expert payout is a payment to an individual: withholding is the platform's job, not the expert's | Vietnam Briefing (Decree 252/2026); RSM Vietnam tax spotlight | withholding duty **verified** in the RSM document; the "earlier of payment or confirmation" trigger is not |
| PIT withholding on payments to individuals without an employment contract: **10% once a payment reaches VND 5m** (raised from VND 2m) | A VND 5m+ payout needs a withholding path before it is paid | Baker McKenzie (Decree 253/2026, Circular 87/2026) | not re-verified |
| Individuals/households with annual revenue ≤ **VND 500m** are outside PIT | A part-time expert may fall under this — but that is his filing, not an excuse to skip withholding | PIT Law 109/2025 (Expertis translation) | not re-verified |
| VAT is **8%** (reduced from 10%) until 31 Dec 2026 | Pricing must not bake in 10% and quietly lose 2 points | ASL Law | not re-verified |
| E-invoicing obligations reach foreign e-commerce suppliers and some business households | An invoice path is required once real money moves | Vietnam Briefing (Decree 70/2025) | not re-verified |
| Payment-intermediary services (e-wallet, collection/payment support, gateway) require an SBV licence with **charter capital from VND 50bn** | Money must route **through a licensed provider or straight to the expert's account**; the platform must not hold customer funds | LuatVietnam (Decree 52/2024/ND-CP), Article 22 | not re-verified |
| User-generated content / community features can trigger a social-network licence under Decree 147/2024 (thresholds reported as 10,000 visits or 1,000 active users per month) | The Q&A + notes surface may need a licence or at least a notification as it grows | Apolat Legal; KPMG Vietnam | not re-verified |
| Personal data protection moved from Decree 13/2023 to **PDP Law 91/2025/QH15, effective 1 Jan 2026** | Askers and experts are data subjects; consent, storage and cross-border rules apply | Herbert Smith Freehills Kramer | not re-verified |
| The market around it: management consulting in Vietnam ≈ **USD 2.63bn (2025) → 3.84bn (2031)**; manufacturing took **USD 22.88bn of 27.62bn** realised FDI in 2025 (82.8%) | There is a large, target-rich factory base and proven willingness to buy advice | Mordor Intelligence; Datagent citing MoF/VIR | not re-verified |

**Consequence for the architecture:** the platform confirms the transfer, it does not hold the money.
That is why `/b/:ref` produces a VietQR instruction rather than a checkout, and why the operator
marks payment — a design decision driven by the VND 50bn licensing threshold, not by laziness.

## 8. Data model

`node:sqlite` (`src/db.mjs`), one file:

- `experts` — slug, name, headline, topics (JSON), rate_vnd, token; `notes` — title, slug, topic,
  body, `origin`, `status` (`draft`/`blocked`/`published`), gate decision, expert, sources;
- `questions` — ref, text, plant type, asker, contact, topic, state (`open`/`routed`/`answered`),
  AI answer, citations (JSON), coverage, due date;
- `answers` — expert answers to routed questions;
- `bookings` — expert, asker, contact, topic, agenda, `starts_at`, minutes, price/fee/payout,
  state (`requested` → `awaiting_payment` → `paid` → `completed`);
- `events` — an append-only log of what the system did, so a dispute has a record.

## 9. Decisions

1. **Refusal is a feature, and it is machine-readable.** A refused question is the product's best
   qualified lead; the marker is part of the answer contract, not a UI concern.
2. **The gate is enforced at every entrance** — seed import, expert submission, interview draft. A
   corpus with one leak is not a prototype, it is a liability.
3. **Zero dependencies** (`node:http`, `node:sqlite`, no build step): it has to run on a small LXC
   and be readable end to end. Instrumenting a framework buys nothing here.
4. **Money is integers, and the platform never holds funds** (see §7).
5. **Vietnamese-first UI**, including the state machine's own vocabulary; an English word leaking
   into a status field is a bug (there is a test for it).
6. **Corpus provenance is visible**: every note shows `origin`, so the demo material is never
   mistaken for a practitioner's real published craft.
7. **No simulated expert.** Answers attributed to a person are written by that person.

## 10. Open questions — decide before selling anything

1. **Legal/tax shape**: MoIT registration or notification; who withholds PIT on expert payouts and
   under which threshold; VAT treatment of a consulting service; invoice path. Needs Vietnamese
   counsel — the rows in §7 marked *not re-verified* are the shopping list.
2. **Who the first expert is**, and whether his employer's policy allows paid outside advice
   (moonlighting clauses are the real blocker, not the technology).
3. **Who owns a note once the machine answers from it** — the expert, the platform, or neither.
4. **Marketplace or consultancy**: one vetted practitioner (simpler, defensible) versus an open
   expert marketplace (needs vetting, disputes, tiers).
5. **Refusal economics**: how many refused questions convert to a paid session before the model's
   own answering quality starts eating the revenue it creates.
6. **Interview capture at scale**: whether a practitioner will keep answering an AI interviewer in
   week six.

## 11. Roadmap (order matters)

1. Three real consultations with one practitioner, booked through the deployed instance — the only
   test of the ladder that counts.
2. Withholding + invoice module for payouts (small, and it is the thing that stops you paying anyone).
3. Delivery of the answer where the supervisor already is (Zalo/email) instead of a page he must
   come back to.
4. A second topic area, to see whether the corpus or the expert is the constraint.
5. Only then: subscriptions, more experts, and a public domain.
