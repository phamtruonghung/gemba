---
title: Standardized work: three elements, three forms
topic: shift-management
origin: demo
source: https://artoflean.com/gemba-coach/standardized-work-three-forms-three-elements/
---

# Standardized work: three elements, three forms

> Distilled from the Art of Lean reference library (artoflean.com): its Gemba Coach entry on the three forms and three elements of standardized work, and its entry on takt time. The elements trace to Toyota's own internal training material, and the guide quotes the 1973 internal manual for the rule that none of the three may be missing. Related: [One-point standard — how to write so others do it right](/notes/demo-one-point-standard-how-to-write-so-others-do-it-right) · [The supervisor's operating rhythm](/notes/vault-the-supervisor-s-operating-rhythm-the-craft)

## What standardized work is, and what it is not

Toyota's old training definition is still the most useful one: standardized work is a document centred on human motion that combines the elements of a job into the most effective sequence, with minimal waste, to reach the most efficient level of production possible **under current conditions**.

Two words carry the weight. *Document* — it is written down, so it can be taught, followed, checked and improved. *Current* — it is the best method known today, and it is expected to be overtaken.

What it is not: an SOP, a work instruction, or a job description. A work instruction lists the steps of a task. Standardized work additionally answers whether the process can meet demand at all, how human time and machine time fit together, and where the standard material must sit for the cycle to repeat. That is why one form cannot carry it.

## The three elements

| Element | What it is | The test it must pass |
|---|---|---|
| Takt time | The required pace, from customer demand: available production time divided by required quantity | Is the line designed to a pace taken from demand, or from habit? |
| Work sequence | The order in which one operator performs the work to complete a cycle | Is the sequence the operator's real one (including walking and machine waits), not only the order the part travels? |
| Standard work-in-process (SWIP) | The minimum material that must sit in specific places for the sequence to repeat without interruption | Is each quantity the amount the cycle needs, or just inventory that happens to be near the job? |

Standardized work cannot exist if any one of the three is missing, and the reason is structural: takt without a sequence is a target with no method; a sequence without SWIP starves at the first variation; SWIP without takt is stock with no purpose. The presence of takt — every cycle tied to demand — is what distinguishes standardized work from a general work instruction.

## Takt is a design constraint, not a metric

Takt time is calculated up front and designed around; it is not something measured after the fact and reported. When demand changes, takt changes, and the work is restructured: the line is rebalanced, or people are added or removed. The rule from Toyota's own texts is explicit — changes in takt are never absorbed by changing how hard each individual operator works.

Practical consequences worth holding:

- **Available time is not shift length.** Breaks, meals and planned non-production time come out first. Using the shift length instead of the available time is the most common arithmetic error in the whole calculation, and it makes the line look roomier than it is.
- **The number is dynamic.** In Toyota's own operation takt changed with the sales picture and the rolling production plan, was communicated in advance, and the plants had a fixed window to rebalance, reassign people and revise the charts. The number was never a figure on a wall; it was a monthly signal that propagated through planning, line design, labour allocation and the standards.
- **It is native to countable, repeating work.** Assembly, machining, repetitive production of distinct units: yes. A job shop with high variety and no repeating cycle, or a continuous process measured by volume or weight: the concept still applies but needs translating, and forcing a takt where the mix does not repeat is a standard mistake.

## The three forms, in order

Each form answers a different question, and the order is the logic.

1. **Process Capacity Sheet — can the process do what we need?** Manual time, automatic machine time, tool-change frequency and resulting capacity, step by step. It tells you where the constraint is: which cycle is long, where tool changing eats capacity, whether the bottleneck is a machine, a manual element, or quality and availability hiding under the timing. If the process cannot meet takt, no chart drawn afterwards will fix it.
2. **Standardized Work Combination Table — how do human time and machine time fit together?** Manual work, automatic run time, walking and waiting laid on a timeline against takt. It separates what the person does from what the machine does, and it makes waiting visible. The classic one-operator-one-machine arrangement looks normal until this form is drawn — then the wait jumps out, along with the question of whether the operator could run a second process during the machine time.
3. **Standardized Work Chart — what is the current method?** Layout, work sequence, walking and return path, SWIP, safety and quality points, takt and cycle time, on one sheet posted at the job. This is the form everyone recognises and the one most often copied without the thinking behind it.

## Why the order matters

Starting with the chart and skipping the first two produces the failure mode the literature calls lean wallpaper: a posted artifact that satisfies an audit and helps nobody see or improve the work. The three forms are a logic trail, and each one earns the next:

- capacity, before anyone draws a sequence;
- the human/machine timeline, before anyone posts a chart;
- the chart, as the visible expression of a method that has been studied.

## What to check on the floor

- Is there a takt number, and can the person who owns the line say where it came from? A takt nobody can derive is decoration.
- Does the chart show the operator's walking and waiting, or only the part's route? A chart without the walk is a process flow diagram with a job title on it.
- Is SWIP marked where it actually sits, or is "some stock near the machine" accepted as SWIP?
- Is the chart dated and is the last change attributable to a named improvement? A standard that has not changed in a long time is either excellent or unread; the improvement record is what separates the two.
- Did the sequence come from watching the job, or from the specification? The chart is a record of the current best method, not of the intended one.

## Where it does not reach

- Standardized work sets the method; it does not teach it. Teaching the method to a person is a separate craft — see [Job Instruction, the four steps](/notes/demo-job-instruction-the-four-steps).
- In a job shop or a highly mixed line, a single takt number does not describe the real constraint. Say so instead of posting a number that half the products violate.
