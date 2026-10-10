# Xưởng — a factory-production knowledge platform, Vietnam-first

A working prototype of a paid knowledge product for Vietnamese manufacturing: a person asks a
production problem in plain Vietnamese, gets an **answer built only from published practitioner
notes and carrying its citations**, and when the notes do not cover it the system **says so** and
hands the question to a real practitioner — with a paid 1:1 booking in VND behind it.

The refusal is not a fallback. It is the product: it is what separates an answer a supervisor can
act on from a plausible paragraph a language model invented, and it is what turns an unanswered
question into revenue.

- **Status:** prototype, running on the LAN. Demo corpus, one demo expert profile, no real money moves.
- **Runtime:** Node ≥ 22.5, `node:http` + `node:sqlite`, zero dependencies, no build step.
- **UI:** Vietnamese, server-rendered HTML.

## The four rungs

| Rung | What happens | Where it lives |
|---|---|---|
| 1. Ask | The question is matched against the published corpus (BM25 with Vietnamese diacritic folding) | `src/retrieval.mjs` |
| 2. Answer or refuse | A model answers **from the retrieved notes only** and cites them, or replies `THIEU_DU_LIEU` (not enough data) | `src/llm.mjs` |
| 3. Escalate | A refused question can be routed to a practitioner on that topic, with a 48-hour deadline | `src/server.mjs`, `/q/:ref/hoi-chuyen-gia` |
| 4. Pay | A 1:1 session is booked, priced in whole VND, paid by bank transfer with a VietQR instruction, and settled by the operator | `src/pricing.mjs`, `/dat-lich` |

## The rule that makes it publishable

An expert's daily notes are the **employer's** information. The single most common way this product
dies is by capturing them and republishing them.

So nothing enters the corpus without passing a publishability gate (`src/gate.mjs`) that blocks:
named people, document references (PO/LSX/part numbers) and plant figures (output, rates, prices,
OEE numbers, downtime durations). A note that fails is **shown to its author with the reason** — never
dropped silently. What survives is the portable craft: the order of checks, the countermeasure, the
standard, the diagnostic question.

Every note records its `origin` (`demo`, `vault`, `interview`, or an expert submission), so a reader
can always tell whose words are being quoted.

## Try it

The demo instance runs on the LAN:

```
http://192.168.1.150:8090/            # ask a question (Vietnamese UI)
http://192.168.1.150:8090/kho         # the published corpus, by topic
http://192.168.1.150:8090/cach-lam    # how the ladder and the gate work
http://192.168.1.150:8090/c/demo-hung-7f3a91   # demo expert workspace (answer queue, notes, interview)
http://192.168.1.150:8090/qt/<token>  # operator console (token in /etc/xuong/xuong.env on the host)
```

