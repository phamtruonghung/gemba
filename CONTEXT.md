# CONTEXT — gemba

The domain glossary. **Stub:** the five lines below are taken from `README.md` and `SPEC.md` so the
layout is real; the vocabulary grows here as terms get resolved (`/domain-modeling`), not upfront.

- **gemba** is a factory-production knowledge platform for Vietnamese manufacturing: a supervisor asks
  a production problem in plain language and gets an answer built only from published practitioner
  notes, carrying its citations.
- **The refusal is the product.** When the notes do not cover a question the system says so and hands it
  to a real practitioner — a plausible paragraph a model invented is worth less than no answer.
- **The four rungs** are ask (retrieval over the published corpus), answer-or-refuse (`INSUFFICIENT_DATA`
  when the notes don't support it), escalate (route a refused question to a practitioner, 48-hour
  deadline), pay (a 1:1 session booked in VND, paid by bank transfer, settled by the operator).
- **Two operator doors:** `/qt/<token>` is the no-sign-in reconciliation link; `/admin` is the account
  that holds the real power (prices, roster, invitations, audit trail) and needs a session.
- **Terms:** _published note_, _practitioner_, _escalation_, _refusal_, _operator_, _rung_. Use these
  words; `SPEC.md` is the authority on what each one is allowed to mean.

Decisions live in `docs/adr/`. Read `docs/agents/domain.md` for how skills should consume this file.
