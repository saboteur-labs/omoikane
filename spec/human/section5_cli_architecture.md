# Section 5 — CLI Architecture

> This section specifies the CLI's design principles, four internal components,
> command set, precondition chain, output validation layer, and adapter routing.
>
> Machine-readable command definitions: `spec/machine/cli/commands.yaml`
> Machine-readable checkpoint definitions: `spec/machine/cli/checkpoints.yaml`

---

## 5.1 Design Principles

Four principles govern every CLI decision:

**Opinionated about sequence, not about pace.** The CLI enforces the research
workflow's ordering (init before outline, outline approved before gather, etc.)
but imposes no time constraint. A researcher can take months between commands.
The precondition system ensures correctness; the researcher controls cadence.

**Surface state, never hide it.** `omoikane status` is the canonical view of
what is known, what is in progress, and what is blocked. Error messages include
the specific reason for failure, not generic codes. A researcher should never
need to inspect raw YAML files to understand why a command failed.

**Fail loudly and specifically.** A failure message must say *what* failed
and *why*. "Error running gather" is not acceptable. "Cannot run gather on
node-003: outline is in draft status and has not been approved. Run
`omoikane outline approve` first." is. The runner constructs specific messages
from precondition check results.

**Scriptable: consistent output formats, explicit exit codes.** Every command
produces deterministic output that can be parsed by a script. Exit codes are
documented and stable. Long-form output (documents, reports) is written to
files; the CLI writes a summary and file path to stdout.

---

## 5.2 Four Internal Components

The CLI runner has four internal components. They are always present; some
are inactive in phases where their commands have not yet been implemented.

### 5.2.1 Runner

Receives CLI commands. For each command:

1. Reads the manifest to determine repo state
2. Checks preconditions via the state manager
3. If agent invocation is required: assembles the context budget, routes to
   the appropriate adapter, and passes the assembled context
4. Receives the agent response
5. Validates the response against the agent's `output_schema` and
   `output_validation` rules (the output validation layer)
6. If validation passes: writes output to the repo via the state manager
7. If validation fails: rejects the response, surfaces a specific error, and
   does not write to the repo

The runner never calls a model API directly. It speaks only to the adapter
interface. Adapter selection is determined by `.omoikane/config.yaml` in
the knowledge repo.

### 5.2.2 State Manager

Owns the manifest. Enforces all status transitions and sequencing rules.
Nothing writes to the manifest except through the state manager.

Responsibilities:
- Advancing outline node status (ungathered → gathered, etc.)
- Updating document status (active → superseded, etc.)
- Creating and resolving checkpoints
- Registering gap documents and prompt entries
- Enforcing that block checkpoints prevent node progress

The state manager is the only component allowed to mutate `manifest.yaml`.
This single-writer constraint ensures that concurrent CLI invocations on the
same repo do not produce inconsistent state.

**Locking:** The state manager acquires a file lock on `manifest.yaml` before
any write operation and releases it on completion. A command that cannot
acquire the lock within a short timeout fails with a specific message rather
than hanging or silently producing a partial write.

### 5.2.3 Checkpoint Registry

Tracks all open checkpoints. Every agent output that requires user action
registers a checkpoint here via the state manager. The registry is the
`open_checkpoints` array in `manifest.yaml` — it is not a separate file.

Responsibilities:
- Creating checkpoint entries when agent outputs require user action
- Surfacing checkpoints in `omoikane review`
- Enforcing that block checkpoints prevent progress on their affected node
- Resolving checkpoints when the researcher acts via `omoikane resolve`
- Archiving resolved checkpoints (they are removed from `open_checkpoints`
  but logged to a checkpoint history for auditability)

### 5.2.4 Signal Aggregator

Watches for signal events and maintains signal counts per prompt. Signal
events are produced by researcher actions (corrections, ratings, challenge
acceptances) and by runner-computed metrics (confidence delta after each
gather run).

Responsibilities:
- Recording signal events in the relevant document's `signal_history`
- Maintaining per-prompt independent signal counts
- Evaluating whether the two-signal threshold has been reached for a prompt
- Blocking `omoikane prompt promote` when the human-signal requirement is
  not met
- Providing the Methodologist with pre-aggregated signal history as part of
  its context budget

The signal aggregator is active from phase 1. Its full capabilities (feeding
the Methodologist) are used from phase 3.

---

## 5.3 The Output Validation Layer

**This is a phase 1 requirement without exception.**

