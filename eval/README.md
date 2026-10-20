# Measuring the answer tier

This directory holds the labelled questions and the baseline that `scripts/eval-retrieval.mjs`
scores. It measures the retrieval half of the answer tier (issue #29): given a question, does the corpus
get covered or refused correctly, and does the right note come first. It runs offline with no model key,
builds the corpus exactly as the server does (seed into `:memory:`, `buildIndex`), and is deterministic.

```
npm run eval                                        # score eval/questions.jsonl, compare to eval/baseline.json, exit 1 on regression
npm run eval -- --json                              # machine-readable summary and per-question results
npm run eval -- --questions eval/holdout-2.jsonl    # score another file (printed only, never compared or written)
npm run eval -- --tune stem=true,margin=0.1         # override a TUNING switch for one run (sweeps, ablations); printed only
npm run eval -- --write-baseline                    # rewrite eval/baseline.json (default questions file, no --tune)
```

CI runs `npm run eval` after the unit tests (`.github/workflows/ci.yml`). `npm test` does not run it.

## The sets and the label rule

| File | Questions | Role |
|---|---|---|
| `questions.jsonl` | 51: on 21, near 12, off 12, adv 6 | dev set, the gate. Tuned against. |
| `english.jsonl` | 26: on 15, near 4, off 5, adv 2 | English and padding cases from the issue. Dev set: written during this work, used for ablations and sweeps. Not held out. |
| `holdout-1.jsonl` | 16 | written by a reviewer on `improve/retrieval`. Used once there to diagnose a false cover, so no longer clean. |
| `holdout-2.jsonl` | 18 | never used for tuning here; scored once, at the end. |

Label rule: every label quotes the corpus. An `answer` label is given only when a note states the answer
and `why` says where; a `refuse` label is given when no note does. Labels are not set from what the code
does. `english.jsonl` was checked against the current seed corpus (after the #35 vault edits): the claims
in `e04`-`e14` (three parts, two plants, 5-10 minute breakdown vs under-5 minute minor stop, the 14-day
rule, "five is an example number", hold your position then four questions) are in the notes, and the
refuse labels `e16`-`e19` (no OEE benchmark, no andon vendor or price, takt never calculated, no fishbone)
are absent from them. No label was changed. `holdout-1`/`holdout-2` are byte-identical to the ones on
`improve/retrieval`, and `questions.jsonl` is unchanged from #34.

## The gate

`npm run eval` fails (exit 1) if any of these falls below `eval/baseline.json`: accuracy, strict-correct
rate, refusal accuracy, coverage precision, coverage recall, top-1 accuracy, MRR@5.

## Before and after

Baseline is commit c3d65df (before any #29 change), run through the same harness with the question file
swapped. Final is this tree.

| Set | Before TP/FP/TN/FN | Before P / R | After TP/FP/TN/FN | After P / R |
|---|---|---|---|---|
| questions (51) | 1 / 0 / 29 / 21 | 1 / 0.0455 | 21 / 0 / 29 / 1 | 1 / 0.9545 |
| english (26) | 6 / 1 / 10 / 9 | 0.857 / 0.40 | 14 / 0 / 11 / 1 | 1 / 0.933 |
| holdout-1 (16) | 0 / 0 / 7 / 9 | n/a / 0 | 6 / 0 / 7 / 3 | 1 / 0.667 |
| holdout-2 (18) | 0 / 0 / 9 / 9 | n/a / 0 | 3 / 0 / 9 / 6 | 1 / 0.333 |

questions.jsonl, all metrics:

| Metric | Before | After |
|---|---|---|
| Coverage precision | 1 | 1 |
| Coverage recall | 0.0455 | 0.9545 |
| Accuracy | 0.5882 | 0.9804 |
| Top-1 accuracy | 0.6364 | 1 |
| MRR@5 | 0.7273 | 1 |
| Per set on / near / off / adv | 0.0476 / 1 / 1 / 0.8333 | 0.9524 / 1 / 1 / 1 |

Top-1 (before / after): holdout-1 0.7778 / 1, holdout-2 0.7778 / 1, english 0.6667 / 1 (on only).

Target: precision >= 0.95 and recall >= 0.85 on `questions.jsonl`, offline and in CI. Met on the dev set (1 / 0.9545).
It is not met on holdout-2 (precision 1, recall 0.333): see "How optimistic".

## The prescribed items

TP / FP / TN / FN on questions, english, holdout-1 (holdout-2 was not used for any decision). "Switch off" = `--tune`.

| # | Item | Outcome | Evidence (questions / english / holdout-1) |
|---|---|---|---|
| 1 | English stopwords | Kept | off: 20/0/29/2, 11/1/10/4, 6/0/7/3. On: 21/0/29/1, 14/0/11/1, 6/0/7/3. "please", "for our plant in Binh Duong" no longer count as missing topic words (test: padding invariance). "plant", "factory", "site" are stopwords as place context. |
| 2 | Coverage on distinctive missing tokens, not a flat share | Modified | The share is idf-weighted per unit (one concept = one unit, weighed by its rarest token). Requiring a distinctive covered unit (`distinctShare` 0.25) is kept. Pure `scoring=distinctive`: 22/0/29/0, 13/1/10/2, 4/0/7/5, so best on dev, worst on holdout-1 and a false cover on english: reverted. |
| 3 | Light English suffix normalisation | Reverted | `stem=true`: 21/2/27/1, 14/2/9/1, 6/0/7/3. `stem=fallback`: same. Two false covers, no gain; off by default. Plurals that matter are handled by hand-listed inflections in the lexicon. |
| 4 | Acronym map (OEE, SMED, TPM, 5S, OPL, andon, both ways) | Kept | off: 21/0/29/1, 12/0/11/3, 6/0/7/3. Neutral on dev, +2 on english (long forms "overall equipment effectiveness", "single minute exchange of die"). Long form and short form are rewritten to the same token on the note and question side. |
| 5 | Diacritic-sensitive index | Kept, no eval effect | off: identical on all three. No labelled question turns on it; kept on correctness grounds and covered by a unit test (hạt vs hát; mã = code, ca = shift, đèn = lamp; bare "ma" says nothing; unaccented input still works). |
| 6 | `##` chunking, send the matched chunk, cut at a boundary | Kept for the passage only | Chunk-level ranking and chunk-level coverage were measured on `improve/retrieval` and lost (recall 0.77 to 0.50; FP 1 to 2), so chunks never change the verdict. They choose what the model sees. Test: the answering section of a 10 KB note, which sits past character 1400, is what is sent, with its heading, not cut mid-word. |
| 7 | Top-1/top-2 margin rule | Reverted (switch kept, off) | margin 0.05/0.1/0.2: no change; 0.3: 20/0/29/2, 6/0/7/3 (-1 TP); 0.5: 20/0/29/2, 5/0/7/4; 1: 15/0/29/7. There is no false cover for it to remove, so it only costs recall. A margin refusal is a soft vote. |
| 8 | Model's thin vote primary when a key is configured | Kept | `hard` thin (nothing matched, too short, weak top, only everyday words shared) never reaches the model; a share/margin `thin` is a soft vote and goes to the model, whose own coverage vote (`ok` or INSUFFICIENT_DATA) stands, behind every #36 check (citations, markers, per-sentence groundedness). Not measured by the offline eval, which has no key; unit-tested. |

## Experiment log

Rows from `improve/retrieval` (tuning on questions.jsonl, TP/FP/TN/FN; baseline 1/0/29/21) are quoted from
its README; this tree reproduces its final state, so I re-ran only the ablations above.

| Experiment | TP / FP / TN / FN | P / R | Result | Why |
|---|---|---|---|---|
| Vietnamese to English lexicon, compounds, inflections | 1/0/29/21 to 17/1/28/5 | 0.94 / 0.77 | Kept (ported) | Largest recall gain |
| Artifact marker, any-present full credit | 19/0/29/3 | 1 / 0.86 | Kept (ported) | |
| Hand-listed inflections | 20/0/29/2 | 1 / 0.91 | Kept (ported) | |
| Generated inflections / stemming | 14-16 / 0-2 / 27-29 / 6-8 | | Reverted | recall down or FP up; reproduced here |
| Chunk-level ranking or coverage | 11-17 / 1-2 / | | Reverted | see item 6 |
| Distinct-unit rule, `distinctShare` 0.25 | 20/0/29/2 | 1 / 0.91 | Kept (ported) | removes the "mã hàng ... công nhân may" false cover |
| English stopwords with place words, bridge for English synonyms (reduce/shorten/cut) | 21/0/29/1 | 1 / 0.9545 | Kept (this work) | +1 TP over the ported state (20), padding invariance |
| Acronym long forms, `ca` as shift | 21/0/29/1 | unchanged on dev | Kept | english +2 |
| Soft/hard thin split and model-primary vote | n/a offline | | Kept | item 8 |
| Fallback routing: an unmatched question stays visible to the practitioner it was routed to | n/a | | Kept | see "Tests" below |

### Sweeps

All rows TP/FP/TN/FN on questions / english / holdout-1. Chosen value in bold.

`minShare` (coverage share threshold):

| minShare | questions | english | holdout-1 |
|---|---|---|---|
| 0.30 | 22/6/23/0 | 14/2/9/1 | 7/2/5/2 |
| 0.40 | 22/3/26/0 | 14/2/9/1 | 6/0/7/3 |
| 0.45 | 22/2/27/0 | 14/1/10/1 | 6/0/7/3 |
| **0.50** | 21/0/29/1 | 14/0/11/1 | 6/0/7/3 |
| 0.55 | 20/0/29/2 | 13/0/11/2 | 5/0/7/4 |
| 0.60 | 16/0/29/6 | 13/0/11/2 | 2/0/7/7 |
| 0.70 | 14/0/29/8 | 12/0/11/3 | 1/0/7/8 |

0.50 is the smallest value with no false cover on any of the three sets. The margin is thin: lowering it to
0.45 admits 2 false covers on questions.

`minTop` (BM25 floor): 1.5, 2.2, 3, 4 all give 21/0/29/1, 14/0/11/1, 6/0/7/3; 6 loses one english TP. Flat; 2.2 kept.

`distinctShare`: 0.15 gives 19/0/29/3 and 9/0/11/6 (too strict); 0.25, 0.35, 0.5 are identical. 0.25 kept.

`margin`: see item 7. `clauseShare` (cover if one clause of a long question is covered): 0.5 gives
22/1/28/0 and 15/0/11/0; 0.6 gives 21/1/28/1; 0.7 and 0.8 are no change. It would fix the long paragraph
question e15 but costs a false cover on questions.jsonl at the values that work, so it stays off.
`missPower=2` (the worst miss decides): 22/2/27/0, 15/2/9/0, a false cover on each: reverted.

## Remaining failures

- `q07` "andon chia may cap, cap nang thi xu ly sao" (share 0.487, just under 0.50). Written without
  diacritics, bare "may" bridges to "machine", which the andon note does not contain. Making bare "may"
  strict would break every unaccented "may dung" question.
- `e15` the 52-word paragraph version of the flagship question (share 0.268). Length still costs share:
  every unseen word (plastics, three presses, night crew, month) counts a little as a miss. The issue's
  other complaint, a 62-word paragraph at 18x the floor being refused, is not fixed for the very long form.
  A shorter padded version ("Last night at our plant in Binh Duong a machine stopped in the middle of the
  shift, what is the right order ...") is covered. With a key configured this refusal is a soft vote that
  the model can overrule.
- holdout-1: `h04`, `h06`, `h08` (shares 0.31, 0.19, 0.24). holdout-2: `g01`, `g03`, `g04`, `g06`, `g07`,
  `g08` (shares 0.19 to 0.45). All are Vietnamese phrasings the lexicon does not bridge. Every one has the
  right note at rank 1; they are refusals, the safe direction.

## How optimistic these numbers are

- The dev recall 0.9545 is optimistic. Most of the lexicon was written on `improve/retrieval` while
  looking at the misses of `questions.jsonl` and holdout-1. That branch measured the cost of removing ten
  such entries: dev recall fell to 0.7273. The 21 of 22 here is a fit, not a forecast.
- The honest estimate for phrasing the lexicon has not seen is holdout-2: recall 0.333, precision 1,
  scored once at the end of this work (3/0/9/6). It does not meet the 0.85 target. The score is the same as
  on `improve/retrieval` because the lexicon was ported; nothing here was tuned against it.
- `english.jsonl` was written during this work and the switches (stopwords, acronyms, synonyms) were
  chosen while looking at it. Its 14/0/11/1 is dev, not held out.
- Precision has held at 1 on all four sets, so the system errs toward refusal. A false refuse hands the
  question to a practitioner; a false cover shows an answer the notes do not support. The second is the
  failure that matters and none was measured. With 30 or fewer refuse labels per set, "no false cover" is
  weak evidence: the minShare sweep shows 2 appear if the line moves by 0.05.
- Nobody measured the model path (item 8); the offline eval cannot.
- The corpus is 12 notes. A corpus change can move a question across the line, which is what the gate is for.

## Tests

`test/retrieval.test.mjs`: padding invariance, the fire-an-operator refusal (plain and padded), acronym
expansion both ways, diacritics (mã/ca/đèn, hạt vs hát, unaccented input), Vietnamese reaching the English
note, the matched section sent whole and not cut mid-word, the `##` chunker, the margin switch, and the
soft/hard thin vote.

Contract note (#36): the stricter retrieval now finds no hits at all for off-corpus questions that used to
match by accident. `test/app.test.mjs` "the full ladder" asks "rules for seasonal labour contracts outside
the plant"; it used to hit a note by chance and so was routed to a practitioner by topic. With no hits the
topic is "other", and escalation falls back to the first practitioner, but `openQuestionsFor` only showed
questions whose topic the practitioner accepts, so the question reached nobody's desk. The fix is in
`src/db.mjs`: a question routed to an expert by id is also on that expert's desk. The test is unchanged, and
none of the #36 guarantees (citations against `passagesSent`, markers, per-sentence groundedness, the
untrusted block, retries) was touched.
