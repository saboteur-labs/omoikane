# Section 7 — Roadmap

> This is the final spec section. It documents the four build phases, their
> scope and success criteria, the forward-compatibility constraint that governs
> every phase 1 implementation decision, and the open questions that remain
> genuinely unresolved.
>
> Machine-readable definitions: `spec/machine/roadmap/phases.yaml`

---

## 7.1 Philosophy of the Phased Approach

Each phase delivers something complete and useful on its own. A researcher
who uses Omoikane at phase 1 gets a real, working tool — not a scaffold
waiting for later phases to be valuable. Each subsequent phase adds a
complete capability that was not present before.

This matters because phases take time. A tool that is only useful at phase 4
is a tool that is useless for the entire construction period. The phase
boundaries are set at points where Omoikane is genuinely useful, not merely
technically functional.

The phases also have a deliberate epistemic ordering. Phase 1 gathers.
Phase 2 validates what was gathered. Phase 3 improves the gathering
methodology. Phase 4 allows that methodology to be shared. This ordering
reflects the deliberation principle: you build before you challenge, you
challenge before you refine, you refine before you collaborate.

---

## 7.2 Phase 1 — Core Loop

**Scope:** Architect, Scribe, full claim schema, output validation layer,
smoke tests, adapter layer (Claude minimum, Ollama stretch goal), manifest,
basic checkpoint system, `omoikane status`, basic prompt library storage.

**What is explicitly not in phase 1:** The Critic, Auditor, Cartographer,
and Methodologist. Gap documents are produced by the Scribe in phase 1, but
the Cartographer's full gap analysis is phase 2. Signal history is recorded
in phase 1 documents, but the signal aggregator's full capabilities feed the
Methodologist in phase 3.

**Phase gate:** A researcher can initialise a repo, produce an approved
outline, run gather on every node, and inspect the resulting knowledge base
in YAML. Every claim has source tier, fidelity, and confidence. Every document
has a self-critique with at least one unresolved question. Gap documents are
produced when the Scribe hits a ceiling. The output validation layer rejects
any document that violates hard constraints, regardless of which model
produced it. Smoke tests block untrusted adapters.

**What phase 1 proves:** A researcher can build a cited, structured knowledge
document with uncertainty explicitly flagged — without any claims being
silently un-sourced, without gaps being papered over, and without trusting
that the model followed instructions rather than knowing the runner verified it.

**Phase 1 non-negotiables (reiterated from CLAUDE.md):**
- Smoke tests for every agent role — not optional, not deferrable
- Output validation layer — rejects before writing, never accepts partial output
- Both Architect and Scribe agents functional with their full hard constraints
- Full claim schema as specified in section 3

**Ollama support in phase 1:** Viable but not guaranteed. The adapter layer
must be designed so Ollama can be added without rework. If Ollama is deferred
to phase 2, the adapter interface and smoke test framework must already be in
place for it. The Claude adapter is the minimum for phase 1 to ship.

---

## 7.3 Phase 2 — Validation Layer

**Scope:** Critic, Auditor, Cartographer. Full checkpoint system. Gap
documents as first-class repo objects (the Cartographer produces, updates,
and analyses them). Signal history feeds the checkpoint registry. Full
`omoikane review` and `omoikane resolve` flows. Source retrieval in the
Auditor. `omoikane challenge`, `omoikane verify`, `omoikane gaps`.

**What phase 2 adds to phase 1:** The adversarial layer. Phase 1 gathers
content and flags what the Scribe was uncertain about. Phase 2 independently
challenges the content (Critic), checks that sources actually support it
(Auditor), and analyses the whole repo for what is missing or contradictory
(Cartographer).

**Phase gate:** A researcher can take a fully gathered phase-1 repo and run
challenge, verify, and gaps on it. Critical Critic findings block document
progress. Auditor failures flag unverifiable sources. The Cartographer
produces a prioritised research queue with gap documents distinguished by
type. The checkpoint system surfaces everything that requires researcher
attention and blocks what cannot proceed without it.

**What phase 2 proves:** The deliberation principle has infrastructure. Bad
claims get caught. Gaps get named with enough specificity that the researcher
knows what kind of follow-up is warranted.

**Forward-compatibility notes for phase 1:** The signal history recorded by
phase 1 documents must be in the format the signal aggregator expects in
phase 3. The document schema must already include the `challenge_findings`
field (populated in phase 2 by the runner), the `re_gather_candidate` flag
(set in phase 2 by the Cartographer and Critic), and the `low-trust` status
(set in phase 1, checked throughout). Phase 1 should not use a simplified
document schema that would require migration at phase 2.

