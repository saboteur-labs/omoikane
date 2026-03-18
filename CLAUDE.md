# CLAUDE.md — Omoikane Project Briefing

> Read this file at the start of every session. It is the authoritative project
> orientation. For full decision rationale, read `CONTEXT.md`.

---

## What is Omoikane?

Omoikane (思兼) is a repository-backed, AI-augmented research and learning tool.
Each repo is scoped to one subject. The tool helps a researcher build a structured,
cited, validated knowledge base on that subject — a textbook drawn from multiple
sources, with uncertainty treated as a finding rather than a failure.

The name comes from the Shinto deity of wisdom and deliberation. That is not
decorative. It is a design constraint. **Deliberation over speed is the central
commitment of this project.**

---

## Repository Layout

```
omoikane/
  CLAUDE.md                        # this file — read every session
  CONTEXT.md                       # full decision log with rationale
  .gitignore                       # excludes spec/dist/
  spec/
    human/                         # markdown — canonical human-readable source
      section1_philosophy.md
      section2_agent_design.md
      section3_schema.md
      section4_prompt_library.md
      section5_cli_architecture.md
      section6_persistence.md
      section7_roadmap.md
    machine/                       # YAML — canonical machine-readable source
      philosophy/
        epistemic_constitution.yaml  # instructional intent, model-agnostic
        principles.yaml
      agents/
        architect.yaml             # role, stance, context_budget,
        architect_smoke_test.yaml  # output_schema, output_validation,
        scribe.yaml                # hard_constraints — all model-agnostic
        scribe_smoke_test.yaml
        critic.yaml
        critic_smoke_test.yaml
        auditor.yaml
        auditor_smoke_test.yaml
        cartographer.yaml
        cartographer_smoke_test.yaml
        methodologist.yaml
        methodologist_smoke_test.yaml
      schema/
        manifest.yaml
        document.yaml
        claim.yaml
        gap.yaml
        prompt_entry.yaml
      cli/
        commands.yaml
        checkpoints.yaml
      runner/
        adapter_interface.yaml     # adapter contract + phase scope decisions
      roadmap/
        phases.yaml
    dist/                          # GITIGNORED — generated artifacts only
      *.docx
  src/                             # implementation (phase 1 onwards)
    runner/
      adapters/                    # model-specific adapter implementations
        claude.js
        openai.js
        ollama.js
        custom.js
  README.md
```

Per-repo agent configuration (not committed to the project repo — lives in
each Omoikane knowledge repo):

```
<knowledge-repo>/
  .omoikane/
    config.yaml                    # adapter + model selection per agent role
    omoikane.db                    # GITIGNORED — SQLite working index
```

---

## Canonical Format Rules

| Purpose                       | Format                    | Versioned?                           |
| ----------------------------- | ------------------------- | ------------------------------------ |
| Human-readable spec prose     | Markdown (`spec/human/`)  | Yes — git tracked                    |
| Machine-readable agent config | YAML (`spec/machine/`)    | Yes — git tracked                    |
| Rendered documents            | Docx / PDF (`spec/dist/`) | No — gitignored, generated on demand |

**Markdown is written first. YAML is produced alongside it. Docx is never edited
directly.** Every spec section produces both a `.md` and its corresponding YAML
files simultaneously. These are the only two things that get committed.

---

## The Six Agents

Each agent has a fixed role, epistemic stance, and context budget. They communicate
only through the repo — never directly with each other.

| Agent         | Command           | Role                               | Phase |
| ------------- | ----------------- | ---------------------------------- | ----- |
| Architect     | `init`, `outline` | Creates learning brief and outline | 1     |
| Scribe        | `gather`          | Gathers and documents information  | 1     |
| Critic        | `challenge`       | Adversarially reviews documents    | 2     |
| Auditor       | `verify`          | Checks source traceability         | 2     |
| Cartographer  | `gaps`            | Analyses the whole repo for gaps   | 2     |
| Methodologist | `refine`          | Improves the prompt library        | 3     |

