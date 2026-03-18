# Section 2 — Agent Design

> This section specifies the six agents: their roles, stances, context budgets,
> hard constraints, output schemas, and smoke tests. For the underlying philosophy
> that motivates these design choices, read section 1 first.
>
> Machine-readable definitions: `spec/machine/agents/`

---

## 2.1 Design Principles

### Specialised roles, not modes

The six agents are not modes of a single system. They are distinct roles
with fixed stances, defined context budgets, and structurally separate
execution. A single agent asked to both gather and challenge its own output
would bias toward confirmation — it has anchored on its own prior work. Role
separation is not an organisational convenience; it is the only reliable
mechanism for producing genuine adversarial review.

**Rationale for rejecting a single-agent, multi-mode design:** A gather agent
that just ran a challenge pass would enter the next gather biased toward
scepticism. A challenge agent given access to the gather agent's self-critique
would anchor on it rather than forming an independent view. These cross-context
contamination effects cannot be reliably suppressed by prompt instructions —
they must be prevented structurally by enforcing context budgets at the runner
level.

### The repo as the only communication channel

Agents never communicate directly with each other. All inter-agent communication
is mediated by the repo — written to YAML, versioned, human-readable. Every
write operation produces a checkpoint of the appropriate type (inform / review /
block). This means:

- Every inter-agent signal is inspectable and reversible
- No agent can influence another's context outside the defined context budget
- The human can audit exactly what each agent was given and what it produced

### Context budgets are structural constraints

Each agent is instantiated with a defined context budget: required inputs,
optional inputs, and — critically — a forbidden list. The runner enforces the
forbidden list; it does not pass forbidden context regardless of what is
available in the repo.

The forbidden list is as important as the required list. It is how the system
prevents role contamination. Documenting what an agent must *not* see is a
first-class design responsibility.

### Hard constraints are enforced by the runner, not by the model

This is the direct consequence of model-agnosticism (CLAUDE.md, §Model-Agnostic
Agent Architecture). If a hard constraint is expressed only as a prompt
instruction, it degrades unpredictably with weaker models. Every hard constraint
in this section is expressed as an `output_validation` rule that the runner
checks mechanically before accepting any output.

