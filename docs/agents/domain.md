# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

**Layout: single-context.** One `CONTEXT.md` at the repo root plus `docs/adr/`. There is no
`CONTEXT-MAP.md` and none is expected: gemba is one program with one vocabulary (the four rungs —
ask, answer-or-refuse, escalate, pay), not a multi-package monorepo. If it ever grows per-context
docs, that is the moment to add `CONTEXT-MAP.md` and a `CONTEXT.md` per context — not before.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root — the domain glossary: what gemba's words mean.
- **`docs/adr/`** — read the ADRs that touch the area you are about to work in.
- **`README.md`** (how to run it) and **`SPEC.md`** (the bet, the market, the decisions and the open
  questions) — the existing documents of record. `SPEC.md` is the authority on why the code is shaped
  this way, and it is the first place to look before proposing that something be done differently.

If `CONTEXT.md` or `docs/adr/` is empty or thin, **proceed silently**. Don't flag the absence; don't
suggest creating files upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and
`/improve-codebase-architecture`) grows `CONTEXT.md` lazily, when terms or decisions actually get
resolved.

## File structure

```
/
├── CONTEXT.md                       ← the glossary (grows as terms get resolved)
├── docs/adr/
│   ├── 0001-<decision>.md
│   └── 0002-<decision>.md
├── README.md                        ← what it is, how to run it
├── SPEC.md                          ← the bet, the mechanisms, the open questions
└── src/                             ← every module of the app, one concern each
```

ADRs are numbered `NNNN-kebab-title.md`, in `docs/adr/`, added with the change that makes the decision
real. A decision that contradicts an existing ADR gets a new ADR that supersedes it, not an edit to the
old one.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test
name), use the term as defined in `CONTEXT.md` and `SPEC.md`. Don't drift to synonyms the glossary
explicitly avoids — this codebase is full of load-bearing words (`refusal`, `rung`, `escalation`,
`operator`, `practitioner`, `published note`), and a synonym in an issue title sends the next agent
looking for a module that doesn't exist.

If the concept you need isn't in the glossary yet, that's a signal: either you're inventing language
the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders), but worth reopening because…_
