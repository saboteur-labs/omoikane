# Section 4 — Prompt Library and Self-Improvement

> This section specifies how the prompt library works: the generation model,
> the candidate/active/deprecated lifecycle, the signal system, and the five
> pressure-tested problems that shaped the design.
>
> The prompt entry schema (fields and validation rules) is in
> `spec/machine/schema/prompt_entry.yaml`. This section covers the operational
> rules: how prompts evolve, how signals are collected, and how the runner
> governs the library's lifecycle.
>
> Machine-readable operational rules: `spec/machine/prompt_library/lifecycle.yaml`

---

## 4.1 What the Prompt Library Is

The prompt library is a set of structured prompt objects — not a list of
plain strings. Each entry carries the prompt text, a lineage pointer
(what it evolved from), a rationale (why this framing), performance data
from previous runs, and optionally a testable prediction of what better
results would look like if the prompt works.

The library is a living artifact. It starts at generation 1 with bootstrap
prompts written by the system or the researcher. Over time, the Methodologist
proposes refined candidates based on accumulated signal. Researchers promote
candidates they judge to be improvements. The library records the full
evolutionary history — not just the current active prompt for each role, but
every prior version and its lineage.

**Why structured objects rather than strings:** A plain prompt string cannot
carry a hypothesis about why it is better than its predecessor. Without that
hypothesis — and without checking it — refinement becomes an uninspected
black box. The structured format makes the refinement logic auditable.

**Why lineage is preserved:** The history of what was tried and why is itself
knowledge. A researcher who wants to understand why the current prompt looks
the way it does should be able to read its full ancestry. A researcher who
wants to try a different direction should be able to fork from any earlier
generation, not just the current tip.

---

## 4.2 The Generation Model

Prompts evolve through generations. Generation 1 prompts are naive bootstraps
— minimal instructions that establish the outline of what a gather (or
challenge, or verify) run should do. Generation N prompts reflect accumulated
research practice on this repo: they encode lessons from corrections,
challenge findings, and prediction outcomes.

**The generation counter** is an integer. It is comparable and sortable.
Prompts with higher generation numbers represent more cycles of refinement.
The Methodologist uses generation count as one signal when evaluating lineage
health — a lineage that has accumulated many generations without improvements
confirmed by prediction checks is a candidate for meta-refine review.

**Forking:** Prompts can fork. A single parent prompt can produce two child
candidates pursuing different directions. The library is therefore a tree,
not a chain. Forking is the response to genuine uncertainty about which
direction improvement lies — rather than committing to one approach, the
library explores both and lets signal determine which branch to continue.

**Rationale for forking over linear evolution:** Without forking, a long
lineage that has drifted in the wrong direction must be corrected by walking
backwards — deprecating several generations and restarting from an earlier
ancestor. Forking allows the library to hedge at a decision point and then
prune based on evidence. It is a structurally cheaper mechanism for handling
genuine uncertainty about refinement direction.

---

## 4.3 The Candidate / Active / Deprecated Lifecycle

Every prompt is in one of three states: `active`, `candidate`, or `deprecated`.

**`active`** — Approved for use by the relevant agent. The Scribe uses the
active `gather` prompt assigned to its run. There can be multiple active
prompts of the same type if they target different outline nodes.

**`candidate`** — Proposed by the Methodologist. Not yet approved. The
researcher has not acted on it. Candidate prompts exist in the library but
are not used in gather runs until promoted. Candidates are visible via
`omoikane review` and can be inspected, compared to their parent, and tested
via `omoikane prompt diff <parent-id> <candidate-id>`.

**`deprecated`** — Was once active, has been superseded. Retained in the
library for lineage purposes. A deprecated prompt records a `deprecation_reason`
so the library's evolutionary reasoning is not lost. Deprecated prompts are
never deleted.

**Transition rules:**

```
(new)      → candidate    Methodologist produces it
candidate  → active       Researcher promotes via omoikane prompt promote
candidate  → deprecated   Researcher rejects via omoikane prompt reject
active     → deprecated   Researcher deprecates; requires a replacement active prompt
```

No agent can directly set a prompt to `active`. The runner enforces this by
rejecting any Methodologist output that contains a prompt with `status: active`
(validated by rule MET-OV5 in `methodologist.yaml`). Promotion is a
human-in-the-loop action by design — see principle 5.

**Rejected candidates** are archived as `deprecated` with a rejection reason,
not deleted. This is not sentimentality: a rejected candidate that later turns
out to have been the right direction is visible in the lineage history. If the
researcher or Methodologist wants to revisit it, the reasoning is preserved.

---

## 4.4 The Signal System