Some hard constraints are enforced through schema requirements (a field is
required, so its absence fails validation). Others are enforced through value
rules (an array must have a minimum length, a field must be non-empty, a count
must match an array's actual length). These rules are defined in each agent's
YAML. Prompt-level instructions reinforce them, but do not replace them.

---

## 2.2 The Six Agents

### 2.2.1 Architect

**Phase:** 1
**Commands:** `init`, `outline`
**Stance:** Inquisitive and structured. Asks before it builds.
**Capability tier:** High — requires nuanced dialogue and structured output

The Architect runs twice in the research workflow: once at initialisation
(producing the learning brief) and once to produce the outline. Both runs
require deliberate front-loading of clarification before producing anything.

**`init` — the learning brief dialogue**

The Architect must ask clarifying questions before producing a learning brief.
The brief records: subject, goal, prior knowledge, priority angles, exclusions,
and the researcher's definition of done. These fields scope all future agent
runs. Without them, the outline is unanchored — the Scribe would not know
what depth of treatment is expected, the Critic would not know what counts
as adequate coverage, and the Cartographer would not know what gaps matter.

The hard constraint — clarifying questions must be asked — is enforced by
requiring a non-empty `questions_asked` array in the learning brief output.
An Architect that produces a learning brief without this field, or with an
empty array, fails output validation.

**`outline` — typed, steerable, revisable outline**

Every outline node must be typed. The type taxonomy is:
`factual | contested | definitional | methodological | edge_case | gap_placeholder`

The type is not cosmetic. It signals to the researcher what kind of treatment
to expect, and to the Critic what kind of challenge is appropriate for that
node's document.

**Hard constraint: gap placeholder nodes required.** The Architect must include
placeholder nodes for suspected gaps even when it cannot produce content for them.
An outline that presents a subject as fully mappable without any gap placeholders
is almost certainly wrong, and the constraint prevents the system from producing
a falsely confident outline.

**Hard constraint: cannot produce an outline with no contested or edge-case
nodes without explaining why.** Most subjects have contested areas. An outline
that contains only `factual` and `definitional` nodes either reflects a
deliberately narrow research scope (which must be justified) or reflects the
Architect failing to model the subject's contested regions. The
`justification_if_no_contested_nodes` field is required when no contested or
edge-case nodes appear. Its presence in the output schema enforces this
structurally.

---

### 2.2.2 Scribe

**Phase:** 1
**Commands:** `gather`
**Stance:** Curious and honest. Comfortable not knowing.
**Capability tier:** Mid — requires reliable instruction-following and multi-source reasoning

The Scribe gathers content for a single outline node per run. It produces a
document containing claim blocks, a self-critique, and optionally gap documents
and follow-up prompt candidates.

**Forbidden context:**
- Other documents in the repo (anchoring risk — the Scribe must not shape its
  output to match or diverge from prior documents)
- Challenge reports (the Scribe must not pre-empt the Critic)
- The prompt library beyond the single assigned prompt (the Scribe sees its
  assigned prompt only)

**Hard constraints:**

*Cannot produce a claim without source tier and fidelity.* These are required
fields in the claim schema. The runner rejects any claim block missing them.

*Cannot produce an empty or generic self-critique.* The `what_was_hard` and
`confidence_floor` fields are required and validated as non-empty. The runner
also checks that `unresolved_questions` has at least one entry — an empty array
fails validation even if the fields exist.

*Must surface at least one unresolved question even on high-confidence topics.*
Enforced by the minimum-length rule on `self_critique.unresolved_questions`.
The reasoning: a Scribe that reports no unresolved questions has either
found a topic with no genuine uncertainty (vanishingly rare) or has stopped
looking. The constraint ensures the uncertainty surface remains visible.

*If fewer than two tier-1/2 sources exist for a factual claim, must mark as
tier-3 and flag explicitly.* Enforced by requiring the `source.citation` field
only when tier is `tier_1` or `tier_2` — a tier-3 claim with a citation would
pass validation, but a tier-1/2 claim without a citation would not. The Scribe
is instructed that claims with insufficient external sourcing must be marked
tier-3. Whether a given model reliably does this is what the smoke test
adversarial case probes.

*Must never fill a gap with a plausible-sounding answer.* This is an epistemic
constitution behaviour (EC-D4). It cannot be fully enforced structurally, but
the smoke test adversarial case tests for it on a topic with a known knowledge
ceiling.

---

### 2.2.3 Critic

**Phase:** 2
**Commands:** `challenge`
**Stance:** Adversarial but constructive.
**Capability tier:** High — requires genuine adversarial reasoning

The Critic reads a document and challenges it. Its output is a challenge
report: a set of findings, each citing a specific claim, classifying the
error type, and rating severity.

**Forbidden context:**
- Other documents in the repo (must assess the document on its own terms)
- The Scribe's self-critique (must form an independent view — if the Critic
  reads the self-critique first, it will anchor on the Scribe's own uncertainty
  flags rather than independently identifying weaknesses)
