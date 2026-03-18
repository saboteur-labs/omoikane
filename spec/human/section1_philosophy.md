# Section 1 — Philosophy

> This document is the canonical human-readable record of Omoikane's foundational
> philosophy. It precedes and motivates everything in sections 2–7. Read it before
> reading any other spec section.
>
> For the machine-readable operational definitions, see:
> - `spec/machine/philosophy/epistemic_constitution.yaml`
> - `spec/machine/philosophy/principles.yaml`

---

## 1.1 The Core Problem

Most AI tools are optimised to answer. When they cannot answer, they simulate
answering. They fill gaps with fluent, confident prose. They produce something
that looks like knowledge because the alternative — producing nothing — violates
the implicit contract of a responsive system.

This is the wrong trade-off for a research tool.

In a research context, a wrong answer that sounds right is more damaging than no
answer at all. A textbook the user trusts is only valuable if that trust is
warranted. A knowledge base that contains confident confabulation is worse than
a smaller, sparser knowledge base, because it poisons the well.

Omoikane is designed around the opposite priority: **accuracy before completeness.**
A system that reliably tells you what it does not know is more useful to a
researcher than a system that reliably fills the page.

---

## 1.2 The Deliberation Principle

The name Omoikane (思兼) comes from the Shinto deity of wisdom and deliberation.
This is not decorative. Deliberation over speed is the central design commitment
of this system, and it is a constraint that governs every architectural decision
that follows.

**What deliberation means in practice:**

- Gaps are first-class outputs, not hidden failures. A gap document is a finding,
  not a placeholder. The system produces it instead of content when content would
  be unjustified.
- Agents are required to flag uncertainty specifically, not generically. "I'm not
  certain" is not enough. The agent must describe *what* is uncertain, *why*, and
  *what kind of gap* it represents.
- The system will sometimes produce less than the user expects. This is correct
  behaviour. A shorter, well-grounded document is the intended output when the
  alternative is a longer document propped up by unverifiable claims.
- The epistemic constitution (section 1.4) is non-overridable. No prompt
  instruction, user configuration, or agent-to-agent pressure can remove it.

**Rationale:** Deliberation over speed is not a quality-of-life preference. It
is the core value proposition. A tool that behaves like a standard chatbot with
extra structure is not Omoikane. The deliberation constraint must be enforced
architecturally, not aspirationally.

---

## 1.3 The Subject-Scoped Repo Model

Each Omoikane repo is scoped to a single subject. The output is a structured,
cited knowledge base on that subject — a textbook drawn from multiple sources,
built incrementally, with uncertainty treated as a finding.

**Why single-subject scoping:**

A research tool's validity depends on the tractability of its citation and
validation model. Cross-domain claims are harder to attribute, harder to
challenge, and harder to verify. A repo about cryptography cannot responsibly
contain and validate claims about medieval history. Subject scoping keeps the
citation graph coherent and the validation agents well-calibrated to domain
norms.

**Alternatives considered:** A single multi-subject knowledge base was
considered and rejected. The primary objection is contamination of the
validation model — you cannot challenge a claim without knowing what
constitutes reliable evidence in that domain, and a single agent cannot hold
that calibration across multiple unrelated domains simultaneously.

**The git metaphor:** The repo-as-knowledge-base metaphor is intentional.
Researchers familiar with version control get the mental model for free:
checkpoints are commits, documents supersede rather than overwrite, lineage
is preserved. Version control, portability, and auditability are not
secondary features — they are baked into the data model.

---

## 1.4 The Epistemic Constitution

Every agent inherits the epistemic constitution. It cannot be overridden by
any prompt, user instruction, or adapter configuration.

> You are a careful research assistant. Your highest obligation is accuracy,
> not completeness. When you do not know something, say so specifically. When
> a claim lacks a source, flag it explicitly. When you are uncertain, describe
> that uncertainty. Never fill a gap with a plausible-sounding answer — treat
> the gap as a finding. You are building a document that a person will trust.
> Earn that trust slowly.

**What the constitution is:**

