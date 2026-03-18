# CONTEXT.md — Omoikane Decision Log

This document is the full record of design decisions made during the initial
specification conversation. Every significant decision is recorded with its
rationale, the alternatives considered, and where genuine uncertainty remains.

This is a living document. As new decisions are made, they are appended here.

---

## Table of Contents

1. [Core Concept](#1-core-concept)
2. [The Deliberation Principle](#2-the-deliberation-principle)
3. [Prompt Design](#3-prompt-design)
4. [Agent Design](#4-agent-design)
5. [Schema Design](#5-schema-design)
6. [Prompt Library and Self-Improvement](#6-prompt-library-and-self-improvement)
7. [CLI Architecture](#7-cli-architecture)
8. [Persistence Model](#8-persistence-model)
9. [Collaboration Model](#9-collaboration-model)
10. [Build Phases](#10-build-phases)
11. [Format and Repository Conventions](#11-format-and-repository-conventions)
12. [Model-Agnostic Agent Architecture](#12-model-agnostic-agent-architecture)

---

## 1. Core Concept

**Decision:** Omoikane is a repository-backed, AI-augmented research tool.
Each repo is scoped to a single subject. The output is a structured, cited
knowledge base — a textbook built from multiple sources.

**Rationale:** Most AI tools optimise for fast, broad answers. Omoikane is
designed for the opposite: deep, slow, validated knowledge accumulation on
a specific domain. The repo-as-knowledge-base metaphor gives users version
control, portability, and a clear mental model.

**Key constraint:** Each repo is scoped to one focus. This prevents scope
creep and keeps the knowledge graph coherent.

**Alternatives considered:** A single multi-subject knowledge base. Rejected
because cross-domain contamination undermines the citation and validation
model — you cannot challenge or verify claims without a clear subject scope.

---

## 2. The Deliberation Principle

**Decision:** The central design commitment of Omoikane is deliberation over
speed. The system should surface well-described gaps rather than fill them
with plausible-sounding answers.

**Rationale:** In a research context, a wrong answer that sounds right is
more damaging than no answer at all. A textbook the user trusts is only
valuable if that trust is warranted. Omoikane inverts the usual AI priority
of responsiveness in favour of accuracy.

**Practical consequences:**

- Gaps are first-class outputs (gap documents), not hidden failures
- Agents are required to flag uncertainty specifically, not generically
- The system will sometimes produce less content than the user expects
- Every agent inherits a shared epistemic constitution that cannot be
  overridden by prompts or user instructions

**The epistemic constitution (verbatim):**

> You are a careful research assistant. Your highest obligation is accuracy,
> not completeness. When you do not know something, say so specifically. When
> a claim lacks a source, flag it explicitly. When you are uncertain, describe
> that uncertainty. Never fill a gap with a plausible-sounding answer — treat
> the gap as a finding. You are building a document that a person will trust.
> Earn that trust slowly.

**The five principles:**

1. Uncertainty is a finding, not a failure.
2. Every claim must know where it came from.
3. The system must be able to argue against itself.
4. The methodology improves alongside the content.
5. The human is always in the loop on judgment calls.

---

## 3. Prompt Design

**Decision:** The original three-prompt model (Outline, Gather, Verify) was
expanded into six named prompts corresponding to six agents, plus a prompt
library that the system can refine over time.

**Original model:** Outline → Gather → Verify

**Expanded model:**

- `init` — learning brief dialogue (Architect)
- `outline` — typed, steerable, revisable outline (Architect)
- `gather` — section-scoped, source-honest document production (Scribe)
- `challenge` — adversarial review (Critic) — replaces naive "verify"
- `verify` — source traceability audit (Auditor)
- `gaps` — cross-repo analysis, research queue (Cartographer)
- `refine` — prompt library improvement (Methodologist)

**Rationale for splitting verify into challenge + verify:**
"Verify" as originally conceived conflated two distinct epistemic acts:
checking whether claims are well-argued (challenge) and checking whether
sources actually support claims (verify). These require different stances
and should not be done by the same agent pass.

**Rationale for `init` producing a learning brief:**
The system should ask clarifying questions before producing anything.
The learning brief — goal, prior knowledge, priority angles, exclusions,
definition of done — scopes all future prompts. Without it, the outline
is unanchored.

**Key design constraint:** The outline must be user-approved before gather
runs. Gather runs are section-scoped — one outline node at a time. This
enforces deliberation by design.

---

## 4. Agent Design

**Decision:** Specialised agents with no direct communication. They
communicate only through the repo (shared structured state). Each agent
has a defined role, epistemic stance, context budget (required/optional/
forbidden), and hard constraints.

**Alternatives considered:**

- Single agent, many modes: rejected because cross-context contamination
  biases the agent toward confirming prior outputs. A gather agent that
  just ran challenge would be overly sceptical. Role separation enforces
  epistemic independence.

**The six agents:**

### Architect

- **Stance:** Inquisitive and structured. Asks before it builds.
- **Runs:** `init`, `outline`
- **Hard constraints:** Must ask clarifying questions before producing
  anything. Outline nodes must be typed. Must include placeholder nodes
  for suspected gaps. Cannot produce an outline with no contested or
  edge-case nodes without explaining why.

### Scribe

- **Stance:** Curious and honest. Comfortable not knowing.
- **Runs:** `gather`
- **Hard constraints:** Cannot produce a claim without source tier and
  fidelity. Cannot produce an empty or generic self-critique. Must surface
  at least one unresolved question even on high-confidence topics. If fewer
  than two tier-1/2 sources exist for a factual claim, must mark as tier-3
  and flag explicitly. Must never fill a gap with a plausible-sounding answer.
- **Forbidden context:** Other documents (anchoring risk), challenge reports
  (must not pre-empt the Critic), prompt library (sees only assigned prompt).

### Critic

- **Stance:** Adversarial but constructive.
- **Runs:** `challenge`
- **Hard constraints:** Must read every claim before writing any objection.
  Every objection must cite a specific claim ID. Must distinguish error types:
  factual error, overclaiming, source mismatch, logical gap, missing
  counterargument. Must rate severity: critical / moderate / minor. Cannot
  return a clean report without explicitly justifying it.
- **Forbidden context:** Other documents, Scribe's self-critique (must form
  independent view), source materials (assesses claims not sources).

### Auditor

- **Stance:** Procedural and sceptical. No opinions — only traceability.
- **Runs:** `verify`
- **Hard constraints:** Must attempt retrieval of every tier-1/2 source.
  Must check fidelity — does the source actually say what the claim claims?
  Flags dead links, paywalled sources, mismatched sources. Cannot pass a
  claim it could not verify — only pass / flag / fail.

### Cartographer

- **Stance:** Panoramic. Looks at the whole repo.
- **Runs:** `gaps`
- **Hard constraints:** Must distinguish retrieval failures from knowledge
  ceilings. Must surface contradictions between documents. Prioritisation
  must be explicit and reasoned. Cannot prioritise by ease of research.

### Methodologist

- **Stance:** Reflective and conservative.
- **Runs:** `refine`
- **Hard constraints:** Cannot promote its own candidates. Every candidate
  must include a testable prediction and reference the specific signal that
  motivated it. Must run ceiling detection before generating candidates.
  Must review prediction outcomes before generating new candidates. Requires
  at least two independent signals before generating any candidate.

**The repo as message bus:**
No agent-to-agent calls. All inter-agent communication is mediated by the
repo — logged, versioned, human-readable. Every write operation has a
defined checkpoint type (inform / review / block).

**Context budgets:**
Each agent is instantiated with a defined set of files it is allowed to
read. Forbidden lists are as important as required lists. They preserve
role integrity by design.

---

## 5. Schema Design

**Decision:** Three-layer schema plus gap documents as first-class outputs.

### Repo Manifest

Top-level file. Tracks: subject, learning brief, outline status/version,
all document references (with status and prompt provenance), prompt library
version, known gaps, open predictions.

### Document Block

Output of a single gather run. Contains:

- `provenance`: prompt ID, prompt generation, rationale ID, source tier mix, date
- `status`: current status, staleness flag, re-gather candidate flag
- `signal_history`: append-only log of corrections, challenge findings
- `content`: array of claim blocks
- `self_critique`: what was hard, confidence floor, unresolved questions
- `follow_up_prompts`: generated candidates

**Key constraint:** Documents are never deleted — superseded documents are
replaced and the lineage is kept via `supersedes` field.

### Claim Block

Atomic unit of knowledge. Fields:

- `type`: factual | contested | definitional | methodological | gap
- `content`: the assertion
- `source`: tier, citation, URL, quote basis, fidelity level
- `confidence`: level, basis, corroborating sources, contradicting sources
- `status`: active | corrected | retracted | disputed
- `challenge_findings`: references
- `user_notes`: open field
- `prediction_check`: was a refine prediction made about this claim?

**Fidelity levels:**

- `direct`: claim closely mirrors source language
- `paraphrase`: meaning preserved, words changed
- `inferred`: claim follows logically but is not explicitly stated in source

**Confidence levels:** high | medium | low | contested

### Gap Document

First-class output. Not a placeholder — a finding.

- `nature`: knowledge_ceiling | source_absence | contested_foundation
- `description`: what is known about the gap
- `partial_knowledge`: claim IDs for what is known at the edges
- `prompt_attempts`: prompts that tried and hit this ceiling
- `status`: open | externally_resolved | user_closed

**Rationale for gap documents as first-class:**
The deliberation principle requires that gaps be named explicitly. A gap
document is more useful than content that fills the same space with
low-confidence claims. The Cartographer produces and updates gap documents.
The Scribe can trigger gap document creation when ceiling detection fires.

---

## 6. Prompt Library and Self-Improvement

**Decision:** Prompts are structured objects with lineage, rationale, and
testable predictions — not plain strings. The repo maintains a prompt library
that the Methodologist refines over time.

**Prompt entry fields:**

- `id`, `type`, `target`, `status` (active | candidate | deprecated)
- `origin` (system | user | refine-generated)
- `generation` (integer — how many refine cycles produced this)
- `parent` (what it evolved from)
- `question` (the actual prompt text)
- `rationale` (why this framing — treated as hypothesis, not conclusion)
- `performance`: last_used, produced_sources, confidence_delta, user_rating
- Testable `prediction` (what better results would look like if this prompt works)

**The generation model:**
Prompts evolve through generations. Gen-1 prompts are naive bootstraps.
Gen-N prompts reflect accumulated research practice. Lineage is preserved —
you can see what a prompt evolved from and why.

**Prompt forking:**
Prompts can fork into two variants pursuing different directions. The library
is a tree, not a chain.

**Candidate vs. active:**
Refine generates candidates. Users promote them. Rejected candidates are
archived with rejection reason — not deleted.

**Key pressure-tested problems and resolutions:**

1. **Signal quality:** Refine needs honest signal but signal is noisy.
   Resolution: Require at least one human-in-the-loop signal (correction,
   rating, challenge acceptance) before promoting any candidate. AI-derived
   signals (self-critique, confidence delta) can generate candidates but not
   promote them.

2. **Framing failure vs. knowledge ceiling:** Refine cannot always distinguish
   a poorly-framed question from a genuine knowledge gap. Resolution: Ceiling
   detection step before generating candidates. If ceiling detected, output
   is a gap document, not a new prompt.

3. **Lineage drift:** Long prompt lineages may encode a series of small wrong
   turns. Resolution: Periodic meta-refine reviews long lineages. Prompts can
   fork rather than only evolving linearly.

4. **Post-hoc rationalisation:** Rationales are written by the same AI that
   produced the original output. Resolution: Rationales must include testable
   predictions. Predictions are checked against actual output. Rationales that
   repeatedly make wrong predictions are flagged, and their prompts demoted.

5. **Schema drift:** Prompts of different generations may produce documents
   with different shapes. Resolution: Documents record which prompt and
   generation produced them. Significant prompt refinements flag older
   documents as staleness candidates.

---

## 7. CLI Architecture

**Decision:** The CLI has two top-level namespaces (`repo` for repo management,
flat commands for the research workflow) and four internal components.

**Four internal components:**

1. **Runner** — receives commands, validates preconditions, instantiates agents
   with correct context budgets, executes, writes outputs.
2. **State manager** — owns the manifest, enforces all status transitions and
   sequencing rules. Nothing writes to the manifest except through it.
3. **Checkpoint registry** — tracks all open checkpoints. Every agent output
   requiring user action registers here.
4. **Signal aggregator** — watches for corrections, challenge acceptances,
   prediction outcomes. Maintains the two-signal threshold for refine.

**CLI design principles:**

- Opinionated about sequence, not about pace
- Surface state, never hide it
- Fail loudly and specifically (not "error" — but "cannot run X because Y")
- Scriptable: consistent output formats, explicit exit codes

**Phase 1 commands:**

```
omoikane repo init
omoikane status
omoikane outline
omoikane outline approve
omoikane outline amend <node-id>
omoikane gather <node-id>
omoikane gather --next
omoikane gather <node-id> --prompt <prompt-id>
omoikane review
omoikane resolve <item-id> --action <action>
omoikane claim correct <claim-id>
omoikane claim retract <claim-id>
```

**Later phase commands** (specced now, built later):

```
omoikane challenge <doc-id>
omoikane verify <doc-id>
omoikane gaps
omoikane refine
omoikane prompt show / diff / promote / fork / predictions
omoikane repo docs / gaps / prompts
omoikane spec render [section]   # generates docx from markdown
```

**`omoikane status` output format:**
Displays: repo name/subject, outline version and approval status, prompt
library version, last activity. Then: outline progress (per-node status
using ✓/⚠/·/⊘ symbols), open checkpoints (blocking and review, grouped),
research queue (from last gaps run).

---

## 8. Persistence Model

**Decision:** Hybrid YAML + SQLite model.

**YAML is the canonical source of truth.** Documents, gap files, reports,
and the prompt library are written as YAML. Human-readable, git-trackable,
diffable, always inspectable with a text editor.

**SQLite is the working index.** All queryable state lives in
`.omoikane/omoikane.db`. Built from YAML, not the other way around.
Used by the signal aggregator, checkpoint registry, and Cartographer for
cross-document queries.

**The database is always rebuildable:**
`omoikane repo reindex` rebuilds the SQLite index from YAML source files.
Run after pulling changes, resolving conflicts, or suspecting corruption.

**Rationale for hybrid over pure SQLite:**

- Pure SQLite breaks git-friendliness: binary diffs are meaningless, merge
  conflicts unresolvable, and the collaboration model requires git.
- Pure YAML is insufficient at scale: cross-document queries (signal
  aggregation, gaps analysis, checkpoint registry) are expensive full-
  directory scans with manual filtering. Refine's two-signal logic is
  naturally a SQL query.

**Rationale for hybrid over pure YAML:**

- The signal aggregator specifically needs relational queries.
- Atomic writes: a resolve action that updates claim status, logs to signal
  history, updates the checkpoint registry, and flags a document as stale
  should succeed or fail together. SQLite transactions handle this.

**External rendering layer reads YAML directly** — no database dependency
for consumers of Omoikane data.

---

## 9. Collaboration Model

**Decision:** Collaboration is in scope but deferred to phase 4. The hybrid
architecture preserves git-friendliness as a hard requirement, keeping all
collaboration options open.

**Three collaboration models identified:**

1. Shared repo — multiple researchers on one knowledge base
2. Forked repos — independent research that can be merged
3. Shared prompt library — methodology sharing without content sharing

**Recommended rollout sequence:**

- Phase 1: Repo portability (git-friendly by design — already handled)
- Phase 2: Shared prompt library (high value, low complexity)
- Phase 3: Forked repos (largely free given git-friendly structure)
- Phase 4: Shared repos (most complex — requires author fields, outline
  amendment flows, parallel gather recognition, divergent claim states)

**Key insight from collaboration analysis:**
Disagreement between researchers is a first-class finding, not noise to
resolve. The deliberation principle already handles this — the system treats
contradiction as signal. Collaboration means that signal can come from
humans, not just agents.

**Schema additions required for phase 4:**

- Author fields in signal history and claim blocks
- `contested-by-collaborators` as a distinct claim status
- Outline amendment proposal/approval flow
- Parallel gather recognition (two independent gathers on same node treated
  as replication attempt, not replacement)

---

## 10. Build Phases

**Decision:** Four phases, each delivering a complete and useful increment.

**Phase 1 — Core loop (MVP):**
Architect + Scribe, full claim schema, minimal checkpoint system, status
command, basic prompt library storage.
_Proves:_ A user can build a cited, structured knowledge document with
uncertainty explicitly flagged.

**Phase 2 — Validation layer:**
Critic + Auditor + Cartographer, full checkpoint system, gap documents,
signal history, review/resolve commands, source retrieval in Auditor.
_Proves:_ The deliberation principle has infrastructure. Bad claims get
caught. Gaps get named.

**Phase 3 — Self-improvement:**
Methodologist, signal aggregator, prompt candidates with predictions,
lineage and forking, staleness flags.
_Proves:_ The repo gets better at learning its own subject over time.

**Phase 4 — Collaboration:**
Author fields, shared prompt registry, fork/diff commands, outline amendment
flow, parallel gather recognition, divergent finding states.
_Proves:_ Omoikane is a platform, not just a personal tool.

**Hard constraint:** Phase 1 decisions must not foreclose phases 2–4. When
a phase 1 implementation decision is made, explicitly check that it is
compatible with the later phases it is deferring.

---

## 11. Format and Repository Conventions

**Decision:** Markdown is the canonical human-readable format. YAML is the
canonical machine-readable format. Docx and similar rendered formats are
build artifacts only — generated on demand, never edited directly, gitignored.

**Rationale:**

- Markdown is git-diffable, human-readable, and trivially renderable.
  It is the right format for prose that needs to be version-controlled.
- YAML is the natural format for structured agent configuration and schema
  definitions. It is readable without tooling.
- Docx is a publication format, not a source format. Binary blobs in git
  history produce meaningless diffs and unresolvable merge conflicts.
  A tool whose value proposition is auditability should not have opaque
  version history for its own specification.

**The sync rule:**
YAML is authoritative for behaviour. Markdown is authoritative for rationale.
When they conflict, YAML governs what the system does. A change to agent
behaviour requires updating both — the YAML to change the behaviour, the
markdown to update the rationale. This must be enforced in contributing
guidelines.

**Accepted tradeoff:**
Learning markdown is a minor barrier that is acceptable to keep in place.
Collaborators who need rendered documents generate them on demand via
`omoikane spec render`. Docx is not a contribution format.

**Commit conventions:**

- `spec: section N — <title>` for spec work
- `impl: <component>` for implementation work
- `fix: <description>` for corrections
- `refine: <prompt-id>` for prompt library updates

**Spec writing convention:**
Every section produces its `.md` and corresponding YAML files simultaneously.
Non-obvious decisions in the markdown include their rationale. Genuine
uncertainty is flagged explicitly. The spec does not present every decision
as settled — it follows its own epistemic standards.

---

## 12. Model-Agnostic Agent Architecture

**Decision:** Agents are model-agnostic by design. Any agent role can be
fulfilled by any sufficiently capable model — Claude, OpenAI-compatible APIs,
local models via Ollama, or a custom endpoint. The system does not assume
Claude as the underlying model.

**Rationale:** The original spec implicitly assumed Claude throughout — the
epistemic constitution was written as a Claude system prompt, context budgets
assumed capable instruction-following, and hard constraints relied on model
self-enforcement. Making the architecture explicitly model-agnostic improves
long-term flexibility, enables cost optimisation (cheaper or local models for
lower-stakes roles), and avoids vendor lock-in.

**The adapter layer:**
The CLI runner routes each agent invocation through an adapter — an
interchangeable implementation of a common interface. Adapters live in
`src/runner/adapters/` and handle: authentication, context window management,
prompt formatting for that model's conventions, and returning a normalised
response object. The runner speaks only to the adapter interface, never to
a model API directly.

Per-repo agent configuration lives in `.omoikane/config.yaml` in each
knowledge repo (not committed to the Omoikane project repo itself):

```yaml
agents:
    architect:
        adapter: claude
        model: claude-sonnet-4-6
    scribe:
        adapter: ollama
        model: mistral:7b
    critic:
        adapter: claude
        model: claude-sonnet-4-6
```

**The critical architectural consequence — structural constraint enforcement:**
Hard constraints must be enforced by the runner's output validation layer,
not by relying on models to self-enforce via prompt instructions alone.

Every agent role defines `output_schema` and `output_validation` rules in its
YAML spec. The runner validates every agent response against these rules before
accepting it. If validation fails, the runner rejects the output and surfaces
a specific, actionable error — regardless of which model or adapter produced
the output.

This is a departure from the original design, where hard constraints were
expressed only as prompt instructions. That approach works well with capable
models but degrades unpredictably with weaker ones. Moving enforcement to the
runner makes constraints reliable across all adapters.

**Separation of instructional intent from prompt formatting:**
The epistemic constitution and agent stances describe _what_ an agent must
achieve — expressed as model-agnostic instructional text. Each adapter
translates this intent into the specific prompt format its model expects
(system prompt, instruction tokens, chat turns, etc.).

Stored separately:

- `spec/machine/philosophy/epistemic_constitution.yaml` — intent, model-agnostic
- `src/runner/adapters/<n>.js` — formatting, model-specific

**Capability tiers and role suitability:**

| Role          | Minimum capability        | Rationale                                                       |
| ------------- | ------------------------- | --------------------------------------------------------------- |
| Auditor       | Low — local models viable | Procedural; outputs mechanically verifiable                     |
| Scribe        | Mid                       | Needs reliable instruction-following and multi-source reasoning |
| Cartographer  | Mid                       | Needs coherent cross-document reasoning                         |
| Critic        | High                      | Requires genuine adversarial reasoning                          |
| Methodologist | High                      | Requires pattern recognition across signals                     |
| Architect     | High                      | Requires nuanced dialogue and structured output                 |

Full recommendations in `spec/human/section2_agent_design.md`.

**Quality signals feed back into adapter choice:**
Document provenance records which adapter and model produced each output.
If a particular adapter/model combination consistently produces outputs that
get corrected or failed, that pattern surfaces in signal history without
requiring manual benchmarking. The user reconfigures that role's adapter
accordingly.

**Capability smoke tests are a phase 1 requirement.**

Rationale: without trust in agent outputs, Omoikane has no value. A user
who cannot verify that their configured model is capable of fulfilling a role
cannot trust anything the system produces. Smoke tests are therefore not a
quality-of-life feature — they are a precondition for the system's core value
proposition. They belong at phase 1 alongside the output validation layer.

Smoke tests run automatically during `omoikane repo init` when an adapter is
configured for the first time, and can be re-run manually via
`omoikane agent test <role>`. They are not optional and cannot be skipped.

A smoke test for a given role must verify:

- The adapter can reach the model (connectivity)
- The model returns output in the required schema (structural compliance)
- The model satisfies the role's `output_validation` rules on a synthetic
  input designed to surface common failure modes for that role
- The model's epistemic constitution behaviour is minimally acceptable —
  e.g. a Scribe smoke test includes a prompt designed to elicit confident
  confabulation, and checks that the model flags uncertainty rather than
  filling the gap

Smoke test definitions live alongside agent specs:
`spec/machine/agents/<role>_smoke_test.yaml`

Each smoke test defines: synthetic inputs, expected output shape, validation
rules that must pass, and at least one adversarial case targeting the role's
most likely failure mode. Smoke test results are stored in
`.omoikane/smoke_tests.yaml` with timestamps — so the user has a record of
when each role was last verified and against which model.

**If a smoke test fails, the role is blocked.** The user must either
reconfigure the adapter/model or explicitly acknowledge the failure and
accept reduced trust — at which point all outputs from that role are
flagged `low-trust` in document provenance until the smoke test passes.

The `low-trust` flag propagates: a document gathered by a low-trust Scribe
cannot be promoted to `verified` status regardless of what the Auditor finds.
Trust must be re-established at the source.

**Downstream impact on other spec sections:**

- **Section 2 (Agent Design):** each agent YAML must include a corresponding
  `<role>_smoke_test.yaml`. Agent YAML files must also include `output_schema`
  and `output_validation` alongside `hard_constraints`.
- **Section 5 (CLI Architecture):** runner must include the output validation
  layer, adapter routing, and smoke test execution. New command:
  `omoikane agent test <role>`. `repo init` triggers smoke tests on first
  adapter configuration.
- **Section 7 (Roadmap):** phase 1 explicitly includes smoke tests, output
  validation layer, and at least the Claude adapter. Ollama support is a
  phase 1 stretch goal — if deferred to phase 2, the smoke test framework
  must still be in place so Ollama can be added without rework.

---

_Last updated: added model-agnostic architecture decision (section 12)_
_Next: write `spec/human/section1_philosophy.md` and `spec/machine/philosophy/`_