Every agent response passes through the output validation layer before the
runner accepts it. The layer:

1. Parses the response as YAML
2. Checks that the root type matches the expected command output type
3. Validates all required fields are present with correct types
4. Applies `output_validation` rules from the agent's YAML spec
5. On success: passes the validated output to the state manager for writing
6. On failure: rejects the entire response, writes nothing to the repo,
   and returns a specific error message identifying which validation rule
   failed and why

**Partial acceptance is not permitted.** A response that passes structural
schema validation but fails an `output_validation` rule is rejected in full.
A Scribe document with 10 valid claims and one claim missing `source.tier`
is rejected — not accepted with the bad claim stripped. This forces the
adapter to retry with a corrected response rather than silently producing
a partial output.

**Retry behaviour:** On validation failure, the runner surfaces the specific
error and stops. It does not automatically retry. The researcher decides
whether to re-run the command (potentially with a different adapter or model)
or investigate the failure. Automatic retry would mask systemic model failures.

**Low-trust flag propagation:** If a smoke test failure is discovered after
a gather run has already produced documents, the runner sets `status: low-trust`
on those documents in the manifest. Trust must be re-established by re-running
the smoke test and re-gathering. The runner does not retroactively delete
the low-trust documents — they remain accessible for inspection.

---

## 5.4 The Adapter Layer

Every agent invocation is routed through an adapter. The runner never calls
a model API directly. Adapters are located in `src/runner/adapters/` and
implement a common interface.

**Adapter interface (minimum):**

```
adapter.invoke(role, context, prompt) → {raw_response, model_metadata}
```

The adapter receives: the agent role (used to load formatting conventions),
the assembled context bundle (files from the context budget), and the prompt
text. It returns: the raw response string and metadata (model identifier,
tokens used, latency).

The runner parses the raw response and validates it. Parsing and validation
are runner responsibilities — the adapter only handles communication.

**Adapter configuration** per role lives in `.omoikane/config.yaml` in the
knowledge repo, not in the Omoikane project repo itself. This keeps adapter
selection a per-researcher, per-repo decision.

**Smoke tests run on first configuration.** When `omoikane repo init`
encounters an adapter/model configuration for the first time, it automatically
runs the smoke test for that role before proceeding. If the smoke test fails,
the role is blocked. The researcher can override the block, at which point
all outputs from that role are flagged `low-trust` until the smoke test passes.

---

## 5.5 Precondition Chain

The CLI enforces an ordering on operations. The state manager checks these
preconditions before every agent-invoking command. Violations produce specific
error messages, not generic failures.

```
repo init
  └─ (creates manifest, runs smoke tests)
      └─ outline
          └─ (requires: manifest exists, learning brief exists)
              └─ outline approve
                  └─ (requires: outline in draft status)
                      └─ gather <node-id>
                          └─ (requires: outline approved,
                                node status is ungathered or stale,
                                no block checkpoint on this node)
```

Additional precondition rules:

- `gather --next` selects the first ungathered node in outline order with
  no block checkpoints. If all nodes are gathered, it reports this.
- `challenge <doc-id>` requires the document to have status `active` and
  not have an open challenge checkpoint.
- `verify <doc-id>` requires the document to have a completed challenge
  report (phase 2+).
- `gaps` requires at least one active document in the repo.
- `refine` requires the signal aggregator to report that at least one
  prompt has reached the two-signal threshold.
- `outline amend <node-id>` requires the outline to have been approved at
  least once. Amendments to an approved outline set status to `amended` and
  produce a `review` checkpoint.

---

## 5.6 Phase 1 Commands

These commands are implemented in phase 1.

### `omoikane repo init`

Initialises a new knowledge repo. Creates `manifest.yaml`, runs the Architect
for the learning brief dialogue, creates bootstrap prompts, and runs smoke
tests for all configured adapters.

Preconditions: No existing `manifest.yaml` in the current directory.

On completion: manifest created, learning brief written, bootstrap prompts
written, smoke test results written to `.omoikane/smoke_tests.yaml`.

### `omoikane status`

Displays current repo state. No preconditions beyond an existing manifest.

Output format:
```
<subject> — outline v<N> (<status>) — prompts v<N> — last activity <date>

Outline progress:
  ✓  <node-id>  <title>           [gathered]
  ⚠  <node-id>  <title>           [stale]
  ·  <node-id>  <title>           [ungathered]
  ⊘  <node-id>  <title>           [blocked: <checkpoint-id>]

Open checkpoints (N blocking, M review):
  [BLOCK]  <checkpoint-id>  <description>
  [REVIEW] <checkpoint-id>  <description>

Research queue (from last gaps run):
  1. <gap-id>  <gap description>
```

