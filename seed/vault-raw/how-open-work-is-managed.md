---
title: How open work is managed — the craft, and what we took from it
created: 2026-09-26
updated: 2026-09-26
type: concept
tags: [follow-up, lesson, sop]
sources: [documents/2026-09-26-open-work-research.md]
confidence: high
---

# How open work is managed

> What operations leaders, management trainers and established systems do with the same three objects this vault holds — a commitment, a deviation, an unanswered question — read from about thirty sources on 2026-09-26 (regulators, training bodies, practitioner forums, first-party framework documents). Every source with its URL and a verbatim quote is in the raw source above. What it settled: five of our mechanisms are ordinary practice, we were missing one rule, and the failure the literature warns about most is the one that applies to us. Related: [[supervisor-operating-rhythm]], [[tpm-pillars-and-losses]], [[SCHEMA]]

## The five things that recur in every source

**1. An open item carries an owner and a date, or it is not tracked.** The management literature states it as a writing rule — a commitment goes down "with an owner and a due date to remove all disambiguation" (The Manager's Handbook) — and every operations source states it as a design rule: tier boards, CAPA actions and RAID entries all put a name and a date on the item, and the two-week rule below exists only because the owner and date were supposed to be there already. An item without them does not rot visibly; it just disappears.

**2. Surfacing and solving are separate acts.** EOS is the clearest statement: 25 minutes of binary on-track/off-track reporting where discussion is forbidden, then 60 minutes of solving, on the grounds that "the Scorecard review only identifies problem areas. It does not solve them." Tiered daily management does the same thing with a reporting pass and an escalation lane, and leader standard work is *collected* rather than solved on the spot. The separation is what keeps the reading fast.

**3. There are three permitted answers to an open item — a fix, a dated plan, or a documented reason why not — and silence is not one of them.** TWI Job Relations builds the escalation branch into its third step; the tier cascade requires exactly those three outcomes and nothing else; the 48-hour escalation clock exists because an item with no owner and no date is the failure it is designed to prevent.

**4. Verification is a later, separate step from action.** A3 stops at "the evidence that the issue has actually been addressed"; CAPA has closure rules of its own; tier countermeasures must be verified before closure; TWI's fourth step is "check results". Taking the action is not the closure — producing the evidence is.

**5. The record must be retrievable and attributed.** The shift-logbook study put "work outstanding" and "signatures of log book authors" into every book, so an unresolved item cannot be dropped and every entry has a name on it; PMI's warning is that such a register fails on *retrieval*, not on capture.

## What this confirms we already run

- **Owner and date** on every task page, with `due: none` written as a deliberate exception rather than an invented date — rule 1.
- **The daily note's carry-over section** is this vault's version of the logbook's mandatory "work outstanding" field — rule 5. The other mandatory category, the author's signature, is the vault's rule that every fact names the raw file it came from.
- **The weekly review reads, the ledger is where an answer happens**, and the generated hygiene section never solves anything — rule 2.
- **The ledger's four states** (open · answered with a source · won't answer · superseded) are the three permitted answers of rule 3, plus a pointer for a question that died with the work it was about.
- **Verification before closure** on abnormality pages — rule 4 — including the countermeasure that closed on a supplier's new batch with a verification date rather than on the complaint stopping.

That is five of five, which is the useful part of the reading: the shape was not invented here, it is the ordinary shape of the craft.

## The rule we were missing: an age limit

No source lets an item sit in the same state forever. One shift for a tier-1 issue; 48 hours for an escalation; 60 days on a CAPA flag; two days red before a 24-hour countermeasure; and the bluntest version, from RAID practice: "Any item assigned to you that has been stagnant for two weeks should be delegated to someone else or marked *Indefinitely deferred* and closed."

This vault aged questions (R11 showed "open N weeks") but drew **no consequence** from the age. Adopted 2026-09-26: **an open question may not pass 14 days without one of the three answers** — answered, deferred with a stated reason and a new date, or declined. `ledger_count.py` prints the over-limit questions mechanically, and the Saturday run has to show them at the top of the review, so the rule does not depend on the run remembering to look.

The same reading supplied the second half of the rule, and it is the part worth keeping: **a blank is a signal, not an infraction.** The Lean Enterprise Institute's guidance on unfilled leader standard work is to ask why it is blank rather than to chase it harder. So an over-limit question is not chased again — the review asks once whether the question is badly formed, not the human's to answer, or whether the volume itself is the problem, and then the question is answered, deferred or dropped.

## What we deliberately did not take

- **A literal routine for the human to follow.** Planet Lean's dissent is that operator standard work distinguishes good work from bad work and does not transfer to senior roles, and the documented decay modes (a sheet filled in from memory at 4pm, a routine piled onto an already-overloaded supervisor, "compliance theatre") are exactly what a daily-notes discipline becomes when it is the human doing the bookkeeping. The vault's version of "make room before you add work" is that the agent writes, counts and files; the human reads one page and answers.
- **A heavyweight register.** RAID logs, GTD's Someday/Maybe and personal knowledge systems all have the same documented failure — the register becomes the work. The mitigations here are scripted counts, one-line questions, and an inline "?" state instead of a new list.
- **More cadences.** The monthly and yearly pages exist to be read, not to be run. Nothing was added to the human's week.

## The failure the literature actually warns about

It is not a missing tool; it is a maintained one that stops being maintained. A partially-maintained system is worse than none; the platform becomes the workload; an unmonitored register is "a historical artifact"; "meetings die when escalations stop coming back answered, so the answer loop is audited before attendance." The exposure here is the automation itself: if the nightly filing or the Saturday review stops, every page in this vault ages at once and the ledger starts lying. Two things already limit the damage — the ledger holds only open questions, so a stalled run shows up as a growing page rather than as hidden rot, and the counts, the ageing and the roll-ups are computed by scripts rather than remembered. The audit that is still missing is the same one the tier meetings use: whether answers come back at all.
## Related
- [[lessons]] — the running journal of portable lessons from the day's work: this page holds the method, that page holds the experience
- [[index]] — the practice scope
