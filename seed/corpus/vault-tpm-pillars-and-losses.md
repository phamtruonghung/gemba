---
title: TPM pillars and the losses they target
topic: tpm
origin: vault
source: seed/vault-raw/tpm-pillars-and-losses.md
---

# TPM pillars and the losses they target

> What each TPM pillar asks of a supervisor day to day, and the loss vocabulary the abnormality pages classify with. The pillar list is **not** one canonical standard — JIPM, which introduced TPM in 1971, groups the eight into four loss-reduction pillars, two enabling pillars and two it calls optional and site-dependent. Source: the supervisor documentation brief (raw source above), which cites JIPM and JMAC, JIPM's consultancy arm. Related: [[production-glossary]], [[oee-factors-and-benchmarks]], [[board]], [[how-open-work-is-managed]]

## The eight pillars, and the grouping that matters

| Pillar | What it asks of the supervisor, day to day |
|---|---|
| Focused Improvement (kobetsu kaizen) | Quantify the losses on your line; keep an improvement list with owners and dates |
| Autonomous Maintenance | Operators clean, inspect and lubricate their own equipment; checklists signed daily; tags raised and closed |
| Planned Maintenance | Report the degradation found; respect the PM windows; record breakdowns that should have been prevented |
| Quality Maintenance | Maintain the conditions that prevent defects; record the defect *conditions*, not only the defects |
| Early Management (new product/equipment) | Feed startup losses and lessons into the next launch |
| Education and Training | Track the skill matrix; train on standard work; verify by observation |
| Office TPM | Non-production functions remove their own losses (admin delays, paperwork) |
| Safety, Hygiene, Environment | Zero-accident behaviour; near-misses reported daily, not monthly |

JIPM's own grouping, which most 8-pillar diagrams drop: **loss-reduction** = Focused Improvement, Autonomous Maintenance, Planned Maintenance, Quality Management · **enabling** = Education and Training, Safety/Hygiene/Environment · **optional, "correct accordingly, depend on the company or factory"** = Early Management, Office TPM.

## The 16 major losses — and the eight that are equipment losses

JIPM's taxonomy has 16 entries; eight are equipment losses, and they carry numeric thresholds worth pinning, because the threshold decides whether an event becomes an abnormality page or a line on a daily page:

- **Breakdown** — unexpected or chronic failure; conventionally a repair longer than **5–10 minutes**
- **Setup / changeover and adjustment** — from last good piece to first good piece of the next product
- **Tool / blade change** — scheduled replacement plus breakage, and the defects either side of it
- **Startup** — from start to stable quality, with no mechanical fault
- **Minor stop and idle** — stoppages under **5 minutes** that need no part replaced or repaired
- **Speed** — running below the designed speed, or a design speed below current capability
- **Defect and rework** — quantity loss from non-conforming output
- **Shutdown** — the loss from planned stops

The remaining eight are labour and unit-cost losses, which is why "reduce losses" is not only a maintenance instruction.

## How this applies here

- Abnormality pages already classify with the **Six Big Losses** (`loss_category`) — the OEE-measurable subset of the 16, mapped in [[oee-factors-and-benchmarks]].
- The reportable-stop threshold — JIPM's 5–10 minutes versus "anything long enough to explain" — is still *open* in [[production-glossary]]. Pin one number before the shift supervisors start reporting, or the same event is logged by one shift and ignored by another.
- The pillars that produce the loop the task pages already carry are Focused Improvement and Autonomous Maintenance: countermeasure → verification date → effective? → yokoten → standard updated. The pillar page does not create new process; it explains why that loop exists.
- **Deferred by decision (2026-09-20):** gemba walk, kaizen/A3 and 5S audit pages are not in this wiki. Nothing here should imply those routines run at this plant yet.
