# Where the craft corpus comes from

`seed/corpus/` holds the notes the library answers from. Two groups live there:

- the vault notes (`vault-*`), whose source is the founder's own notebook (`seed/vault-raw/`);
- the demo notes (`demo-*`), curated craft notes written for the trial build.

This file records the provenance of a set of `demo-*` notes that were distilled from a published
lean reference library, **artoflean.com**, so a reviewer can check a note against its source and the
next maintainer can tell whether the source has moved.

## What was read

The site was crawled in full, once, on 2026-11-15: `sitemap-index.xml` → `sitemap-0.xml` lists
**457 URLs**, every one was fetched, and each page's main text was extracted to a plain-text file.
None failed. Extracted text totalled **3,506,658 characters**.

By section (page count / extracted characters):

| Section | Pages | Characters | What it holds |
|---|---|---|---|
| `/articles/` | 160 | 1,108,503 | essays: TPS history, problem solving, chief engineer, coaching |
| `/reference/` | 129 | 992,615 | encyclopaedia entries: terms, tools, people, plants |
| `/learning/` | 68 | 788,429 | multi-part guides: Standardized Work, Job Instruction, Job Relations, Kaizen, FMDS, 3 Pillar, Problem Solving |
| `/documents/` | 44 | 187,187 | forms and course material (TWI cards, breakdown sheets) |
| `/gemba-coach/` | 30 | 172,861 | short question-and-answer entries ("Ask Art") |
| `/topics/` | 10 | 7,326 | topic indexes |
| `/research/` | 6 | 138,277 | studies (e.g. the 3 Pillar Activity's academic follow-up) |
| `/a3-report/` | 6 | 104,486 | worked A3 examples, historical reconstructions |
| the rest | 4 | 6,974 | home, about, books, one lean-AI page |

The crawl is a one-shot research artifact, not a script this repo ships or runs: it produced text,
not published content, and nothing it downloaded is committed. Each note below names the pages it
draws on, so a note can be re-derived by reading those pages.

## Which note came from which page

| Note (`seed/corpus/`) | Source pages |
|---|---|
| `demo-four-types-of-problems-one-method-each.md` | `/learning/four-types-of-problems/` |
| `demo-six-step-kaizen-and-why-the-events-do-not-stick.md` | `/learning/kaizen/the-procedure/`, `/gemba-coach/why-does-kaizen-fail/` |
| `demo-standardized-work-three-elements-three-forms.md` | `/gemba-coach/standardized-work-three-forms-three-elements/`, `/gemba-coach/takt-time/` |
| `demo-job-instruction-the-four-steps.md` | `/learning/job-instruction/four-step-method/`, `/learning/job-instruction/job-breakdown-sheet/` |
| `demo-job-relations-the-four-steps.md` | `/learning/job-relations/four-step-method/` |
| `demo-fmds-the-daily-management-board.md` | `/learning/fmds/`, `/gemba-coach/what-does-fmds-stand-for/` |
| `demo-the-3-pillar-activity-three-pillars-one-foundation.md` | `/learning/3-pillar-activity/` |
| `demo-poka-yoke-prevention-before-occurrence.md` | `/gemba-coach/poka-yoke/`, `/gemba-coach/mistake-vs-error-proofing/` |

The same work changed one existing note and worded one new note to avoid a collision, both measured
by `npm run eval` (see the pull request). `demo-andon-surface-the-abnormal.md` now says the call is
*split* into levels and how the heavy level is *handled*, because `q07` — the question it used to
answer — fell to a 0.497 share against the 0.5 floor once the eight new notes diluted the idf of the
words they share. `demo-job-relations-the-four-steps.md` is new in this change, and was written
without the word "leave" from the start, because it would have made an unrelated question about
annual-leave entitlement look covered. Neither change alters what the note teaches.

## What the notes keep, and what they drop

Kept: the order of the steps, the reasoning behind each, the failure modes the source names, and
the lines where the source is careful about its own provenance (the four-type taxonomy is its
author's model published by the Lean Enterprise Institute and is **not** official Toyota
terminology; the 3 Pillar framework was released to global plants as evaluation sheets in 2007, as a
standardisation layer inside TPS rather than the whole of it).

Dropped on purpose: every named individual at a plant, every company figure, and the site's own
promotional pages. People named in the lean literature as the authors of a method are named when
the attribution is the point (a quote, an origin); no plant person, customer or supplier is named
anywhere.

## Re-checking the corpus against the source

The publishability gate runs on every one of these notes exactly as it runs on an expert's
submission (`npm run seed` prints `NOT PUBLISHED` with the rule and the match for anything that
fails). The retrieval effect of the additions is measured by `npm run eval`; that command is the
gate, and `eval/README.md` says what its sets mean.