The Methodologist generates candidates based on accumulated signal. Signal
is the evidence that the current prompt is underperforming — or performing
well — on this subject.

### Signal types

| Type | Source | Weight |
|------|--------|--------|
| `user_correction` | Researcher corrects a claim via `omoikane claim correct` | Human-in-the-loop |
| `challenge_acceptance` | Researcher accepts a Critic finding | Human-in-the-loop |
| `user_rating` | Researcher rates a document via `omoikane prompt rate` | Human-in-the-loop |
| `confidence_delta` | Runner-computed change in document confidence vs. repo baseline | AI-derived |
| `self_critique` | Scribe's `unresolved_questions` and `confidence_floor` | AI-derived |

**Human-in-the-loop signals** can generate candidates and promote them.
**AI-derived signals** can generate candidates but cannot promote them. A
candidate backed only by AI-derived signal requires at least one
human-in-the-loop signal before promotion is permitted.

### The two-signal threshold

The Methodologist must have at least two independent signals before generating
any candidate. "Independent" means from distinct events — a single document
that generated three AI-derived signals from the same run counts as one signal
event, not three.

**Rationale for two rather than one:** Single-signal refinement is vulnerable
to noise. A correction on one unusual document may not reflect a general
pattern. Two independent signals — especially if they are from different signal
types — are a stronger basis for a hypothesis about what the prompt is doing
wrong. The threshold is conservative by design. Refinement is not meant to be
fast; it is meant to be grounded.

**Rationale for not requiring three or more:** The two-signal rule is already
a friction point. More friction would discourage the Methodologist from
generating useful candidates on repos with limited signal history. The
researcher provides the final judgment at promotion time; the two-signal rule
is a floor, not a guarantee of quality.

### Signal aggregator

The signal aggregator is a runner component (section 5) that watches for
signal events and maintains a count of independent signals per prompt. It
populates the `performance` fields in prompt entries after each run and
records signal events in the signal history of the relevant document.

The Methodologist reads the signal history as part of its required context.
It does not call the signal aggregator directly — the aggregator's output
is pre-baked into the signal_history fields the Methodologist receives.

---

## 4.5 Ceiling Detection

Before generating any candidate, the Methodologist must run ceiling detection.
The question ceiling detection asks is: **is the problem a poorly-framed
prompt, or is it a genuine knowledge gap that no prompt can resolve?**

If the answer is a knowledge gap, the correct output is a gap document, not
a refined prompt. Generating a new prompt framing for a knowledge ceiling is
wasteful and misleading — it implies that the gap can be closed with a better
question when it cannot.

**How ceiling detection works:** The Methodologist reviews the repo's gap
documents and the pattern of `unresolved_questions` in Scribe self-critiques.
If the evidence suggests the same question has been attempted multiple times
and failed consistently, regardless of prompt framing, that is a ceiling
indicator. The Methodologist outputs the ceiling_gap IDs in its report
rather than generating candidates for those topics.

**The structural enforcement:** The `ceiling_check_performed` field is required
and must be `true` on every refinement report. A refinement report that
generates candidates without having run ceiling detection fails runner
validation (rule MET-OV1 in `methodologist.yaml`).

**Limitation:** The Methodologist cannot always reliably distinguish a framing
failure from a knowledge ceiling, especially at low signal counts. The ceiling
detection step surfaces the question explicitly — the researcher can then
inspect the evidence and decide. This is an instance of principle 5: the
Methodologist surfaces, the researcher decides.

---

## 4.6 Five Pressure-Tested Problems

These problems were identified and resolved during the design of the prompt
library. They are documented here because each led to a structural decision
that would otherwise appear arbitrary.

### 4.6.1 Signal quality

**Problem:** The Methodologist needs honest signal to generate useful
candidates. But signal is noisy — a single poor document might reflect
an unusual input, not a prompt failure; a correction might reflect the
researcher's changing views, not a consistent prompt weakness.

**Resolution:** Require at least one human-in-the-loop signal before
promoting any candidate. AI-derived signals (confidence delta, self-critique)
can reach the two-signal threshold for candidate *generation* — but promotion
always requires a human signal in the mix.

**Structural consequence:** The runner's promotion path checks the signal
composition before allowing promotion. If all signals for a candidate are
AI-derived, the promote command is blocked with an explanation.

### 4.6.2 Framing failure vs. knowledge ceiling

**Problem:** If a gather run consistently produces low-confidence, poorly-
sourced documents on a topic, the Methodologist cannot directly observe
whether the prompt is badly framed or the information does not exist.
Generating a new prompt candidate for a knowledge ceiling is worse than
useless — it consumes a refine cycle and produces false hope.