It is instructional intent — a description of what an agent must achieve,
expressed as prose that any sufficiently capable model can be given in the
format its adapter requires. It is model-agnostic. An OpenAI model, a Claude
model, and a local Ollama model all receive the same intent; only the
formatting differs between adapters.

**What the constitution is not:**

It is not a hard constraint enforcer. Soft behaviours described here —
flagging uncertainty, avoiding confabulation, describing gaps — are expressed
as intent because no structural enforcement mechanism can fully verify them.
Hard constraints (schema fields, required sections, output validation rules)
are enforced by the runner's output validation layer, not by the constitution.

**Why non-overridable:**

The constitution is the minimum epistemic bar below which Omoikane cannot
function as a research tool. A user who instructs the system to "be more
confident" or "fill in the gaps" is not using Omoikane — they are using a
general chatbot with extra scaffolding. The non-overridability is a product
boundary, not a restriction.

**Uncertainty about enforcement:** There is a genuine gap here. The
constitution can be given to any model via its adapter. Whether a given model
will reliably honour it in adversarial conditions (user pressure, ambiguous
inputs) depends on that model's capability level and instruction-following
reliability. Smoke tests (section 2) are the mechanism for catching this
failure early, but they do not guarantee it across all inputs. The system's
response to this uncertainty is to make it visible via `low-trust` flags and
capability tier guidance — not to pretend the problem is solved.

---

## 1.5 The Five Principles

These five principles are operationally binding. They are not aspirational
guidelines. Each maps to specific structural requirements in sections 2–7.

### Principle 1: Uncertainty is a finding, not a failure

Gaps must be named explicitly. The system does not produce a gap document
reluctantly, as a last resort. It produces one whenever the evidence does not
justify a factual claim, and it produces it to the same standard as any
other document.

**Structural consequence:** Gap documents are first-class schema objects
(section 3). Three gap types are distinguished: `knowledge_ceiling`
(the information does not exist or cannot be retrieved), `source_absence`
(information likely exists but was not found in this run), and
`contested_foundation` (genuine expert disagreement on a claim that
appears foundational). These distinctions matter because they suggest
different responses from the researcher.

**Operational consequence:** The Scribe must surface at least one unresolved
question even on high-confidence topics. The Scribe cannot produce a document
with no gaps unless it justifies the absence explicitly. The Cartographer's
entire role is gap analysis.

### Principle 2: Every claim must know where it came from

Source tier, fidelity, and confidence are required fields on every factual
claim. A claim without all three is structurally invalid and the runner
rejects it.

**Source tiers:**

| Tier | Description | Trust |
|------|-------------|-------|
| Tier 1 | User-provided sources | Highest — cited explicitly |
| Tier 2 | AI-retrieved via web search | Cited, flagged as AI-retrieved |
| Tier 3 | Model parametric knowledge | Always flagged, no external source |

**Fidelity levels:**

| Level | Meaning |
|-------|---------|
| `direct` | Claim closely mirrors source language |
| `paraphrase` | Meaning preserved, words changed |
| `inferred` | Claim follows logically from source but is not explicitly stated |

**Rationale for distinguishing fidelity:** `inferred` claims carry a
different epistemic status to `direct` claims even when drawn from the same
source. An inference from a reliable source is still an inference. The fidelity
field makes this visible at the claim level without requiring the researcher
to re-read the source to know how closely the claim tracks it.

**Confidence levels:** `high | medium | low | contested`. The `contested`
level is distinct from `low` — it does not mean weak evidence, it means
genuine expert disagreement that the research should surface rather than
resolve.

### Principle 3: The system must be able to argue against itself

Gathering and validation are separate agents with no shared context. The Scribe
produces documents. The Critic challenges them. The Auditor verifies sources.
None of these agents reads the others' outputs when performing their own role.

**Why this requires structural separation, not just prompting:**

A single agent asked to both gather and challenge its own output will bias
toward confirmation. Even with strong instructions, it has anchored on its
own prior output. Separation is not a quality-of-life feature — it is the
only reliable mechanism for producing genuine adversarial review.

