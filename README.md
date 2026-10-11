# Xuong — a factory-production knowledge platform, Vietnam-first

A working prototype of a paid knowledge product for Vietnamese manufacturing: a person asks a
production problem in plain language, gets an **answer built only from published practitioner
notes and carrying its citations**, and when the notes do not cover it the system **says so** and
hands the question to a real practitioner — with a paid 1:1 booking in VND behind it.

The refusal is not a fallback. It is the product: it is what separates an answer a supervisor can
act on from a plausible paragraph a language model invented, and it is what turns an unanswered
question into revenue.

- **Status:** prototype, running on the LAN. Demo corpus, one demo expert profile, no real money moves.
- **Runtime:** Node ≥ 22.5, `node:http` + `node:sqlite`, zero dependencies, no build step.
- **UI:** English, server-rendered HTML, no build step and no framework.

## The four rungs

| Rung | What happens | Where it lives |
|---|---|---|
| 1. Ask | The question is matched against the published corpus (BM25 with Vietnamese diacritic folding) | `src/retrieval.mjs` |
| 2. Answer or refuse | A model answers **from the retrieved notes only** and cites them, or replies `INSUFFICIENT_DATA` (not enough data) | `src/llm.mjs` |
| 3. Escalate | A refused question can be routed to a practitioner on that topic, with a 48-hour deadline | `src/server.mjs`, `/q/:ref/ask-expert` |
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
http://192.168.1.150:8090/                # ask a question
http://192.168.1.150:8090/library         # the published corpus, by topic
http://192.168.1.150:8090/experts         # expert profiles and 1:1 booking
http://192.168.1.150:8090/how-it-works    # how the rungs and the gate work
http://192.168.1.150:8090/c/demo-hung-7f3a91   # demo expert workspace (answer queue, notes, interview)
http://192.168.1.150:8090/qt/<token>  # operator console (token in /etc/xuong/xuong.env on the host)
```

A question the corpus covers comes back with citations; one it does not (e.g. anything about
another industry's line layout) comes back as `INSUFFICIENT_DATA` plus an escalation offer. The refusal
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
| `XUONG_HOST_PORT` | `8090` | host-side port in `docker-compose.yml`; the container always listens on 8090 internally |
| `XUONG_ADMIN_TOKEN` | generated into `<data>/admin.token` | operator console token (`/qt/<token>`) |
| `XUONG_LLM_KEY` | — | API key for the answer model; absent ⇒ labelled extractive mode |
| `XUONG_LLM_BASE_URL` | OpenRouter | OpenAI-compatible chat-completions base URL |
| `XUONG_LLM_MODEL` | `deepseek/deepseek-v4-flash-0731` | model id (the code's default, so the README and the code agree) |
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
| `POST /ask` | the HTML ask form |
| `POST /q/:ref/ask-expert` | escalate a refused question to a practitioner |
| `POST /book`, `POST /q/:ref/book` | book a 1:1 session |
| `POST /b/:ref/transferred` | the buyer says they transferred the money |
| `POST /c/:token/answer` | expert answers a routed question |
| `POST /c/:token/note` | expert submits a note (goes through the gate) |
| `POST /c/:token/interview` | AI-moderated interview that drafts a note, then gates it |
| `POST /c/:token/confirm`, `/complete` | operator: money arrived; session done |

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

41 tests (`node --test`), including an end-to-end walk over real HTTP. They are worth more than the
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
- The state machine's own words (`open`, `answered`, `paid`) leaked to users — now every status is
  rendered through a label map, and a test asserts no raw token reaches a page.
- Moving the content to English moved three things at once (UI strings, the refusal marker, the URL
  routes), so the corpus notes were retranslated with the gate's rules restated as a constraint: they
  still pass it clean, in the new language. The gate's Vietnamese patterns stayed — a Vietnamese note
  carrying an employer's order number is still someone else's information.
- **The app ignored the database it was configured to use.** `createApp` defaulted to a relative
  `data/xuong.db`, and `seed.mjs` to the same string, so `XUONG_DB` worked and `XUONG_DATA_DIR` did
  not: the service read one file while the installer seeded another. On a host where the working
  directory happened to match, nothing looked wrong — in the container it produced an instance with
  an **empty corpus and no error anywhere**. Both now resolve through `loadConfig().dbPath`, with a
  test that fails if a configured path is ignored, and `scripts/probe-db.mjs` to show which file
  holds the questions when two exist.
- The installer kept an existing env file, so a key introduced later (the front-gate pair) never
  reached the service: the gate *looked* configured while the instance answered `200` unauthenticated.
- The installer's final smoke question posted without credentials, so a correctly configured front
  gate made a healthy install report a JSON parse error.

## Deployment

Two ways to run it on a host: the systemd installer below for a bare machine, or the container
(next section) when it has to move between machines. Both read the same `XUONG_*` variables, write
the same SQLite schema, and honour the same data path — the app opens the database it is configured
with, never a file that happens to sit next to the source.

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

### Docker, to move it to another machine

The whole product is one Node process — no separate frontend service, no build step, no database
service — so the image is the source tree plus a writable `/data`.

```bash
cp .env.example .env       # fill in XUONG_USER/XUONG_PASS, and XUONG_LLM_KEY for real answers
docker compose up -d       # builds the image and serves on :8090
docker compose logs -f xuong
```

Or from the published image, no checkout needed:

```bash
docker run -d --name xuong -p 8090:8090 --env-file .env \
  -v xuong-data:/data ghcr.io/phamtruonghung/xuong:latest
```

`deploy/docker-smoke.sh` does the whole thing and cleans up after itself: build, start, check the
gate from outside (401 without credentials, 200 with them), ask a real question *through the
container*, and print what landed in the volume. Use it after changing anything in `src/`.

State is only the volume (`xuong-data`: the SQLite file plus the generated admin token), so carrying
an instance to another machine is:

```bash
docker save ghcr.io/phamtruonghung/xuong:latest | gzip | ssh other-host 'gunzip | docker load'
docker run --rm -v xuong-data:/data -v "$PWD:/backup" alpine tar czf /backup/xuong-data.tgz -C /data .
```

The container always listens on 8090 internally and always writes `/data`; `XUONG_HOST_PORT` moves
only the host-side port. The entrypoint seeds the corpus when the volume is empty and says loudly
when `XUONG_PASS` is missing, so an ungated container announces itself in the log rather than
quietly becoming an open model bill.

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

For a URL today there is `deploy/quick-tunnel.sh`: it installs `cloudflared`, runs a quick tunnel to
`127.0.0.1:8090`, and prints the `https://<name>.trycloudflare.com` URL. It refuses to start when no
`XUONG_PASS` is configured, because that would publish an open ask form. The URL changes on every
restart and the tunnel dies with the host — a demonstration instrument, not an address anyone should
bookmark.

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
test/      unit.test.mjs  app.test.mjs  auth.test.mjs
deploy/    install.sh  xuong.service  quick-tunnel.sh  entrypoint.sh  docker-smoke.sh
Dockerfile  docker-compose.yml  .env.example     the same app as a container, for another machine
.github/workflows/ci.yml                          tests, then build-and-publish the image
SPEC.md    the mechanism being copied, the constraints, the decisions, the open questions
```

## License

MIT (`LICENSE`). The compliance notes in `SPEC.md` are engineering notes, not legal advice.
