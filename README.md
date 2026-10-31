```
src/       every module of the app, one concern each (server.mjs routes, views.mjs pages, db.mjs schema, gate.mjs, llm.mjs, ...)
scripts/   seed.mjs  import-notes.mjs  eval-retrieval.mjs  admin-create.mjs  sweep.mjs  smoke.sh  ui-check.py  probe-*.mjs
           read-reference.py  measure-contrast.py  probe-block.py   # design evidence, not opinions
# Gemba — a factory-production knowledge platform, Vietnam-first

A working prototype of a paid knowledge product for Vietnamese manufacturing: a person asks a
production problem in plain language, gets an **answer built only from published practitioner
notes and carrying its citations**, and when the notes do not cover it the system **says so** and
hands the question to a real practitioner — with a paid 1:1 booking in VND behind it.

The refusal is not a fallback. It is the product: it is what separates an answer a supervisor can
act on from a plausible paragraph a language model invented, and it is what turns an unanswered
question into revenue.

- **Status:** prototype, running on the LAN. Demo corpus, 3 demo expert profiles, no real money moves.
- **Runtime:** Node ≥ 22.13, `node:http` + `node:sqlite`, zero dependencies, no build step.
- **UI:** English, server-rendered HTML, no build step and no framework. The nine strings that decide whether a
  Vietnamese supervisor trusts a page (refusal, way to a practitioner, cost, payment, next step, ask box, answer
  header, sign-in, error) are also in Vietnamese, for a question asked in Vietnamese (`src/i18n.mjs`).

## The four rungs

| Rung | What happens | Where it lives |
|---|---|---|
| 1. Ask | The question is matched against the published corpus (BM25 with Vietnamese diacritic folding) | `src/retrieval.mjs` |
| 2. Answer or refuse | A model answers **from the retrieved notes only** and cites them, or replies `INSUFFICIENT_DATA` (not enough data) | `src/llm.mjs` |
| 3. Escalate | A refused question can be routed to a practitioner on that topic, with a 48-hour deadline | `src/server.mjs`, `/q/:ref/ask-expert` |
| 4. Pay | A 1:1 session is booked, priced in whole VND, paid by bank transfer with a VietQR instruction, and settled by the operator | `src/pricing.mjs`, `/book` |

## Two doors for the operator, and why

`/qt/<token>` is the operator link (the token is in `<data>/admin.token`, mode 600; the installer says where, and `/admin` can rotate it): what the instance is doing, and the two booking
transitions (*payment received*, *session done*). It needs no sign-in, so it is the quick
reconciliation link — and nothing more.

`/admin` is an account, and it is where the power is: the prices and limits the booking form quotes
from, the practitioner roster, invitations, the audit trail, and (next) asker accounts. A token in a URL cannot be
revoked or rotated, and "change every price" is not the same power as "mark this paid" — so creating
people and moving money sits behind a session, and every write records the operator's email.

```bash
node scripts/admin-create.mjs --email me@example.com     # create or reset; prints the password once
```

| Setting | Default | What it changes |
| --- | --- | --- |
| Platform share | 20% | What the platform keeps; the practitioner receives the rest |
| Shortest session | 30 minutes | A shorter session is not offered |
| Default session | 45 minutes | What the booking form proposes |
| Default rate | 600,000 VND/h | Used for a new practitioner with no rate yet |

### Accounts and sessions

`/admin/accounts` lists every account with its role, whether it is on, how many sessions it is holding,
when it last signed in, and the practitioner row it belongs to.

- **Lock** stops the account signing in *and* ends every session it is already holding. A lock that
  leaves someone working for as long as their cookie lives is a claim about the future, not about now.
- **Unlock** restores it; **Sign out everywhere** ends the sessions without locking.
- **Role** moves an account between asker, operator and practitioner. It refuses two things on purpose:
  the account you are signed in as (a mistake nobody can undo from inside the console) and the last
  operator who can sign in (which would lock everybody out). An account cannot be made a practitioner
  without a roster row, so role changes cannot hand out a desk that does not exist.
- **An operator is invited, never handed a password.** The invitation carries the role; the form on the
  page cannot promote the account it creates.

### Bookings, and what happens to the money

`/admin/bookings` is the reconciliation desk: filter by status, mark **Payment received** and **Session
done**, **Move** a session (the price is re-quoted from the practitioner's current rate and the current
settings — a reschedule keeps the payment), and **Cancel** with a reason.

Cancelling after the client paid is not a status change, it is money owed back. The buyer paid the
instance's one bank account (see *Money*), so a cancelled paid booking records the amount and appears under
**Refunds owed** as an instruction for the operator to send back. The page
also totals what each practitioner has earned: paid out, the platform fee, and what is still in flight.

### Practitioners, and how one arrives

A practitioner is who a refused question is routed to and where a paid session happens. There is **no
open registration** — an account is created by invitation, because the value of the corpus is that it
comes from people who ran the line, and an invitation is the operator saying "this one did".

1. **Add** them at `/admin/experts` — name, headline, topics, years, rate. Topics decide routing: a
   practitioner with no topic can never be sent a question, so the form refuses to save one.
2. **Invite** them from their page. You get a single-use link, valid for seven days, shown once —
   send it to them however you like. They set their own password and land on their desk.
3. **Their desk** is `/desk` once signed in. The older `/c/<token>` link keeps working: a link is a
   permanent password, so it is the fallback for someone who loses theirs, not the front door. If it
   leaks, *Generate a new desk link* kills the old one.

Pausing a practitioner (`Accept new questions` off) takes them out of routing immediately, including as the
fallback when nobody else covers the topic; if nobody is accepting, the question waits and its page says so. Editing a
rate changes what new bookings quote, without a deploy. Every one of those changes is audited.

Values are whole numbers in VND — the product never holds a fraction of a đồng — and a form with one
bad field changes nothing, so *save* means saved.

## The rule that makes it publishable

An expert's daily notes are the **employer's** information. The single most common way this product
dies is by capturing them and republishing them.

So nothing enters the corpus without passing a publishability gate (`src/gate.mjs`) that blocks:
named people (full Vietnamese surname set, lowercase after a kinship word, ALL CAPS), contact details
(mobile/Zalo/landline/email), customer and supplier names, plant identifiers (line, shift, lot, station,
serial) and document references that carry a value (PO/LSX/part/drawing numbers, prices), and that asks for
the author's attestation on plant figures (output, rates, OEE numbers, downtime durations). A note that
fails is **shown to its author with the reason** — never dropped silently.

**Nobody attests for the author.** An interview ends in a *draft*: the author sees the rendered note, the
gate's findings and the attestation text, can edit it and re-run the gate, and the note is published only
when the form posts the attestation checkbox *and* the gate passes. The same gate stops an expert's answer
to a routed question. The seed has no author, so it attests nothing: a shipped note that would need an attestation stays
unpublished. All 12 shipped notes publish without one, and `test/gate.test.mjs` fails if one stops. What survives is the portable craft: the order of checks, the countermeasure, the
standard, the diagnostic question.

The employer's own names (the strings the gate must never let through) are a deployment file, not source,
because the source is public: `<data>/gate.rules.json` (or `GEMBA_GATE_RULES`) adds `block_terms` and any other
rule list to the built-in rules, which name no employer. `deploy/gate.rules.example.json` shows the shape. An
absent file means the built-in rules only; a present file with a bad key or value stops the server from
starting, so a typo cannot silently drop the block list.

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
http://192.168.1.150:8090/qt/<token>  # operator console (token in /etc/gemba/gemba.env on the host)
http://192.168.1.150:8090/admin      # operator sign-in (account created by the installer; `node scripts/admin-create.mjs`)
```