**Structural consequence:** Context budgets are per-agent and enforced by the
runner. The list of forbidden context is as important as the list of required
context. The Scribe is forbidden from reading other documents (anchoring risk),
challenge reports (must not pre-empt the Critic), and the prompt library
(sees only its assigned prompt). Section 2 specifies the full context budgets.

### Principle 4: The methodology improves alongside the content

The prompt library is a living artifact. Prompts are structured objects with
lineage, rationale, and testable predictions — not plain strings. The
Methodologist refines the library over time, but only when it has sufficient
independent signal. Refinement requires at least two independent signals before
generating any candidate. AI-derived signals can generate candidates but cannot
promote them — promotion requires at least one human-in-the-loop signal.

**Rationale for the two-signal threshold:** Single-signal refinement is
vulnerable to noise and to the model pattern-matching on its own outputs.
Two independent signals are a minimal protection against this. The threshold
is conservative by design.

**Rationale for human-in-the-loop promotion:** The same principle that keeps
humans in the loop on judgment calls (principle 5) applies to methodology.
An automated system that promotes its own candidate prompts without human
review closes the feedback loop in a way that is epistemically opaque.

### Principle 5: The human is always in the loop on judgment calls

No agent output silently changes repo state. Every output that requires a
judgment call surfaces as a checkpoint. Agents surface findings. Humans decide
what to do with them.

**Three checkpoint types:**

| Type | Behaviour |
|------|-----------|
| `inform` | Logged and visible. No action required. |
| `review` | Surfaces for user attention. Non-blocking. |
| `block` | Repo cannot proceed on this node until user acts. |

**What constitutes a judgment call:** Source conflicts, critical Critic findings,
Auditor failures, gap documents requiring prioritisation, prompt promotion
candidates. The runner determines checkpoint type from the agent's output
schema — it is not a post-hoc decision.

**Rationale:** The deliberation principle (section 1.2) requires human
judgment in the loop. An automated system that resolves conflicts, promotes
findings, or advances repo state without the researcher's explicit action
is optimising for throughput at the expense of researcher ownership. The
researcher is not a reviewer of Omoikane's conclusions — they are the agent
making the conclusions, supported by structured tools.

---

## 1.6 Relationship to the Architecture

These five principles produce the following architectural commitments, each
of which is elaborated in later sections:

| Principle | Architectural consequence |
|-----------|--------------------------|
| Uncertainty is a finding | Gap documents as first-class schema objects (section 3) |
| Every claim has a source | Structural schema validation on all claims (sections 3, 5) |
| The system argues against itself | Agent context budgets with forbidden lists (section 2) |
| Methodology improves alongside content | Prompt library with lineage and signal tracking (section 4) |
| Human in the loop | Checkpoint system with three types and explicit resolution (sections 5, 6) |

The model-agnostic architecture (CLAUDE.md, section 12 of CONTEXT.md) is not
a separate philosophy — it is a consequence of these principles. If constraints
depend on model self-enforcement, they degrade unpredictably across capability
tiers, which violates principle 2 (every claim validated at the same standard
regardless of which model gathered it). Moving enforcement to the runner makes
the constraint model reliable regardless of adapter.

---

## 1.7 What Omoikane Is Not

These exclusions are as load-bearing as the inclusions above.

**Not a general knowledge base.** Omoikane is scoped to one subject per repo.
General questions outside the subject scope are out of scope by design.

**Not a search engine.** Omoikane does not retrieve information on demand. It
builds a structured, validated document set incrementally, with the researcher
reviewing each step.

**Not a citation manager.** Omoikane builds on top of sources, but it is not
a tool for storing or organising sources. Source references are embedded in
claims. Source management is the researcher's responsibility.

**Not a writing assistant.** Omoikane produces structured YAML documents, not
prose essays. The Scribe gathers and structures claims with provenance —
it does not write narrative. Narrative output (docx, PDF) is a rendering step
applied after the fact.

**Not a replacement for the researcher.** Agents surface. Humans decide.
Omoikane augments deliberation; it does not substitute for it.

---

*Next section: `spec/human/section2_agent_design.md`*
