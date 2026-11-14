---
title: The 3 Pillar Activity: three pillars, one foundation
topic: tpm
origin: demo
source: https://artoflean.com/learning/3-pillar-activity/
---

# The 3 Pillar Activity: three pillars, one foundation

> Distilled from the Art of Lean reference library (artoflean.com): its guide to Toyota's 3 Pillar Activity (sanbon-bashira katsudo), which draws on the author's observation of the programme's early seeds and on how it has grown since. Its own caution is worth carrying: the activity is a *standardisation and stabilisation layer* inside TPS, not the whole of it, and it was released to global plants as an evaluation framework in 2007 — decades after TPS itself existed. Related: [TPM pillars and the losses they target](/notes/vault-tpm-pillars-and-the-losses-they-target) · [5S — start where mistakes are easiest, not with a slogan](/notes/demo-5s-start-where-mistakes-are-easiest-not-with-a-slogan)

## What it is

Three pillars, each tied to a different part of the work, standing on a shared foundation.

| Pillar | Related to | What it asks |
|---|---|---|
| Standardized Work | people | Create and improve the standard so that work difficulty and safety concerns are designed out; build a multi-skilled, cross-trained workforce able to run several operations to a known method |
| Process point management | products | Govern the point of contact with the product — the cutting tool on a machining line, the wrench on an assembly — so defects are prevented and causes are found fast |
| Ownership maintenance | equipment | Operators clean and check their own machines, tag the small defects they find, and the group leader plans the countermeasures |

Underneath all three: **4S + 1** — sort, set in order, shine, standardise, and sustain through discipline. Its job is to create a *normal* worksite, because an abnormal condition — a leak, a missing tool, a chip where none should be — only shows itself at a glance when everything has a place and a standard condition. A group begins here, then moves up into the pillars.

## The idea that separates it from ordinary kaizen

Ordinary kaizen acts after a problem becomes visible: a stop, a defect, a breakdown. The 3 Pillar Activity goes after what the source calls the **precursors** to problems — the work difficulty, the small equipment defect, the near miss that occurs long before anything appears as data.

The shape is the old safety observation applied to equipment: behind one major injury sit many minor ones and a long tail of near misses; behind one breakdown sit many small stops and a great many tiny defects. Only the operator can see the precursors, because they are not yet visible as data. The whole point of the activity is to give that operator the knowledge and the routine to notice one and act.

This is why the pillars are *maintained* rather than *installed*. Each has sub-sections, and the whole thing is graded by a qualified internal assessor who works through roughly a hundred evaluation items and expects concrete evidence for every one. Groups earn bronze when the basic kaizen systems are in place, silver when they run kaizen continuously through PDCA, gold when they produce substantial results — and it takes years. One mature plant reached a level beyond gold, tied to deeper TPS methods. It is full participation, not a tool rollout.

## Process point management, in the machining case

The framework's name is the general one; in machining it is *cutting point management*, and it is where the idea is sharpest. To machine a part to standard, four things meet at the point where the tool cuts: the **tool**, the **holder**, the **machine** and the **material** — and together they generate a **chip**.

Each has a standard, and the chip is the evidence that the others are right. Control all four and the part comes out in tolerance; let any one drift and a dimensional problem appears. So Toyota documents and maintains every one of them, which is what lets a problem be confirmed quickly and the cause isolated instead of guessed:

- **The tool** — its conditions, feeds and speeds, referenced on the equipment and in the tooling documentation, with wear inspected under a microscope where tools are reground in house.
- **The holder** — a tool is only as good as what holds it; precision holders are washed and maintained, cleaned where the line can do it, so the holder is clean every time.
- **The machine** — its condition recorded on an accuracy check at hand-over, when the process is qualified to its capability: travel, runout and the like measured and written down, because that baseline is what makes a later problem legible.
- **The material** — incoming and outgoing dimensions known station by station from the operation drawings.

The combined effect is faster problem resolution and, more valuable, the ability to spot the conditions that *will* produce a defect — defect pre-occurrence prevention. Operators in production and in the regrind area are trained to inspect the cutting point, recognise the wear signature, and correct it before a bad part is made; the same inspection extends tool life, which is improvement in its own right.

## Ownership maintenance, in the same case

Machining removes material by making chips, and coolant flow removes most of them — but not all, and every surface that touches the part wears. That is where the operator's attention goes: the **wear parts and the surfaces that locate the work**. Tool holders, datum pads, locating pins, chucks — anything touching the part wears and can trap a stray chip. A chip under a datum pad, or a worn locating pin, throws a good part out of tolerance even when everything else is right.

So the operator inspects those specific parts and surfaces for **wear and cleanliness every shift**, and checks the hydraulic and pneumatic circuits that clamp and hold the part. A holder that does not seat or clamp correctly produces the same defect as a dirty datum.

Much of this the machine can sense for itself — that is jidoka, built-in quality. But automatic detection does not catch everything, and rarely catches it early. Human awareness is what finds the small problem first, which is the whole reason the check sits in the operator's hands.

And when tool, material, cleanliness, machine accuracy and cutting conditions are all held, capability is high enough that problems can be solved **at the front line** — by the operator and the team leader. It does not take an engineer for every defect, which leaves the engineers for the hard ones.

## How it fits alongside the rest

- The 3 Pillar Activity maintains the daily work and the equipment; FMDS develops the people who run it — [FMDS: the daily management board](/notes/demo-fmds-the-daily-management-board). A floor that installs boards without the pillar work has a management ritual with nothing underneath it.
- It is the preventive layer above 5S, not a replacement: 5S makes abnormal visible, the pillars act on what becomes visible.
- The grading matters less than the cadence. What changes a floor is the operator's daily check of the parts that touch the product, not the certificate.

## What to check before claiming a pillar is running

- Can the operator name the wear parts on their machine and show where they check them? If not, ownership maintenance is a poster.
- Is there a tag and countermeasure record for the small defects found, with the group leader's name on the closure?
- For the product pillar: is there a written standard for every variable that meets at the point of contact, and is the chip or the joint the evidence used to confirm them?
- Are the 4S steps running as a habit inside the shift, or as a campaign with an audit date?
- Is the cross-training real — can more than one person run the operation to the standard?

## Where it does not reach

- It does not set targets or cascade them; that is hoshin and the daily board's job.
- It does not replace breakdown maintenance or planned maintenance. Ownership maintenance catches the precursor; when the failure still comes, the maintenance system owns the repair.