---

## 7.4 Phase 3 — Self-Improvement

**Scope:** Methodologist, signal aggregator fully operational, prompt
candidates with testable predictions, lineage and forking, staleness flags
on document promotion, `omoikane refine`, full prompt management commands
(`omoikane prompt show/diff/promote/reject/fork/predictions`).

**What phase 3 adds to phase 2:** The repo learns. The Methodologist analyses
accumulated signal and proposes refined prompts. The library evolves with
lineage preserved. The signal aggregator tracks which prompts are underperforming
and surfaces that to the Methodologist. Staleness flags ensure the researcher
knows when old documents were gathered under materially different instructions.

**Phase gate:** After multiple gather runs and challenge/verify/gaps cycles,
the signal aggregator identifies at least one prompt that has reached the
two-signal threshold. The researcher runs `omoikane refine`. The Methodologist
performs ceiling detection, reviews prediction outcomes, and produces at least
one candidate with a testable prediction. The researcher promotes or rejects
it. A promotion deprecates the previous active prompt, sets the staleness
flag on older documents, and records the prediction for future outcome checking.

**What phase 3 proves:** The repo gets better at learning its own subject
over time. The improvement is not opaque — every step is inspectable, every
prediction is checkable, and the researcher is in the loop on every promotion.

**Genuine uncertainty:** Phase 3 depends heavily on having enough signal to
work with. A small repo or a very narrow subject may not accumulate two
independent signals per prompt for a long time. The Methodologist may spend
most of phase 3 in a "no candidates produced" state on low-activity repos.
This is correct behaviour — it is better than generating candidates from
insufficient signal — but researchers should expect that phase 3's value
scales with repo activity.

---

## 7.5 Phase 4 — Collaboration

**Scope:** Author fields on claims and signal history, `contested-by-collaborators`
claim status, outline amendment proposal and approval flow for multi-researcher
repos, parallel gather recognition (two independent gathers on the same node
treated as a replication attempt, not a replacement), shared prompt registry,
fork/diff commands for repo and prompt library, divergent finding states.

**What phase 4 adds to phase 3:** Multiple researchers. The tool becomes a
platform.

**Phase gate:** Two researchers can independently gather on the same outline
node, compare their documents, and treat the agreement or disagreement as a
signal. They can share a prompt library without sharing repo content. They
can fork a repo, conduct independent research, and merge their gap documents
and prompt libraries.

**What phase 4 proves:** Omoikane is a platform, not just a personal tool.
Disagreement between researchers is surfaced as signal, not suppressed. The
deliberation principle extends from single-researcher use to collaborative use:
contradiction is a finding, not noise to resolve.

**The three collaboration models (from CONTEXT.md §9):**

1. **Shared repo** — multiple researchers on one knowledge base. Most complex.
   Requires author fields, outline amendment flow, and parallel gather
   recognition. Deferred to the end of phase 4.

2. **Forked repos** — independent research that can be merged. Largely free
   given the git-friendly structure. Earlier in phase 4.

3. **Shared prompt library** — methodology sharing without content sharing.
   High value, low complexity. First in phase 4.

**Schema additions required for phase 4** (already anticipated in phase 1–3
schemas where possible):

- `author` field on signal history entries and claim blocks. Not required in
  phases 1–3 but the signal history schema should not preclude it.
- `contested-by-collaborators` as a distinct claim status, distinct from
  `disputed` (which is Critic-originated). The claim status enumeration should
  be extensible.
- Outline amendment proposal/approval flow for multi-researcher contexts. The
  phase 1 `outline amend` command is a single-researcher operation; phase 4
  extends it with proposal and approval steps.
- Parallel gather recognition. The manifest's document registry must support
  multiple active documents on the same node — currently constrained to one
  active document per node (MAN-VR1). This constraint is relaxed in phase 4
  for explicit replication runs, not as a general relaxation.

**Forward-compatibility notes:** Phase 1–3 must not hard-code the
single-active-document-per-node constraint in ways that would require schema
migration to relax it. The constraint is a validation rule in the manifest
schema (MAN-VR1), not a structural property of the document format itself.
Phase 4 adds a `replication_run: true` flag to document entries that exempts
them from MAN-VR1 — this can be added to the existing schema without breaking
existing repos.