Symbols: `✓` gathered, `⚠` stale or low-trust, `·` ungathered,
`⊘` blocked by checkpoint.

### `omoikane outline`

Runs the Architect to produce or revise the outline.

Preconditions: manifest exists, learning brief exists.

### `omoikane outline approve`

Approves the current draft outline, unlocking `gather` runs.

Preconditions: outline in `draft` status.

### `omoikane outline amend <node-id>`

Amends a specific outline node after approval. Sets outline status to
`amended` and produces a `review` checkpoint for the affected node.

Preconditions: outline has been approved at least once.

### `omoikane gather <node-id>`

Runs the Scribe for the specified outline node using the active gather
prompt for that node.

Preconditions: outline is `approved` or `amended`, node is `ungathered`
or `stale`, no `block` checkpoint on this node.

Accepts optional `--prompt <prompt-id>` to use a specific prompt (e.g.
a candidate being evaluated) instead of the active prompt.

### `omoikane gather --next`

Equivalent to `omoikane gather` on the first ungathered node in outline
order with no block checkpoints.

### `omoikane review`

Lists all open checkpoints, grouped by type (blocking first, then review,
then inform). Shows the affected object, description, and available actions
for each.

### `omoikane resolve <checkpoint-id> --action <action>`

Acts on an open checkpoint. Available actions depend on the checkpoint type.
Block checkpoints require an explicit action before the affected node can
progress. Review checkpoints accept `acknowledge`, `note`, or `dismiss`.

### `omoikane claim correct <claim-id>`

Allows the researcher to correct the content of a specific claim. Sets the
claim's status to `corrected` and records a `user_correction` signal event
in the document's signal history.

### `omoikane claim retract <claim-id>`

Retracts a claim. Sets status to `retracted`. Records a signal event.
The claim remains in the document but is marked retracted — it is not deleted.

### `omoikane agent test <role>`

Manually re-runs the smoke test for the specified agent role. Results are
written to `.omoikane/smoke_tests.yaml`. If the test passes and the role
was previously blocked or low-trust, the runner prompts the researcher to
confirm re-trust before clearing the flag.

---

## 5.7 Later Phase Commands

These commands are specified now to ensure phase 1 decisions do not
foreclose them. They are not implemented until their respective phases.

### Phase 2

`omoikane challenge <doc-id>` — Runs the Critic on a document.

`omoikane verify <doc-id>` — Runs the Auditor on a document.

`omoikane gaps` — Runs the Cartographer on the full repo.

### Phase 3

`omoikane refine` — Runs the Methodologist to generate prompt candidates.

`omoikane prompt show <prompt-id>` — Displays a prompt entry in full.

`omoikane prompt diff <prompt-id-a> <prompt-id-b>` — Diffs two prompts,
showing text differences and lineage relationship.

`omoikane prompt promote <prompt-id>` — Promotes a candidate to active.
Blocked if human-signal requirement is not met.

`omoikane prompt reject <prompt-id> --reason <text>` — Rejects a candidate
and archives it as deprecated.

`omoikane prompt fork <prompt-id>` — Creates a new candidate branching from
an existing prompt (not necessarily the current active tip).

`omoikane prompt predictions` — Lists all predictions and their outcomes.

### Phase 2–3 inspection commands

`omoikane repo docs` — Lists all documents with status and provenance.

`omoikane repo gaps` — Lists all gap documents.

`omoikane repo prompts` — Lists the prompt library with lineage.

### Rendering (any phase)

`omoikane spec render [section]` — Generates a docx from the markdown spec.
Not used for knowledge repo content — only for the Omoikane project spec itself.

---

## 5.8 Exit Codes

All commands produce a documented exit code. Scripts can rely on these.

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | Usage error (unknown command, missing argument) |
| 2 | Precondition failure (specific reason in stderr) |
| 3 | Validation failure (agent output rejected; specific rule in stderr) |
| 4 | Smoke test failure |
| 5 | Adapter error (connectivity, authentication) |
| 6 | State manager error (lock timeout, integrity check failure) |

Exit codes 2 and 3 always write a specific human-readable message to stderr.
They are never "see logs for details" — the message is the diagnosis.

---

*Next section: `spec/human/section6_persistence.md`*