- Source materials (the Critic assesses claims, not sources — source verification
  is the Auditor's role)

**Hard constraints:**

*Every finding must cite a specific claim ID.* Enforced by the required
`claim_id` field in the finding schema. A finding without a claim ID fails
validation. General complaints about a document that do not trace to a specific
claim are not findings — they are vague objections, and the runner rejects them.

*Must distinguish error types.* The `error_type` field is required and constrained
to the enumeration: `factual_error | overclaiming | source_mismatch | logical_gap
| missing_counterargument`. This matters because different error types require
different responses from the researcher.

*Must rate severity.* The `severity` field is required and constrained to
`critical | moderate | minor`. The `severity_summary` counts must match the
findings array. This is verified by the runner after parsing: it counts the
findings by severity and checks against the declared summary.

*Cannot return a clean report without explicitly justifying it.* When the
findings array is empty, the `clean_report_justification` field becomes required.
The runner checks for the presence of this field when findings is empty. The
constraint prevents the Critic from silently passing documents it did not
adequately challenge.

---

### 2.2.4 Auditor

**Phase:** 2
**Commands:** `verify`
**Stance:** Procedural and sceptical. No opinions — only traceability.
**Capability tier:** Low — local models viable; outputs are mechanically verifiable

The Auditor checks that sources actually support the claims that cite them.
It produces a verification report: one verdict per claim in the document.

**Note on capability tier:** The Auditor's task is procedural — attempt
retrieval, compare source text to claim text, record result. The outputs are
pass / flag / fail, not narrative judgments. This makes the Auditor the most
suitable role for a local or lower-capability model. The smoke test still runs.

**Hard constraints:**

*Must attempt retrieval of every tier-1/2 source.* Enforced by requiring a
`source_retrievable` field on all tier-1/2 claim verdicts. If retrieval is not
attempted, the field cannot be populated, and the runner catches the absence.

*Must check fidelity.* The `fidelity_check_result` field is required on every
verdict. The Auditor compares the claim's asserted content against the source
text and records whether the source actually says what the claim says.

*Flags dead links, paywalled sources, mismatched sources.* When
`source_retrievable` is false, the `retrieval_error` field is required and
constrained to the enumeration: `dead_link | paywalled | not_found`. This
allows the researcher to distinguish a source that does not exist from a source
that exists but is inaccessible.

*Cannot pass a claim it could not verify.* When `source_retrievable` is false,
the verdict must be `flag` or `fail` — not `pass`. The runner validates this
rule: a verdict of `pass` with `source_retrievable: false` fails validation.

---

### 2.2.5 Cartographer

**Phase:** 2
**Commands:** `gaps`
**Stance:** Panoramic. Looks at the whole repo.
**Capability tier:** Mid — requires coherent cross-document reasoning

The Cartographer analyses the entire repo and produces a gaps report:
gap documents (formal findings about what the repo does not know),
contradictions between documents, and a prioritised research queue.

**Context budget:** The Cartographer is the only agent whose required context
is the entire repo document set. This is deliberate — gap analysis requires
a panoramic view.

**Hard constraints:**

*Must distinguish retrieval failures from knowledge ceilings.* These are
different gap types with different researcher responses. A source absence
suggests trying different sources or search strategies. A knowledge ceiling
means the information does not exist or cannot be retrieved regardless of
approach. Conflating them produces misleading guidance. Enforced by the
required `nature` field with its constrained enumeration:
`knowledge_ceiling | source_absence | contested_foundation`.

*Must surface contradictions between documents.* The `contradictions` array
is required (though it may be empty). The hard constraint is structural: if
the runner receives a gaps report without a `contradictions` field, it fails
validation. Whether the Cartographer finds all contradictions is a capability
question; whether it looks is a structural one.

*Prioritisation must be explicit and reasoned.* The `prioritisation_rationale`
field is required and non-empty. This field must be present even if the
research queue is empty. It prevents implicit, unstated prioritisation.

*Cannot prioritise by ease of research.* This is a soft constraint — the runner
cannot verify what criteria the Cartographer used. The smoke test adversarial
case includes a research queue where the easiest-to-research item is clearly
lower value, and checks that the Cartographer does not rank it first. This
does not guarantee correct prioritisation across all inputs, but it surfaces
models that exhibit the most obvious form of this failure.

---

### 2.2.6 Methodologist

**Phase:** 3
**Commands:** `refine`
**Stance:** Reflective and conservative.
**Capability tier:** High — requires pattern recognition across signals

The Methodologist analyses signal history and produces prompt candidates.
It does not deploy candidates — it proposes them. Promotion is always a
human action.

**Hard constraints:**

*Must run ceiling detection before generating candidates.* If a gap reflects
a knowledge ceiling, the appropriate response is a gap document — not a refined
prompt. The `ceiling_check_performed` field is required and must be `true`. A
refinement report that produces candidates without ceiling detection violates
this constraint at validation time.

*Must review prediction outcomes before generating candidates.* The
`prediction_outcomes_reviewed` field is required and must be `true`. The
Methodologist must not generate new candidates without checking whether prior
predictions were correct — a methodology that ignores its own prediction record
is epistemically unsound.

*Requires at least two independent signals before generating any candidate.*
The `independent_signal_count` field is required. When its value is less than
2, the `candidates` array must be empty. The runner validates this: if
`independent_signal_count < 2` and `candidates` is non-empty, validation fails.

*Every candidate must include a testable prediction.* The `prediction` field
is required and non-empty in the prompt candidate schema.

*Every candidate must reference the specific signal that motivated it.* The
`motivating_signal_ref` field is required and non-empty. A candidate motivated
by "general pattern" fails validation. The field must reference a specific,
identifiable signal.

*Cannot promote its own candidates.* Promotion is a CLI action that requires
an explicit human command. The Methodologist's output type is always `candidate`
— the runner will not accept a refinement report containing a prompt with
`status: active`.

---

## 2.3 Capability Tiers

Not all models are suitable for all roles. The table below records the
minimum capability requirement for each role and the reasoning behind it.

| Role | Minimum tier | Rationale |
|------|-------------|-----------|
| Auditor | Low — local models viable | Procedural task; outputs are mechanically verifiable (pass/flag/fail) |
| Scribe | Mid | Requires reliable instruction-following and multi-source reasoning |
| Cartographer | Mid | Requires coherent cross-document reasoning |
| Critic | High | Requires genuine adversarial reasoning; a weak model produces superficial findings |
| Methodologist | High | Requires pattern recognition across heterogeneous signals |
| Architect | High | Requires nuanced dialogue and structured output before producing anything |

**What "local models viable" means for the Auditor:** Source retrieval and
fidelity checking are procedural. The model receives a claim and a source
text and records whether they match. This is a comparison task, not a reasoning
task. A local model that can follow structured output instructions reliably is
sufficient. The smoke test will determine whether the configured model meets
the bar.

**Uncertainty about the tier boundaries:** The mid/high distinction in
particular is fuzzy. What counts as "genuine adversarial reasoning" for the
Critic is capability-dependent in ways that are hard to specify precisely.
The smoke test for the Critic includes an adversarial case designed to probe
this, but there is no guarantee that smoke test performance predicts production
performance across all document types. Users should treat the capability tier
as guidance, not as a guarantee.

---

## 2.4 Smoke Tests

Every agent role has a paired smoke test definition in
`spec/machine/agents/<role>_smoke_test.yaml`. A role cannot be trusted with
real repo data until its smoke test passes (CLAUDE.md, §Smoke Tests Are
Mandatory).

**What each smoke test verifies:**

1. **Connectivity** — the adapter can reach the configured model
2. **Structural compliance** — the model returns output in the required schema
3. **Output validation** — the model satisfies the role's `output_validation`
   rules on a synthetic input
4. **Epistemic constitution behaviour** — at least one adversarial case targeting
   the role's most likely failure mode

**The adversarial case requirement:** Each smoke test includes at least one case
designed to elicit the role's characteristic failure mode. For the Scribe, this
is confabulation — presenting a tier-3 claim as externally sourced. For the
Critic, this is a superficial or absent challenge on a document with visible
flaws. For the Methodologist, this is generating a candidate with fewer than
two signals. These cases do not exhaustively test the role, but they ensure the
configured model fails loudly on the most obvious failure before being trusted
with real data.

**Smoke test results** are stored in `.omoikane/smoke_tests.yaml` in each
knowledge repo with timestamps. Re-run with `omoikane agent test <role>`.

**If a smoke test fails:** The role is blocked. If the user overrides and
proceeds, all outputs from that role are flagged `low-trust` in document
provenance. The `low-trust` flag propagates — a document gathered by a
low-trust Scribe cannot reach `verified` status regardless of Auditor results.
Trust must be re-established at the source.

---

*Next section: `spec/human/section3_schema.md`*
