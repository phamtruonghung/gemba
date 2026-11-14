---
title: Poka-yoke: prevention before occurrence
topic: quality
origin: demo
source: https://artoflean.com/gemba-coach/poka-yoke/
---

# Poka-yoke: prevention before occurrence

> Distilled from the Art of Lean reference library (artoflean.com): its Gemba Coach entries on poka-yoke, on mistake-proofing versus error-proofing, and on mizen-boushi. The guide is careful with the history and this note keeps that care: the device was not invented with the word, and the word is a renaming as much as an invention. Related: [Andon: surface the abnormal before it becomes an incident](/notes/demo-andon-surface-the-abnormal-before-it-becomes-an-inciden) · [One-point standard — how to write so others do it right](/notes/demo-one-point-standard-how-to-write-so-others-do-it-right)

## What it is

Poka-yoke means mistake-proofing: designing the process so an inadvertent error **cannot be made**, or so it shows itself the moment it happens. Its real range is wider than operator slips — many applications are quality applications, built to keep a defect from being produced or from moving on undetected.

Within Toyota it is best understood as part of jidoka, building quality in at the process so a defect is prevented or caught at source rather than passed downstream. The idea is older than the word: the automatic looms of the early 1900s stopped when a thread broke, and poka-yoke is the device-level expression of the same principle.

The history, briefly, because it says something about the practice: the idea started in English as "fool-proof", entered Japanese industry as a harsher term, and was softened precisely because it insulted the person at the station — an early case of a device being resented for how it was named. What survives the renaming is the reasoning, not the vocabulary: after a defect, ask what physical or procedural change would make it impossible to recur, and build that change in.

## Three strengths, and how to rank a countermeasure

Two families, from the standard account:

- **Control devices prevent the error entirely.** The part physically cannot be loaded backwards. The fixture will not close unless every component is present. The machine will not cycle until the clamp confirms position. The error never occurs.
- **Warning devices signal that an error has occurred.** A light, a buzzer, a count that does not match. Detection is immediate and at source, but a person must still respond.

Control beats warning, and both beat finding the defect at final inspection. A useful grading used in the same source puts every countermeasure on three steps:

| Grade | What it is | Example on a floor |
|---|---|---|
| Administration | Checklists, work instructions, training, passive alerts | "Check the orientation before loading" |
| Detection | A device catches the error and stops the process | A sensor that will not let the cycle start |
| Prevention | The error is physically impossible | A fixture shaped to take the part one way only |

Every countermeasure on a defect can be ranked this way, and the ranking is the argument: two sites can both say "we addressed it" while one has written a reminder and the other has removed the possibility.

The devices are usually simple — guide pins, limit switches, counters, asymmetric fixtures, presence sensors. The value is not the technology; it is the thinking that comes before choosing one.

## Two kinds of human error, and where the countermeasure lives

The English vocabulary separates mistakes from errors, and although the split is an English gloss on a Japanese word that carries no such distinction, it earns its place when you are deciding where to aim.

- **A mental slip** — the intention was right and the execution failed: attention wandered, the wrong part was picked up, a step was forgotten. A fixture that only accepts the part one way removes the slip permanently.
- **A planning mistake** — the intention itself was wrong: a specification, a judgement or a design that should not have been what it was. The operator executes perfectly and the result still fails in service.

The distinction does not limit the tools; it points at the layer. A slip is countermeasured at the operation. A planning mistake is countermeasured **upstream**, in design review and in the engineering knowledge that should have matched the specification to the real conditions — and a poka-yoke on the line that catches its symptom is a detection device bolted to a wrong judgement, not a cure.

## Mizen-boushi: prevention before occurrence

Mistake-proofing on the line sits at the operation, after a process exists, and it is usually reactive: you saw the defect, then you proofed against it. Upstream of all of it is **mizen-boushi** — prevention before occurrence — where the failure modes of a design, a method or a launch are worked out before a part is built. That is the deeper end of the same idea, and the one that decides how much poka-yoke a plant eventually needs.

## What to ask after every defect

- What is the physical or procedural change that would make this impossible, not just unlikely?
- Is my countermeasure on the administration, detection or prevention step of the ladder? If it is a reminder, what would it take to move one step up?
- Was this a slip or a planning mistake? If the intention was wrong, the countermeasure belongs where the intention was set, not only at the station.
- Can the device be defeated — bypassed, taped over, left unplugged — and is there a check that it has not been?
- Will the device survive a change of part, model or material? A proof that only works for one variant is a trap for the next one.

## Honest limits

- Poka-yoke does not replace standardised work; it protects the parts of the work a person can get wrong. A process with no standard has no stable place to put the device.
- Devices accumulate and are rarely removed. A plant can carry a great many proofs and still not know which defects they actually prevent, so the device list needs the defect it answers beside it.
- Anything a person can disable, someone will disable under pressure. Where the device is a warning rather than a prevention, the routine has to answer for it.