---

## 7.6 The Forward-Compatibility Constraint

Every phase 1 implementation decision must be explicitly checked against
phases 2–4. This section records the known compatibility requirements.

**Phase 1 must preserve for phase 2:**
- Document schema must include `challenge_findings`, `re_gather_candidate`,
  and the full status enumeration including `low-trust`
- Signal history format must be compatible with the signal aggregator's
  index schema
- Checkpoint types and registry format must support the full set of phase 2
  checkpoint producers

**Phase 1 must preserve for phase 3:**
- Prompt entry schema must include `generation`, `parent`, `prediction`,
  and `prediction_outcome` from the start — even though these are
  primarily used in phase 3, prompts created in phase 1 must be
  promotable to lineage-tracked entries in phase 3 without migration
- Signal history entries must include `signal_type` and `signal_category`
  so the signal aggregator can classify them in phase 3

**Phase 1 must preserve for phase 4:**
- Signal history entries should not preclude an `author` field
- Claim status enumeration must be extensible
- The manifest's document registry constraint (single active document per
  node) must be a validation rule, not a structural encoding

**The check:** When implementing any phase 1 component, the implementer
should ask: "If I were building phase 4 on top of this, would I need to
break this interface or migrate this schema?" If yes, fix it now.

---

## 7.7 State of the Spec

All seven sections are written. The full spec comprises:

| File | Status |
|------|--------|
| `spec/human/section1_philosophy.md` | Complete |
| `spec/machine/philosophy/epistemic_constitution.yaml` | Complete |
| `spec/machine/philosophy/principles.yaml` | Complete |
| `spec/human/section2_agent_design.md` | Complete |
| `spec/machine/agents/*.yaml` (6 agent + 6 smoke test) | Complete |
| `spec/human/section3_schema.md` | Complete |
| `spec/machine/schema/*.yaml` (5 files) | Complete |
| `spec/human/section4_prompt_library.md` | Complete |
| `spec/machine/prompt_library/lifecycle.yaml` | Complete |
| `spec/human/section5_cli_architecture.md` | Complete |
| `spec/machine/cli/commands.yaml` | Complete |
| `spec/machine/cli/checkpoints.yaml` | Complete |
| `spec/human/section6_persistence.md` | Complete |
| `spec/machine/persistence/model.yaml` | Complete |
| `spec/human/section7_roadmap.md` | This file |
| `spec/machine/roadmap/phases.yaml` | Complete |

**Implementation begins with phase 1.** The natural starting point is the
adapter layer, since the output validation layer and agent execution both
depend on it. The sequence within phase 1 is not prescribed — the spec
is the constraint, not a construction order.

---

## 7.8 Open Questions

These are genuine uncertainties that the spec does not resolve. They should
be addressed during implementation, not deferred indefinitely.

**Lineage drift threshold (section 4 §4.6.3):** The generation threshold
at which meta-refine review is triggered (currently set at 5 in
`lifecycle.yaml`) is not empirically validated. Real repos may need a
different value. This should be treated as a configurable parameter from
the start rather than a hard-coded constant.

**Ollama phase 1 scope:** Whether Ollama support ships in phase 1 or phase 2
is not resolved. The adapter interface must be designed so the answer does
not matter structurally — adding Ollama in phase 2 should require only
writing `src/runner/adapters/ollama.js`, not modifying the adapter interface.

**Replication run semantics in phase 4:** The mechanism for relaxing
MAN-VR1 (single active document per node) for parallel gathers is
described but not fully specced. The `replication_run: true` flag noted
in section 7.5 is a sketch. Phase 4 will need to specify how two replication
documents are compared, what disagreement between them produces (a checkpoint?
a gap document? a `contested` claim?), and how the researcher resolves them.

**Manifest merge conflict tooling:** Phase 4 requires a solution to the
manifest merge conflict problem (section 6 §6.7). The form of that solution
is not yet designed. It may be a custom git merge driver, an explicit merge
command, or something else. This is deferred but should not be designed in
a way that requires restructuring the manifest.

**Confidence delta baseline:** The signal aggregator computes
`confidence_delta` as the change in document confidence relative to the
"repo baseline." What constitutes the baseline is not precisely defined —
it could be the mean confidence of all documents, the mean confidence of
documents on the same outline node type, or something else. This requires
a precise definition before the signal aggregator can be implemented.

---

*The spec is complete. Implementation begins with phase 1.*