A question the corpus covers comes back with citations; one it does not (e.g. anything about
another industry's line layout) comes back as `INSUFFICIENT_DATA` plus an escalation offer. The refusal
is produced by the model itself under the prompt contract, not by a regex on its output.

## Run it yourself

```bash
node --version            # needs >= 22.13 for node:sqlite
npm run seed              # creates data/gemba.db: expert profiles + the corpus, every note through the gate
npm start                 # http://127.0.0.1:8090
npm test                  # node --test test/*.test.mjs
BASE=http://127.0.0.1:8090 scripts/smoke.sh    # walks the live instance end to end
```

Without an API key the AI rung runs in a labelled extractive mode (it quotes the retrieved note and
says that is what it is doing). With a key the model answers from the retrieved notes, and the answer is
checked before it is shown: every citation must be a passage actually sent, every figure must be in a cited
passage, every sentence must be mostly made of words its passage uses; otherwise it is withheld as a refusal.
Citations are renumbered `[1]..[k]` to match the source list. A 429 or 5xx is retried once (`Retry-After`,
capped at 5 s); after that the page shows the quoted notes labelled "model unavailable". Streaming is not
implemented. The contract is in `SPEC.md` section 3 and enforced by `test/llm.test.mjs`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GEMBA_PORT` | `8090` | HTTP port |
| `GEMBA_HOST` | `0.0.0.0` | bind address |
| `GEMBA_USER` / `GEMBA_PASS` | — | HTTP basic auth in front of everything except `/healthz` (set both or neither: the server refuses to start with one); **set this before publishing the instance to any hostname** |
| `GEMBA_TRUST_PROXY` | — | `1` behind the Cloudflare tunnel: rate limits are charged to `cf-connecting-ip` (else `x-forwarded-for`) instead of the socket, which is always `127.0.0.1` there. Leave unset on a direct bind, where those headers are forgeable. Limits: 10 asks/min per address, 60/h per identity; 5 sign-ins/min per address, 20/h per email; 5 sign-ups/min. Bodies over 64 KiB (512 KiB for a practitioner's note) answer 413 |
| `GEMBA_SESSION_IDLE_MINUTES` | `720` | a session with no request for this long (12 h) is refused and its row deleted. The absolute 30-day `expires_at` stays the ceiling; this can only shorten a session. Non-numeric or non-positive ⇒ the default |
| `GEMBA_SESSION_ADMIN_IDLE_MINUTES` | `60` | the same for an operator (`role = 'admin'`), 1 h. The role is read on every request, so a promotion takes effect on the person's next request. Non-numeric or non-positive ⇒ the default |
| `GEMBA_DATA_DIR` | `./data` | where the SQLite file and the admin token live |
| `GEMBA_DB` | `<data>/gemba.db` | database path |
| `GEMBA_GATE_RULES` | `<data>/gate.rules.json` | a deployment's additions to the gate (employer names in `block_terms`, more customer names, patterns). Absent ⇒ the built-in rules, which name no employer; present but malformed ⇒ the server refuses to start |
| `GEMBA_HOST_PORT` | `8090` | host-side port in `docker-compose.yml`; the container always listens on 8090 internally |
| `GEMBA_ADMIN_TOKEN` | generated into `<data>/admin.token` | operator console token (`/qt/<token>`); never printed to a log. Rotate it from `/admin`, unless it is set here |
| `GEMBA_LLM_KEY` | — | API key for the answer model; absent ⇒ labelled extractive mode |
| `GEMBA_LLM_BASE_URL` | OpenCode (`/zen/go/v1`) | OpenAI-compatible chat-completions base URL |
| `GEMBA_LLM_MODEL` | `deepseek-v4.1-flash` | model id, derived from the gateway when unset (`deepseek/...` for OpenRouter) |
| `GEMBA_LLM_SESSION` | minted at install | the OpenCode gateway routes by this header; without it the call is refused (`400` from the API, or `403` with Cloudflare error `1010` through the edge) |
| `GEMBA_LLM_TIMEOUT_MS` | `45000` | per-request timeout |
| `GEMBA_BANK_BIN` / `GEMBA_BANK_ACCOUNT` | — | VietQR recipient; unset ⇒ the booking page shows the amount with no QR |
| `GEMBA_MAIL_TRANSPORT` | — | `sendmail` pipes each message to `GEMBA_SENDMAIL` (default `/usr/sbin/sendmail`) as `sendmail -i -- <address>`; `file` writes `<data dir>/mail-sink/<id>.eml`. Unset ⇒ nothing is sent and every message waits in the outbox as `pending` |
| `GEMBA_MAIL_FROM` / `GEMBA_PUBLIC_URL` / `GEMBA_OPERATOR_EMAIL` | `Gemba <gemba@localhost>` / `http://localhost:<port>` / the admin accounts | The From header; the origin that goes into every link in a message (set it, or the links are unusable); who is told when a question misses its 48 hours |

Secrets belong in the environment or in the systemd `EnvironmentFile`, never in the repo.

## HTTP surface

| Route | What it does |
|---|---|
| `GET /healthz` | liveness + corpus size + whether the model is configured |
| `GET/POST /signup`, `GET/POST /signin`, `POST /signout` | create an account, sign in, sign out |
| `GET/POST /invite/:token` | a practitioner sets their own password from an invitation (single use, seven days) |
| `GET /desk` | the desk of the signed-in practitioner (the account door, next to `/c/<token>`) |
| `GET/POST /admin/login`, `POST /admin/logout` | operator sign-in |
| `GET /admin`, `GET/POST /admin/experts`, `GET/POST /admin/experts/:id` (+ `/invite`, `/pause`, `/resume`, `/rotate`), `GET /admin/invites`, `GET/POST /admin/settings`, `GET /admin/audit` | the operator console |
| `GET/POST /admin/accounts` (+ `/role`, `/lock`, `/unlock`, `/signout`) | every account, and stopping one |
| `GET /admin/bookings` (+ `/paid`, `/completed`, `/reschedule`, `/cancel`) | reconcile, move or cancel a booking |
| `GET /account` | the signed-in asker's own questions and bookings |
| `POST /api/ask` | JSON ask: question, plant type, asker → answer, citations, coverage, ref |
| `GET /api/question/:ref` | one question with its answer, citations and expert answers |
| `GET /api/experts` | expert profiles |
| `POST /ask` | the HTML ask form |
| `POST /q/:ref/ask-expert` | escalate a refused question to a practitioner |
| `POST /book`, `POST /q/:ref/book` | book a 1:1 session |
| `POST /b/:ref/transferred` | the buyer says they transferred the money |
| `POST /c/:token/answer` | expert answers a routed question |
| `POST /c/:token/note` | expert submits a note (goes through the gate) |
| `POST /c/:token/interview` | a scripted interview (8 fixed questions) that drafts a note; the author edits, attests and publishes it, and the gate runs first |
| `POST /c/:token/confirm`, `/complete` | operator: money arrived; session done |

## Accounts, and what signing in changes

An asker can create an account (name, email, password) and sign in. The session cookie is an
**opaque random id** with a row in `sessions` — not a signed token — so signing out *revokes* it
server-side rather than trusting the client to forget. A session also ends after a stretch of no
requests (12 hours; 1 hour for an operator), well inside its 30 days; presence costs one write a
minute. Passwords are hashed with `scrypt` at
cost `N=2^17`, `r=8`, `p=1`, salts are per-account, verification is constant-time, and the hash
never leaves the database. Password policy is length only (10+ characters, up to 200): composition
rules push people towards `Passw0rd!` and NIST has said to drop them.

What it buys you:

- **Your questions stay findable.** A question asked while signed in is linked to the account and
  listed on `/account`. Guest asks still work and are not lost — they just are not attached to
  anybody.
- **Claiming.** Ask as a guest, then sign in with `keep=<ref>` and the question moves under the
  account (the result page offers exactly that link).
- **Ownership is checked, not assumed.** `/account` redirects to `/signin` when there is no session,
  and it lists only rows whose `user_id` matches.

Sign-ins are rate-limited per address and per email, and every post form carries its session's CSRF token.
What it does not do yet: no password reset and no email verification.

The old `GEMBA_USER`/`GEMBA_PASS` gate is separate and still available: it is the *door*, kept for
protecting a public prototype, while accounts are the *identity* inside it. Tests and LAN runs leave
both off, which is why an unauthenticated instance is still open by design.

## The interface

The visual system is generated, not improvised: `design-system/gemba/MASTER.md` holds the palette,
type scale, spacing, radius and shadow tokens, and `src/views.mjs` carries them as CSS custom
properties. **Orange is the theme** — it carries the brand mark, the primary action, the tint fills
and the highlight on the dark bands — on warm paper (`#F7F4F1` / `#0B1A1D`). Graphite stays for
structure, and a refusal is a graphite panel rather than an amber one: with orange as the brand,
an amber warning would read as brand emphasis, and a refusal must not look like either praise or
an error.

The page shape follows `arbolus.com`, read off the live page rather than copied by eye
(`scripts/read-reference.py` prints the section outline, nav, and the computed styles that matter):
a thin dark utility bar, a light nav bar with one filled CTA, a centred hero with a small uppercase
stat row over a very large headline, the product's primary action in one card, a three-column
feature row, a two-column block with a framed example, a full-width dark band of practitioner cards,
a four-card grid, the money block, a row of real refusals, who it is for, the published notes as
resource cards, a closing dark CTA band, and a four-column footer.

- **Light and dark** are both first-class, driven by `prefers-color-scheme`; every colour pair was
  checked at 4.5:1 or better — on the rendered page, and again from the screenshot's own pixels
  (`scripts/measure-contrast.py`), because a style-based check can pair the wrong background inside
  a dark band.
- **One inline script, no client-side rendering.** Pages are built on the server; the only script
  reports that a slow submit is in flight (`data-pending` on the ask and desk forms) and still posts
  correctly with JavaScript off. The one motion in the system (a short entry fade) is CSS, and it is
  off under `prefers-reduced-motion`. A factory-floor browser and a locked-down corporate one both
  work. Screenshots are taken with animation disabled: a capture taken mid-fade shows a band at
  partial opacity and invents a contrast failure that does not exist.
- **A note is rendered as prose, not printed as markdown.** The reading view (`src/markdown.mjs`) turns
  a note into headings, hanging bullets, real tables and working `[[wiki references]]`, escaping the
  text before it builds any tag — so a note cannot inject markup, whoever wrote it.
- **Accessible by construction**: a skip link, visible focus rings, `aria-current` on the current
  nav item, labels bound to every field, errors next to the field that caused them, and 44px touch
  targets for controls (inline links in text are exempt under WCAG 2.2). `scripts/ui-check.py`
  asserts all of it in a headless browser at 375px and 1440px, and also asserts that cards standing
  side by side line their action rows up.

## Money

Prices are **whole VND integers** — no floats anywhere in the money path. A session is
`rate × minutes`, capped to a minimum block of 30 minutes, split into a 20% platform fee and the
expert's payout (`src/pricing.mjs`).

How money moves today: the booking page shows the **full price** and a VietQR code for the instance's one
bank account (`GEMBA_BANK_BIN`, `GEMBA_BANK_ACCOUNT`) with the booking reference in the transfer note; the
buyer transfers; the operator matches the bank line and marks it paid; later the operator pays the
practitioner's share and any refund from their own bank. The software moves no money, withholds no tax and
issues no invoice. Whether this flow is collection on behalf of others, and what Vietnamese rules attach to
it (reported: withholding on a platform with ordering and payment; a payment-intermediary licence at VND 50bn
charter capital if the platform becomes merchant of record), is **open and needs counsel** — `SPEC.md` §7
states the three money shapes, a recommendation, and the questions. These are engineering notes, not legal advice.

## Tests, and what they caught

365 tests (`npm test`), including an end-to-end walk over real HTTP, plus `scripts/ui-check.py`
(a headless-browser check, not run by `npm test`: overflow at 375/1440, contrast, focus, tap targets, labels, card
alignment, and the primary button sampled from the pixels it actually painted). They are worth more
than the coverage number because of what they found:

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
  rendered through a label map, and a test asserts no raw token reaches an asker's or practitioner's page
  (the operator's audit trail shows events as logged).
- Moving the content to English moved three things at once (UI strings, the refusal marker, the URL
  routes), so the corpus notes were retranslated with the gate's rules restated as a constraint: they
  pass it clean, in the new language (this was untrue for a while: two vault notes carried a figure and the seed attested for them; the attestation is gone from the seed and the notes were rewritten). The gate's Vietnamese patterns stayed — a Vietnamese note
  carrying an employer's order number is still someone else's information.
- Renaming the topics silently mis-attributed every note: the seed mapped topic to author with a
  hardcoded table whose keys were the old Vietnamese slugs, and a `?? 'hung-qa'` fallback turned the
  miss into one author for the whole corpus. The map now comes from the experts' own `topics`, an
  uncovered topic throws, and a test asserts the corpus and the profiles agree.
- `systemctl enable --now` does not restart a running unit, so a deploy reported success while the
  host kept serving the previous build — and the new front gate's page (`Cần đăng nhập`, `lang="vi"`)
  is how it was caught. The installer now restarts and checks the process start time.
- **The app ignored the database it was configured to use.** `createApp` defaulted to a relative
  `data/gemba.db`, and `seed.mjs` to the same string, so `GEMBA_DB` worked and `GEMBA_DATA_DIR` did
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
(next section) when it has to move between machines. Both read the same `GEMBA_*` variables, write
the same SQLite schema, and honour the same data path — the app opens the database it is configured
with, never a file that happens to sit next to the source.

`deploy/install.sh` is idempotent: it installs Node from the official tarball, copies the tree,
writes `/etc/gemba/gemba.env` (mode 600), installs `deploy/gemba.service`, re-seeds the corpus, and
**restarts** the service — then proves the restarted process is the one it just installed, because
`systemctl enable --now` leaves an already-running unit on the old code (and the old database) while
every check passes against it.

The re-seed is an upsert by slug, followed by a **retire** step: a seed note whose slug has left the
seed set is deleted, so renaming a note updates the corpus instead of leaving the old copy published
next to the new one. Notes written by a person (`origin: expert|interview`) are never touched — the
corpus is the deployment's content; the questions and notes are the operator's.

```bash
bash deploy/install.sh                 # on the host
GEMBA_LLM_KEY_FILE=/root/llm.key bash deploy/install.sh  # key from a file, not from the environment
```

It runs as a systemd service (`gemba.service`) on the demo host `192.168.1.150:8090`. Ports 80/443
there belong to another stack, so the app is published on 8090 — a reverse proxy is the deployment's
job, not the app's.

### Backups, and the one thing that must never be lost

The database is the product's only state: the questions, the bookings, what was paid, the published
notes. `deploy/gemba-backup.sh` takes a **transactionally consistent** copy (`VACUUM INTO`), opens it
again, runs SQLite's integrity check, prints the row counts, and prunes copies older than seven days.
`deploy/gemba-backup.timer` runs it hourly; the installer enables the timer and takes the first copy, so
a fresh install is never the only copy.

```bash
deploy/gemba-backup.sh                    # take one now
deploy/gemba-backup.sh --list             # what is held, with ages
deploy/gemba-backup.sh --verify <file>    # does this copy open, and what is in it
GEMBA_BACKUP_REMOTE=b2:gemba-backups deploy/gemba-backup.sh   # and copy it off the host
```

Restoring is a deliberate act, not a command in a script: stop the service, prove the copy opens with
`--verify`, move the live file aside rather than over it, put the copy in its place, start the service,
and ask `/healthz`. Copying or `tar`-ing a live volume is the thing this replaces: it can capture the
database and its write-ahead log at different instants, which restores into a database that never existed.

### Docker, to move it to another machine

The whole product is one Node process — no separate frontend service, no build step, no database
service — so the image is the source tree plus a writable `/data`.

```bash
cp .env.example .env       # fill in GEMBA_USER/GEMBA_PASS, and GEMBA_LLM_KEY for real answers
docker compose up -d       # builds the image and serves on :8090
docker compose logs -f gemba
```

Or from the published image, no checkout needed:

```bash
docker run -d --name gemba -p 8090:8090 --env-file .env \
  -v gemba-data:/data ghcr.io/phamtruonghung/gemba:latest
```

`deploy/docker-smoke.sh` does the whole thing and cleans up after itself: build, start, check the
gate from outside (401 without credentials, 200 with them), ask a real question *through the
container*, and print what landed in the volume. Use it after changing anything in `src/`.

State is only the volume (`gemba-data`: the SQLite file plus the generated admin token), so carrying
an instance to another machine is:

```bash
docker save ghcr.io/phamtruonghung/gemba:latest | gzip | ssh other-host 'gunzip | docker load'
docker run --rm -v gemba-data:/data -v "$PWD:/backup" alpine tar czf /backup/gemba-data.tgz -C /data .
```

The container always listens on 8090 internally and always writes `/data`; `GEMBA_HOST_PORT` moves
only the host-side port. The entrypoint seeds the corpus when the volume is empty and says loudly
when `GEMBA_PASS` is missing, so an ungated container announces itself in the log rather than
quietly becoming an open model bill.

### Publishing it to a hostname

The ask form spends money: every question calls a model. An instance reachable from the internet
without a gate is therefore an open bill and an open spam target, so the app carries its own front
gate rather than relying on the deployment to remember one:

- set `GEMBA_USER` and `GEMBA_PASS` and every path — the pages, `/api/ask`, the expert desks, the
  console — answers `401` with a basic-auth challenge until the browser authenticates;
- `/healthz` stays open (it is the readiness probe) and deliberately does not print the database path;
- with neither variable set the app is open, which is what local development wants;
- the installer refuses to continue when only one of the pair is set: a half-configured gate used to
  leave the instance open while every check reported it configured.

Tunnelling is the deployment's business, not the app's. On this host the tunnel is managed in the
Cloudflare dashboard (a token-managed `cloudflared` runs on the Proxmox host), so a public hostname
is one ingress entry there: `gemba.<your-domain>` → `http://192.168.1.150:8090`. Verification that
counts is a request from outside the LAN: `401` without credentials, `200` with them.

For a URL today there is `deploy/quick-tunnel.sh`: it installs `cloudflared`, runs a quick tunnel to
`127.0.0.1:8090`, and prints the `https://<name>.trycloudflare.com` URL. It refuses to start when no
`GEMBA_PASS` is configured, because that would publish an open ask form. The URL changes on every
restart and the tunnel dies with the host — a demonstration instrument, not an address anyone should
bookmark.

## What is deliberately not built

No payment gateway or escrow, no Zalo notification (email goes through the outbox, below), no expert
KYC/vetting, no invoice or withholding module, no final contracts or ToS (the Vietnamese terms pages are drafts
marked as not reviewed by counsel), no mobile app, no analytics. Accounts exist for askers (email + password,
above) and for the operator (`/admin`); practitioners get accounts by invitation rather than by registering.
There is no password reset by email (a practitioner who loses one uses a fresh desk link) and no email
verification. `SPEC.md` § *Open questions* names the ones that must be decided before selling
anything.

## Repo layout

```
src/       db.mjs  auth.mjs  gate.mjs  retrieval.mjs  pricing.mjs  llm.mjs  interview.mjs  views.mjs  server.mjs
scripts/   seed.mjs  import-notes.mjs  smoke.sh  ui-check.py  ui-shots.py  probe-*.mjs
           read-reference.py  measure-contrast.py  probe-block.py   # design evidence, not opinions
design-system/gemba/MASTER.md   the generated visual system the interface is built from
seed/      experts.json  topic-map.json  corpus/  vault-raw/
test/      one file per area (`*.test.mjs`); docs.test.mjs fails when a number in this README drifts
deploy/    install.sh  gemba.service  quick-tunnel.sh  entrypoint.sh  docker-smoke.sh  gate.rules.example.json
Dockerfile  docker-compose.yml  .env.example     the same app as a container, for another machine
.github/workflows/ci.yml                          tests, then build-and-publish the image
SPEC.md    the mechanism being copied, the constraints, the decisions, the open questions
```

## License

MIT (`LICENSE`). The compliance notes in `SPEC.md` are engineering notes, not legal advice.


## Outbox: the one place a message leaves the system

A question reaching practitioners, an answer arriving, a confirmed time, a received payment and a late answer
each write a row to the `outbox` table in the same transaction as the fact (`src/outbox.mjs`). A runner sends
the pending rows and marks each `sent`, or back to `pending` with the error until five attempts, then `failed`.
`/admin/outbox` shows every row (address by domain only), and the questions past their 48 hours.

- **Timer and by hand.** The server sweeps and delivers every 60 seconds. `node scripts/sweep.mjs` does the same
  once and prints the counts and the newest rows (use `GEMBA_ENV_FILE=/dev/null` on a machine whose `.env` holds
  a model key); the operator console has a "Run the sweep now" button. A second process alongside the server is
  safe: rows are claimed with a compare-and-set.
- **The 48-hour promise.** A routed question with no answer past `due_at` is flagged once (`breach_at`, a `breach`
  event), the operator is told, and the asker is told it is late and offered a re-route to other practitioners
  or a paid session. A question is free, so there is nothing to refund.
- **Transport hook.** `createApp({ transport })` takes `async (msg) => {}` with `msg = { id, kind, to, subject, body, from, raw }`
  and resolves when the message is out: a Zalo ZNS or SMTP relay plugs in here. None is shipped, because there is no vendor account.
- **Addresses.** Only a plain email address is sent to. A phone number in the contact box is recorded as `failed:
  no email address on file`, so the operator sees the promise and can phone the person.
- **Paid sessions.** Once the practitioner has confirmed a time with a meeting link and the booking is paid, the
  booking page shows "Join the session" and an "Add to calendar" `.ics` (`/b/<ref>/session.ics`).