All agents inherit the epistemic constitution (see `spec/machine/philosophy/epistemic_constitution.yaml`).

---

## Model-Agnostic Agent Architecture

**Agents are model-agnostic by design.** Any agent role can be fulfilled by
any sufficiently capable model — Claude, OpenAI, a local model via Ollama,
or a custom endpoint. The system does not assume Claude.

### The Adapter Layer

The CLI runner routes each agent invocation through an adapter. Adapters are
interchangeable implementations of a common interface.

```
src/runner/adapters/
  claude.js       # Anthropic API
  openai.js       # OpenAI-compatible APIs
  ollama.js       # local models via Ollama
  custom.js       # bring your own endpoint
```

Agent backends are configured per-role in `.omoikane/config.yaml`:

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

### Constraint Enforcement Is Structural, Not Prompt-Based

**Hard constraints are enforced by the runner's output validation layer —
not by relying on the model to follow instructions.**

Every agent role defines an `output_schema` and `output_validation` rules.
The runner validates every agent response against these rules before accepting
it. If validation fails, the runner rejects the output and surfaces a specific
error — regardless of which model produced it.

Example: if a Scribe returns a claim without a `source_tier` field, the runner
rejects the entire response. The model does not need to reliably self-enforce
this constraint — the system enforces it structurally.

This is the critical architectural consequence of model-agnosticism. **Do not
implement hard constraints as prompt instructions alone.**

### The Epistemic Constitution Is Instructional Intent

The epistemic constitution describes **what an agent must achieve**, expressed
as instructional text. Each adapter translates this intent into the prompt
format its model expects. The constitution is model-agnostic. The adapter
formatting is model-specific.

Stored separately:

- `spec/machine/philosophy/epistemic_constitution.yaml` — the intent (model-agnostic)
- `src/runner/adapters/<name>.js` — the formatting (model-specific)

### Capability Tiers and Role Suitability

Not all models are suitable for all roles. General guidance:

| Role          | Minimum capability        | Notes                                                              |
| ------------- | ------------------------- | ------------------------------------------------------------------ |
| Auditor       | Low — local models viable | Procedural, structured, mechanically verifiable outputs            |
| Scribe        | Mid                       | Requires reliable instruction-following and multi-source reasoning |
| Cartographer  | Mid                       | Requires coherent cross-document reasoning                         |
| Critic        | High                      | Requires genuine adversarial reasoning                             |
| Methodologist | High                      | Requires pattern recognition across signals                        |
| Architect     | High                      | Requires nuanced dialogue and structured output                    |

Full capability recommendations in `spec/human/section2_agent_design.md`.

### Smoke Tests Are Mandatory — Phase 1

**A role cannot be trusted with real repo data until its smoke test passes.**
Smoke tests run automatically on first adapter configuration during
`omoikane repo init`. Re-run manually with `omoikane agent test <role>`.

