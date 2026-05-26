# Core Loop — Feature Spec

> Build Phase 1 of Omoikane. The minimum end-to-end research workflow.

## Overview

The Core Loop is the minimum end-to-end research workflow for Omoikane: a researcher initialises a subject-scoped repo, dialogues with the Architect to produce and approve an outline, then runs the Scribe to gather cited, structured knowledge on each outline node. It solves the problem of producing a knowledge base that can actually be trusted — where every claim carries provenance and uncertainty is recorded as a finding — without relying on the model to self-enforce those guarantees. It also establishes the structural foundation (adapter layer, output validation, smoke tests) that every later phase depends on.

## Goals

- A researcher can go from an empty directory to an inspectable, fully gathered knowledge base using only Phase 1 commands.
- Every factual claim carries source tier, fidelity, and confidence; no claim is silently un-sourced.
- Hard constraints are enforced by the runner's output validation layer, independent of which model produced the output.
- No agent role is trusted with real repo data until its smoke test passes.
- Phase 1 schemas and interfaces require no migration to support Phases 2–4.

## Non-goals

- The Critic, Auditor, Cartographer, and Methodologist agents.
- Full Cartographer gap analysis (the Scribe still emits gap documents on ceilings).
- Signal aggregator computation, prompt refinement, lineage, and forking.
- Multi-researcher / collaboration features.
- The Ollama adapter (deferred to Phase 2) and the OpenAI-compatible adapter.
- Docx rendering (`omoikane spec render`) — tracked as separate project tooling.

## User stories

- As a researcher, I want to initialise a subject-scoped repo through a learning-brief dialogue so that gathering is grounded in stated goals.
- As a researcher, I want to generate and approve an outline so that gather runs follow an agreed structure.
- As a researcher, I want to gather one node (or the next ungathered node) so that I build the knowledge base incrementally.
- As a researcher, I want every claim to carry provenance and every document a self-critique so that I can trust and audit the output.
- As a researcher, I want smoke tests to block untrusted adapters so that low-quality models cannot silently corrupt the repo.

## Functional requirements

1. The runner MUST route every agent invocation through an adapter implementing the interface in `adapter_interface.yaml`. A working Claude adapter and a custom-endpoint adapter MUST ship in Phase 1.
2. The runtime MUST be Node.js (current LTS) and the tool MUST be distributed as an npm-installable CLI; adapters are ES modules under `src/runner/adapters/`.
3. `omoikane repo init` MUST run the Architect learning-brief dialogue, create the manifest, bootstrap prompts for all command types, and trigger smoke tests for all configured roles.
4. The output validation layer MUST reject any agent output that violates its `output_schema` / `output_validation` before writing, surfacing the specific failed rule (exit code 3).
5. Smoke tests MUST run on first adapter configuration. A failing role MUST be blocked; an explicit override MUST flag all of that role's outputs `low-trust`, and the flag MUST propagate (a document gathered low-trust cannot reach verified status).
6. `omoikane outline` MUST produce or revise an outline; `outline approve` MUST unlock gather; `outline amend <node>` MUST flag the affected node's existing document as potentially stale.
7. `omoikane gather <node>` and `gather --next` MUST run the Scribe, validate output, write the document with provenance (adapter + model), and emit gap documents when the Scribe hits a ceiling.
8. Every gathered document MUST include a self-critique with at least one unresolved question.
9. The single-active-document-per-node constraint (MAN-VR1) MUST be enforced as a manifest validation rule, not a structural encoding.
10. `omoikane status` MUST display per-node progress, open checkpoints, and the research queue; `review` and `resolve` MUST manage checkpoints by type (inform / review / block).
11. `claim correct` and `claim retract` MUST update claim status and append a signal-history entry recording the signal type.
12. The signal-history, document, and prompt-entry schemas MUST include the forward-compatibility fields (FC1–FC8) from the start.

## Open questions

None identified. (Adapter scope, docx-render scope, and runtime were resolved during specification: Claude + custom adapters, docx tracked separately, Node.js + npm CLI.)

## Out of scope (deferred)

- Ollama and OpenAI-compatible adapters (Phase 2).
- Adversarial validation: `challenge`, `verify`, `gaps` (Phase 2).
- Prompt refinement, lineage, and prediction tracking (Phase 3).
- Collaboration, forking, and the shared prompt registry (Phase 4).
- Docx rendering of the project spec (separate tooling track).