**Resolution:** Mandatory ceiling detection before generating candidates
(see section 4.5). If the Methodologist detects a ceiling, it outputs a
gap document rather than a candidate.

**Structural consequence:** `ceiling_check_performed` is a required boolean
in every refinement report, enforced by runner output validation.

### 4.6.3 Lineage drift

**Problem:** A long prompt lineage that has made a series of small, plausible
improvements may have drifted away from the original intent without any single
step being obviously wrong. By generation 8, a gather prompt might be asking
a meaningfully different question from generation 1, with each step having
a locally reasonable rationale.

**Resolution:** Periodic meta-refine reviews — the Methodologist is expected
to review long lineages for drift and may fork from an earlier ancestor rather
than continuing the current tip. Forking is the structural mechanism that
makes this practical.

**Genuine uncertainty here:** The spec does not define a generation length
at which meta-refine review is triggered. This is a gap — it depends on repo
size, domain, and signal density in ways that are hard to specify in advance.
The current design surfaces long lineages as a Cartographer-detectable signal
but does not hard-code a trigger threshold. This may need to be revisited
once real repos provide data.

### 4.6.4 Post-hoc rationalisation

**Problem:** The rationale for a prompt candidate is written by the same model
that produced the candidate. The model may be rationalising a choice it made
for other reasons, producing a rationale that *sounds* convincing but is not
actually predictive. If the rationale is only evaluated qualitatively, this
is hard to detect.

**Resolution:** Rationales must include testable predictions. The prediction
specifies what better results would look like if the rationale is correct.
Predictions are checked against actual gather output. Rationales that
repeatedly make incorrect predictions are flagged; prompts backed by
systematically wrong predictions are demoted.

**Structural consequence:** The `prediction` field is required for all
refine-generated prompts (rule PRM-VR1 in `prompt_entry.yaml`). The
`prediction_outcome` field records whether the prediction was confirmed or
refuted. The Methodologist must review prediction outcomes before generating
new candidates (rule MET-OV2 in `methodologist.yaml`).

### 4.6.5 Schema drift

**Problem:** A prompt that evolves significantly from its ancestor may
produce documents with a different shape, emphasis, or source tier mix.
Documents gathered at generation 1 may not be comparable to documents
gathered at generation 8. If a researcher compares a generation-1 document
to a generation-8 document, they may be comparing methodologically
incomparable outputs.

**Resolution:** Documents record exactly which prompt ID and generation
produced them (`provenance.prompt_id` and `provenance.prompt_generation`).
When a significant prompt refinement is promoted, the runner flags older
documents on the same outline node as staleness candidates. Significant
refinement is defined as a generation-N promotion where N > parent.generation + 1
(i.e. a non-incremental jump) or where the Methodologist explicitly flags
the candidate as a significant directional change.

**Structural consequence:** The `staleness_flag` field on document blocks
is set by the runner on promotion events. A stale document surfaces as a
`review` checkpoint in `omoikane status`.

---

## 4.7 The Refinement Cycle

The full refinement cycle, for reference:

```
1. Run gather on a node (Scribe)
2. Signal accumulates: corrections, ratings, challenge acceptances
3. Methodologist runs refine when >= 2 independent signals exist
4. Methodologist performs ceiling detection and prediction outcome review
5. Methodologist produces candidate(s) with predictions
6. Runner creates review checkpoints for each candidate
7. Researcher inspects candidates via omoikane review and omoikane prompt diff
8. Researcher promotes or rejects each candidate
9. On promotion: active prompt is deprecated; candidate becomes active;
   older documents on the same node are assessed for staleness
10. Cycle repeats
```

Steps 3–5 are agent actions. Steps 7–8 are researcher actions. Steps 1–2
and 9 are runner actions. No step is automated end-to-end.

---

## 4.8 Bootstrap Prompts

At `omoikane repo init`, the runner creates a set of generation-1 bootstrap
prompts — one for each command type the configured agents will run. These are
minimal, deliberately naive prompts. They are the starting point for the
library, not the intended endpoint.

**Bootstrap prompt content:** A bootstrap gather prompt does little more than
identify the outline node, instruct the Scribe to gather content for it, and
reference the epistemic constitution. It does not encode domain-specific
framing, source preferences, or coverage priorities. Those are learned through
the refinement cycle.

**Rationale for deliberately naive bootstraps:** Starting with a sophisticated
prompt risks encoding assumptions about the subject that the researcher has
not validated. A naive bootstrap makes the starting point explicit and the
improvements measurable. A researcher who imports a prompt library from
another repo starts from that library's generation level — not from bootstrap.

---

*Next section: `spec/human/section5_cli_architecture.md`*