A question the corpus covers comes back with citations; one it does not (e.g. anything about
another industry's line layout) comes back as `THIEU_DU_LIEU` plus an escalation offer. The refusal
is produced by the model itself under the prompt contract, not by a regex on its output.

## Run it yourself

```bash
node --version            # needs >= 22.5 for node:sqlite
npm run seed              # creates data/xuong.db: expert profiles + the corpus, every note through the gate
npm start                 # http://127.0.0.1:8090
npm test                  # node --test test/*.test.mjs
BASE=http://127.0.0.1:8090 scripts/smoke.sh    # walks the live instance end to end
```

Without an API key the AI rung runs in a labelled extractive mode (it quotes the retrieved note and
says that is what it is doing). With a key it answers normally. Either way the citation contract and
the refusal marker are enforced by tests.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `XUONG_PORT` | `8090` | HTTP port |
| `XUONG_HOST` | `0.0.0.0` | bind address |
| `XUONG_USER` / `XUONG_PASS` | — | HTTP basic auth in front of everything except `/healthz`; **set this before publishing the instance to any hostname** |
| `XUONG_DATA_DIR` | `./data` | where the SQLite file and the admin token live |
| `XUONG_DB` | `<data>/xuong.db` | database path |
| `XUONG_ADMIN_TOKEN` | generated into `<data>/admin.token` | operator console token (`/qt/<token>`) |
| `XUONG_LLM_KEY` | — | API key for the answer model; absent ⇒ labelled extractive mode |
| `XUONG_LLM_BASE_URL` | OpenRouter | OpenAI-compatible chat-completions base URL |
| `XUONG_LLM_MODEL` | `deepseek/deepseek-v4.1-flash` | model id |
| `XUONG_LLM_TIMEOUT_MS` | `90000` | per-request timeout |
| `XUONG_BANK_BIN` / `XUONG_BANK_ACCOUNT` | — | VietQR recipient; unset ⇒ the booking page shows the amount with no QR |

Secrets belong in the environment or in the systemd `EnvironmentFile`, never in the repo.

## HTTP surface

| Route | What it does |
|---|---|
| `GET /healthz` | liveness + corpus size + whether the model is configured |
| `POST /api/ask` | JSON ask: question, plant type, asker → answer, citations, coverage, ref |
| `GET /api/question/:ref` | one question with its answer, citations and expert answers |
| `GET /api/experts` | expert profiles |
| `POST /hoi` | the HTML ask form |
| `POST /q/:ref/hoi-chuyen-gia` | escalate a refused question to a practitioner |
| `POST /dat-lich`, `POST /q/:ref/dat-lich` | book a 1:1 session |
| `POST /b/:ref/da-chuyen` | the buyer says they transferred the money |
| `POST /c/:token/tra-loi` | expert answers a routed question |
| `POST /c/:token/ghi-chu` | expert submits a note (goes through the gate) |
| `POST /c/:token/phong-van` | AI-moderated interview that drafts a note, then gates it |
| `POST /c/:token/xac-nhan`, `/hoan-tat` | operator: money arrived; session done |

## Money

Prices are **whole VND integers** — no floats anywhere in the money path. A session is
`rate × minutes`, capped to a minimum block of 30 minutes, split into a 20% platform fee and the
expert's payout (`src/pricing.mjs`).

Payment is **instructed, not held**: the booking page shows the amount and a VietQR code with the
booking reference in the transfer note, the buyer confirms, the operator matches the bank line and
marks it paid. The platform never touches customer funds — holding them is an activity that needs a
payment-intermediary licence (charter capital from VND 50bn under Decree 52/2024), and staying out
of it is a deliberate decision. See `SPEC.md` § *Vietnam constraints*.

## Tests, and what they caught

33 tests (`node --test`), including an end-to-end walk over real HTTP. They are worth more than the
coverage number because of what they found:

- Vietnamese surnames in capitals were not caught by the gate (a character-range regex matched
  lowercase accented letters too) — fixed with `\p{Lu}`/`\p{Ll}` and per-token checks.
- A note containing `…thứ tự đó.\n## Dùng…` was read as a person named "Đỗ Dùng" — fixed by
  rewriting the person-name rule.
- `\b` never matches around Vietnamese letters, so document/figure rules such as `đơn giá` could
  never fire — removed in favour of `foldToken`.
- BM25 over a short Vietnamese question scored almost anything as "covered", so the system answered
  questions it had no data for. Replaced with idf-weighted agreement over distinctive tokens
  (measured: off-corpus 0.44–0.55, on-corpus 1.00).
- A blocked interview draft failed **silently** in the UI — now the reason is a page.
- `expert.topics[0]` returned the raw JSON string `"["` because the column was never parsed.
- The whole UI was Vietnamese except the state machine's own words (`open`, `answered`, `paid`),
  which leaked to users — now every status is rendered through a Vietnamese label map.

## Deployment

`deploy/install.sh` is idempotent: it installs Node from the official tarball, copies the tree,
writes `/etc/xuong/xuong.env` (mode 600), installs `deploy/xuong.service`, seeds the database if it
is missing, and starts the service.

```bash
bash deploy/install.sh                 # on the host
XUONG_LLM_KEY_FILE=/root/or.key bash deploy/install.sh   # taking the key from a file instead of the env
```

It runs as a systemd service (`xuong.service`) on the demo host `192.168.1.150:8090`. Ports 80/443
there belong to another stack, so the app is published on 8090 — a reverse proxy is the deployment's
job, not the app's.

### Publishing it to a hostname

The ask form spends money: every question calls a model. An instance reachable from the internet
without a gate is therefore an open bill and an open spam target, so the app carries its own front
gate rather than relying on the deployment to remember one:

- set `XUONG_USER` and `XUONG_PASS` and every path — the pages, `/api/ask`, the expert desks, the
  console — answers `401` with a basic-auth challenge until the browser authenticates;
- `/healthz` stays open (it is the readiness probe) and deliberately does not print the database path;
- with neither variable set the app is open, which is what local development wants.

Tunnelling is the deployment's business, not the app's. On this host the tunnel is managed in the
Cloudflare dashboard (a token-managed `cloudflared` runs on the Proxmox host), so a public hostname
is one ingress entry there: `xuong.<your-domain>` → `http://192.168.1.150:8090`. Verification that
counts is a request from outside the LAN: `401` without credentials, `200` with them.

## What is deliberately not built

No payment gateway or escrow (see above), no email/Zalo notification (the expert has a tokenised
queue instead), no expert KYC/vetting, no invoice or withholding module, no contracts or ToS, no
asker accounts, no English UI, no mobile app, no analytics. `SPEC.md` § *Open questions* names the
ones that must be decided before selling anything.

## Repo layout

```
src/       db.mjs  gate.mjs  retrieval.mjs  pricing.mjs  llm.mjs  interview.mjs  views.mjs  server.mjs
scripts/   seed.mjs  import-notes.mjs  smoke.sh  probe-*.mjs
seed/      experts.json  topic-map.json  corpus/  vault-raw/
test/      unit.test.mjs  app.test.mjs
deploy/    install.sh  xuong.service
SPEC.md    the mechanism being copied, the constraints, the decisions, the open questions
```

## License

MIT (`LICENSE`). The compliance notes in `SPEC.md` are engineering notes, not legal advice.