Each smoke test verifies: connectivity, structural compliance with
`output_schema`, satisfaction of `output_validation` rules on synthetic
input, and minimally acceptable epistemic constitution behaviour (including
at least one adversarial case targeting the role's most likely failure mode).

**If a smoke test fails, the role is blocked.** If the user overrides and
proceeds, all outputs from that role are flagged `low-trust` in document
provenance. The `low-trust` flag propagates — a document gathered by a
low-trust Scribe cannot reach `verified` status regardless of Auditor results.
Trust must be re-established at the source.

Smoke test definitions: `spec/machine/agents/<role>_smoke_test.yaml`
Smoke test results per knowledge repo: `.omoikane/smoke_tests.yaml`

### Output Quality Signals Feed Back Into Adapter Choice

Document provenance records which adapter and model produced each output.
If a particular adapter/model combination consistently produces outputs that
get corrected or failed, that pattern is visible in signal history. The user
reconfigures that role's adapter accordingly.

---

## The Epistemic Constitution

Every agent inherits this stance. It cannot be overridden by any prompt or
user instruction:

> You are a careful research assistant. Your highest obligation is accuracy,
> not completeness. When you do not know something, say so specifically. When
> a claim lacks a source, flag it explicitly. When you are uncertain, describe
> that uncertainty. Never fill a gap with a plausible-sounding answer — treat
> the gap as a finding. You are building a document that a person will trust.
> Earn that trust slowly.

---

## The Five Principles

1. **Uncertainty is a finding, not a failure.** Name gaps explicitly. Do not paper over them.
2. **Every claim must know where it came from.** Source tier, fidelity, and confidence are required on every factual claim.
3. **The system must be able to argue against itself.** Gather and validate are separate agents with no shared context.
4. **The methodology improves alongside the content.** The prompt library is a living artifact. Refinement requires multiple independent signals.
5. **The human is always in the loop on judgment calls.** Agents surface. Humans decide. No agent output silently changes repo state.

---

## Schema: The Three Layers

**Repo manifest** — spine of the repo. Tracks all documents, outline status,
prompt library version, known gaps, open checkpoints.

**Document block** — output of a single gather run. Contains provenance
(which prompt, which generation, which source tiers), status, signal history,
self-critique, and follow-up prompt candidates.

**Claim block** — atomic unit of knowledge. Every factual assertion. Fields:
`type`, `content`, `source` (tier + citation + fidelity), `confidence`
(level + basis + corroborating/contradicting sources), `status`.

**Gap document** — first-class output. Not a placeholder. Types:
`knowledge_ceiling`, `source_absence`, `contested_foundation`.

---

## Source Tiers

| Tier   | Description                 | Trust                              |
| ------ | --------------------------- | ---------------------------------- |
| Tier 1 | User-provided sources       | Highest — always cited explicitly  |
| Tier 2 | AI-retrieved via web search | Cited, flagged as AI-retrieved     |
| Tier 3 | Model parametric knowledge  | Always flagged, no external source |

---

## Claim Fidelity Levels

| Level        | Meaning                                                          |
| ------------ | ---------------------------------------------------------------- |
| `direct`     | Claim closely mirrors source language                            |
| `paraphrase` | Meaning preserved, words changed                                 |
| `inferred`   | Claim follows logically from source but is not explicitly stated |

---

## Checkpoint Types

| Type     | Behaviour                                         |
| -------- | ------------------------------------------------- |
| `inform` | Logged and visible. No action required.           |
| `review` | Surfaces for user attention. Non-blocking.        |
| `block`  | Repo cannot proceed on this node until user acts. |

---

## CLI — Core Commands (Phase 1)

```bash
omoikane repo init          # create repo, run learning brief dialogue
omoikane status             # repo state at a glance
omoikane outline            # generate or revise outline
omoikane outline approve    # approve outline, unlocks gather
omoikane gather <node-id>   # gather on one outline node
omoikane gather --next      # gather next ungathered node
omoikane review             # show all open checkpoints
omoikane resolve <item-id>  # act on a checkpoint item
```

Full command set including phase 2–4 commands is in `spec/machine/cli/commands.yaml`.

---

## Persistence Model

**Hybrid: YAML + SQLite**

- YAML files are the canonical source of truth. Human-readable, git-tracked,
  always rebuildable.
- SQLite (`.omoikane/omoikane.db`) is a working index built from YAML. Used
  for queries, signal aggregation, and cross-document operations.
- The database is always rebuildable: `omoikane repo reindex`
- The rendering layer (external apps, docx generation) reads YAML directly —
  no database dependency.

---

## Build Phases

| Phase                | Scope                                                                                                                       | Key deliverable                                                       |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1 — Core loop        | Architect + Scribe, schema, output validation layer, smoke tests, adapter layer (Claude minimum), basic checkpoints, status | A user can init, outline, and gather — with verified trust in outputs |
| 2 — Validation       | Critic + Auditor + Cartographer, full checkpoint system                                                                     | Gathered content can be challenged and verified                       |
| 3 — Self-improvement | Methodologist, prompt library refinement, prediction tracking                                                               | Repo improves its own methodology over time                           |
| 4 — Collaboration    | Author fields, shared prompt registry, fork/diff, parallel gathers                                                          | Repos and prompt libraries can be shared                              |

**Phase 1 decisions must not foreclose phases 2–4.** When in doubt, check the
roadmap section of the spec (`spec/human/section7_roadmap.md`).

**Smoke tests and the output validation layer are phase 1 requirements without
exception.** They are the foundation of user trust, not a quality-of-life
addition. Nothing ships in phase 1 without them.

---

## Working Conventions

- Write spec sections in order: produce the `.md` first, then the YAML alongside it.
- Every non-obvious design decision in the markdown should have a rationale.
  Flag genuine uncertainty explicitly — the spec should not present every
  decision as settled.
- Every agent YAML must include: `role`, `stance`, `context_budget` (required,
  optional, forbidden), `output_schema`, `output_validation`, and
  `hard_constraints`. Hard constraints must be enforceable by the runner's
  output validation layer — not prompt instructions alone.
- The epistemic constitution YAML contains instructional intent only. Adapter-
  specific prompt formatting lives in `src/runner/adapters/`, not in the spec.
- Do not begin implementation (`src/`) until the full spec is written and
  both markdown and YAML files exist for all seven sections.
- Commit message convention: `spec: section N — <title>` for spec work,
  `impl: <component>` for implementation.

---

## Current Status

- [x] Philosophy designed (conversation)
- [x] Model-agnostic architecture decided (conversation)
- [x] Smoke tests confirmed as phase 1 requirement (conversation)
- [x] `spec/human/section1_philosophy.md` — complete
- [x] `spec/machine/philosophy/epistemic_constitution.yaml` — complete
- [x] `spec/machine/philosophy/principles.yaml` — complete
- [x] `spec/human/section2_agent_design.md` — complete
- [x] `spec/machine/agents/*.yaml` (6 agent + 6 smoke test) — complete
- [x] `spec/human/section3_schema.md` — complete
- [x] `spec/machine/schema/*.yaml` (5 files) — complete
- [x] `spec/human/section4_prompt_library.md` — complete
- [x] `spec/machine/prompt_library/lifecycle.yaml` — complete
- [x] `spec/human/section5_cli_architecture.md` — complete
- [x] `spec/machine/cli/commands.yaml` — complete
- [x] `spec/machine/cli/checkpoints.yaml` — complete
- [x] `spec/human/section6_persistence.md` — complete
- [x] `spec/machine/persistence/model.yaml` — complete
- [x] `spec/human/section7_roadmap.md` — complete
- [x] `spec/machine/roadmap/phases.yaml` — complete
- [x] `spec/machine/runner/adapter_interface.yaml` — complete (OQ2 resolution)
- [x] Open questions OQ1–OQ5 — resolved
- [ ] Implementation — phase 1

**Start here:** `src/runner/adapters/claude.js` — the adapter interface is
fully specified in `spec/machine/runner/adapter_interface.yaml`. Implement
that contract. The output validation layer and agent execution both depend
on the adapter layer being in place.

**Key constraints to carry into implementation:**

- Hard constraints are enforced structurally by the runner, not by prompt alone
- Every agent role must have a passing smoke test before being trusted with real repo data
- Smoke tests block phase 1 shipping — they are not optional
- Phase 1 decisions must not foreclose phases 2–4 (see `spec/machine/roadmap/phases.yaml` FC1–FC8)
- Lineage thresholds are configurable via `.omoikane/config.yaml` under `methodology.*` — do not hard-code
- Confidence delta baseline is repo-wide mean of all active claims — defined in `lifecycle.yaml`
- Ollama is deferred to phase 2 — do not implement it in phase 1
