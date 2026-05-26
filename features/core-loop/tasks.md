# Core Loop — Implementation Tasks

> Build Phase 1 of Omoikane. Tasks are ordered by dependency. Manual
> verification **gates** are interleaved — each gate tells you exactly what to
> do by hand to confirm the work is real, including which keys to set and which
> dashboards to open. Do not start a task whose dependencies are unmet, and do
> not skip a gate: a failed gate means the tasks below it are built on sand.

---

## Conventions used in the gates

- **Keys.** The Claude adapter authenticates with an Anthropic API key. Create
  one at the **Anthropic Console** → <https://console.anthropic.com> → *Settings
  → API Keys*. Export it before running anything that touches Claude:
  `export ANTHROPIC_API_KEY=sk-ant-...`. If the variable is unset, adapter
  connectivity must fail cleanly (exit code 5), not crash.
- **Cost / usage dashboard.** Watch spend and request counts at the Anthropic
  Console → *Usage* (<https://console.anthropic.com/settings/usage>). Every
  gate that invokes an agent costs tokens; check here after each gather-heavy
  gate to confirm calls actually went out and to catch runaway loops.
- **Custom adapter endpoint.** The custom adapter points at any HTTP endpoint
  that accepts a text prompt and returns a text response. For testing, stand up
  a trivial local echo/stub server (or an OpenAI-compatible server such as
  `llama.cpp --server` / LM Studio) and put its URL in `.omoikane/config.yaml`.
  You do **not** need a real model behind it to test routing and error handling
  — only to test a genuine gather.
- **Where files land.** A knowledge repo is just a directory. After init you
  should see `manifest.yaml`, `learning_brief.yaml`, `prompts/`, and
  `.omoikane/` (containing `config.yaml`, `smoke_tests.yaml`, and the gitignored
  `omoikane.db`). Inspect these directly — they are the source of truth.
- **Exit codes** are part of the contract (see `spec/machine/cli/commands.yaml`).
  Check them with `echo $?` immediately after each command.

---

### Task 1: Project scaffolding & CLI skeleton

**What:** A Node.js project with an `omoikane` CLI entry point that parses the Phase 1 command/namespace grammar and dispatches to (initially stubbed) handlers.
**Files:** `package.json`, `bin/omoikane.js`, `src/cli/index.js`, `src/cli/commands/*.js` (stubs), `.gitignore` (add `.omoikane/omoikane.db`, `spec/dist/`)
**Done when:** `npx omoikane --help` lists every Phase 1 command (`repo init`, `status`, `outline`, `outline approve`, `outline amend`, `gather`, `gather --next`, `review`, `resolve`, `claim correct`, `claim retract`, `agent test`), and each stub returns a documented exit code. A YAML parser (e.g. `yaml`) and a SQLite driver (e.g. `better-sqlite3`) are installed and importable.
**Depends on:** none
**Estimate:** 3
**Notes:** Runtime is pinned to Node.js (current LTS) and npm per the spec decision. `spec render` is intentionally excluded (tracked separately). Keep handlers thin — they orchestrate the components built in later tasks.
**Done:** [x]

---

### Task 2: YAML schema loader + generic output-validation engine

**What:** A validation layer that loads an agent's `output_schema` and `output_validation` rules from `spec/machine/agents/*.yaml` and validates an arbitrary parsed object against them, rejecting before any write.
**Files:** `src/runner/validation/schema_loader.js`, `src/runner/validation/validator.js`, `test/validation.test.js`
**Done when:** Given a hand-written valid Scribe `document` object the validator passes; given objects that violate SCR-OV1 (empty `unresolved_questions`), SCR-OV2 (tier_1/tier_2 claim with no citation), SCR-OV3 (empty self-critique field), and SCR-OV4 (duplicate claim id) it returns the **specific** violation message from the YAML and a failure result. Same coverage for Architect ARC-OV1–OV4. Unit tests assert each rule fires.
**Depends on:** 1
**Estimate:** 5
**Notes:** This is the structural-enforcement core (Phase 1 non-negotiable P1-NN2). It must be model-agnostic — it sees only a parsed object. ARC-OV5 (gap_placeholder) resolves to a *review checkpoint*, not a hard failure — return that distinction rather than rejecting.
**Done:** [x]

---

### Task 3: Adapter interface, constitution assembly & context-budget enforcement

**What:** The adapter contract (`invoke`, `smoke_test`, `get_model_id`, `get_adapter_id`), a routing layer that selects an adapter per role from `.omoikane/config.yaml`, epistemic-constitution injection, and pre-invoke context-budget enforcement (strip/reject forbidden keys).
**Files:** `src/runner/adapters/interface.js`, `src/runner/router.js`, `src/runner/constitution.js`, `src/runner/config.js`, `test/context_budget.test.js`
**Done when:** The router refuses to pass any `forbidden` context key (per each agent's `context_budget`) into `invoke` and throws before any network call; the constitution `core_statement` and all five directives (EC-D1–D5) are assembled into the prompt payload; `AgentResponse`/`SmokeTestResult` shapes and the five error types (`AdapterConnectionError`, `AdapterTimeoutError`, `AdapterRateLimitError`, `AdapterParseError`) are defined per `adapter_interface.yaml`. A no-op fake adapter passes a routing unit test.
**Depends on:** 1
**Estimate:** 3
**Notes:** Context isolation is a structural constraint enforced *here*, not in each adapter (adapter_interface.yaml §context_isolation). The constitution is `overridability: none` — it cannot be weakened by config or prompt.
**Done:** [x]

---

### Task 4: Claude adapter

**What:** A working Anthropic Messages API adapter implementing the interface, including constitution placement in the system prompt, response parsing into the agent's `output_schema`, retry-with-backoff on rate limits, and provenance fields (`get_model_id`, `get_adapter_id`).
**Files:** `src/runner/adapters/claude.js`, `test/adapters/claude.test.js`
**Done when:** With `ANTHROPIC_API_KEY` set, `invoke('scribe', ...)` returns a populated `AgentResponse` whose `parsed` object passes the Task 2 validator for a tractable topic; rate-limit responses retry up to 3 times then surface `AdapterRateLimitError`; unparseable responses raise `AdapterParseError` (mapped to exit 3) rather than returning partial output; a missing/invalid key raises `AdapterConnectionError` (exit 5).
**Depends on:** 2, 3
**Estimate:** 5
**Notes:** This is the Phase 1 minimum adapter (P1 ships on Claude). Default model `claude-sonnet-4-6`. Mock the HTTP layer in unit tests; real connectivity is proven in **Gate A**.
**Done:** [x]

---

### Task 5: Custom-endpoint adapter

**What:** An adapter that POSTs the assembled prompt to a researcher-configured HTTP endpoint and returns the text response, implementing the same interface and error mapping.
**Files:** `src/runner/adapters/custom.js`, `test/adapters/custom.test.js`
**Done when:** Pointed at a local stub server it returns a valid `AgentResponse`; an unreachable endpoint raises `AdapterConnectionError` (exit 5); a timeout raises `AdapterTimeoutError`. Prompt-formatting responsibility sits with the researcher (documented in the adapter header).
**Depends on:** 3
**Estimate:** 2
**Notes:** Ollama and OpenAI adapters are explicitly out of scope (Phase 2 / not chosen). Custom proves the interface accepts an external adapter without runner changes.
**Done:** [x]

---

### 🚦 Gate A — Adapter connectivity & isolation

**Purpose:** Prove the system can actually reach a model and that the structural guards (constitution, context budget, error mapping) hold before any repo state exists.

**Prerequisites:**
1. Create an Anthropic API key at <https://console.anthropic.com> → *Settings → API Keys*.
2. `export ANTHROPIC_API_KEY=sk-ant-...` in your shell.
3. (Optional, for the custom adapter) start a local stub HTTP server that returns a fixed text body, and note its URL.

**Steps:**
1. Run the project's adapter connectivity check (a throwaway script or `omoikane agent test` once Task 10 exists — at this gate use a small script that calls `claude.invoke` with the SCR-ST1 connectivity prompt `"Respond with the single word: ready"`). Confirm a non-empty response returns within the timeout.
2. **Unset** the key (`unset ANTHROPIC_API_KEY`) and re-run. Confirm it fails with `AdapterConnectionError` and a clear message — **not** a stack trace — and that the process exit code is `5`.
3. Re-export the key. Trigger a context-budget violation by handing the router a `scribe` context that includes a forbidden key (e.g. `challenge_reports`). Confirm it throws **before** any network call (your Usage dashboard should show **no** new request for this step).
4. Point the custom adapter at your stub URL and confirm it returns text; then point it at a dead port and confirm `AdapterConnectionError`.
5. Open the **Anthropic Console → Usage** dashboard and confirm exactly the requests you expect appear (step 1 and step 4-if-Claude), and nothing from steps 2–3.

**Pass criteria:** Live Claude call succeeds; missing key → exit 5 with a human-readable message; forbidden context is rejected with zero API calls; custom adapter routes and fails cleanly. Usage dashboard matches expectations (no surprise calls).

---

### Task 6: State manager — atomic YAML writes & manifest

**What:** The single writer of repo YAML: manifest read/update, document/gap/prompt file writing with the temp-then-rename atomic protocol, and the canonical file layout.
**Files:** `src/runner/state/state_manager.js`, `src/runner/state/manifest.js`, `src/runner/state/paths.js`, `test/state_manager.test.js`
**Done when:** Creating a repo writes a schema-valid `manifest.yaml`; writing a document uses the `documents/<node-id>/doc-<node-id>-<YYYYMMDD>-<seq>.yaml` naming convention via temp-then-rename (no partial files on simulated mid-write failure); MAN-VR1 (single active document per node) is enforced as a **validation rule** the manager calls, not a hardcoded structural assumption (FC8). All canonical files are text with readable diffs.
**Depends on:** 1
**Estimate:** 5
**Notes:** YAML is the source of truth. Per persistence/model.yaml, the SQLite commit (Task 7) precedes the YAML rename in the full atomic protocol — wire that ordering once Task 7 exists.
**Done:** [x]

---

### Task 7: SQLite working index + `repo reindex`

**What:** The rebuildable index (tables: `documents`, `claims`, `signal_events`, `checkpoints`, `gap_documents`, `prompts`) populated from YAML, plus an idempotent `omoikane repo reindex`.
**Files:** `src/runner/state/index_db.js`, `src/cli/commands/repo_reindex.js`, `test/reindex.test.js`
**Done when:** `omoikane repo reindex` drops and rebuilds all tables from YAML, never modifies YAML, treats dangling references and integrity-check failures as warnings (not errors), and prints a summary (`files_read`, `records_indexed`, `warnings_produced`). Deleting `omoikane.db` and reindexing reproduces identical query results. `omoikane.db` is gitignored.
**Depends on:** 6
**Estimate:** 5
**Notes:** Index stores metadata/references, not full content. The `documents(outline_node_id, status)` index backs the fast MAN-VR1 check. `reindex` requires no network/adapter.
**Done:** [x]

---

### Task 8: Checkpoint registry

**What:** Creation, storage (`manifest.open_checkpoints`), and append-only history (`.omoikane/checkpoint_history.yaml`) for the three checkpoint types, with the review-ordering rule and resolution-action validity per type.
**Files:** `src/runner/checkpoints/registry.js`, `test/checkpoints.test.js`
**Done when:** Checkpoints can be created with unique IDs (`CP-<prefix>-<date>-<seq>`); `block` checkpoints cause the state manager to refuse commands that would advance the affected object; resolving moves a checkpoint from `open_checkpoints` to history with action + timestamp; `inform` auto-resolves on review while `review`/`block` do not; invalid action-for-type is rejected (exit 1).
**Depends on:** 6
**Estimate:** 3
**Notes:** Producers and valid actions are enumerated in `cli/checkpoints.yaml`. Phase 1 only wires Architect, Scribe, runner, and smoke-test producers — but the registry must accept the full type/action set so Phase 2 producers need no schema change (FC3).
**Done:** [x]

---

### Task 9: Smoke-test framework

**What:** A runner that loads `spec/machine/agents/<role>_smoke_test.yaml`, executes each case through the configured adapter (connectivity / structural_compliance / output_validation / adversarial), evaluates `pass_conditions`, and writes results to `.omoikane/smoke_tests.yaml`. On failure it blocks the role; override flags the role `low-trust`.
**Files:** `src/runner/smoke/runner.js`, `src/runner/smoke/evaluators.js`, `test/smoke.test.js`
**Done when:** Running Scribe smoke tests executes SCR-ST1–ST5 plus the universal EC-ST1/ST2/ST3 probes and records per-case `passed`/`failure_reason`/`failure_detail`; a forced failure produces a `block` checkpoint (CP-SMK-2) and, on override, sets the role `low-trust`; the `low-trust` flag is persisted and queryable. Architect smoke tests run equivalently.
**Depends on:** 4, 8
**Estimate:** 5
**Notes:** Phase 1 non-negotiable P1-NN1 — a role is untrusted until its smoke test passes, and `low-trust` propagates (a low-trust gather can never reach `verified`). Adversarial evaluators check the spec's `pass_conditions` (e.g. tier_3 fallback on the confabulation probe).
**Done:** [x]

---

### Task 10: `omoikane agent test <role>` command

**What:** The CLI entry that re-runs a role's smoke test on demand, updates `.omoikane/smoke_tests.yaml`, and prompts for re-trust confirmation when a previously low-trust/blocked role newly passes.
**Files:** `src/cli/commands/agent_test.js`
**Done when:** `omoikane agent test scribe` runs the suite and returns exit `0` on pass, `4` on failure (role blocked), `5` on connectivity error, `1` on unknown role; a pass after a prior low-trust state prompts the researcher to confirm before clearing the flag.
**Depends on:** 9
**Estimate:** 2
**Notes:** This is also the most convenient manual probe for the adapter, used directly in Gate B.
**Done:** [ ]

---

### 🚦 Gate B — Smoke tests block untrusted adapters

**Purpose:** Prove the trust gate is real: a healthy adapter passes and is recorded; a broken one blocks the role and, only on explicit override, runs `low-trust`.

**Prerequisites:** `ANTHROPIC_API_KEY` exported. A throwaway working directory to act as a knowledge repo (you can hand-create a minimal `.omoikane/config.yaml` setting `scribe` and `architect` to `adapter: claude, model: claude-sonnet-4-6` until Task 11 generates it).

**Steps:**
1. Run `omoikane agent test scribe`. Watch it execute connectivity → structural → validation → adversarial cases. Confirm exit `0`.
2. Open `.omoikane/smoke_tests.yaml` and confirm each case (SCR-ST1–ST5) has a result and a timestamp. Confirm the file is **not** gitignored (it is meant to be committed) while `omoikane.db` **is** gitignored.
3. Open the **Anthropic Console → Usage** dashboard and confirm the smoke-test calls registered (several small requests). This confirms the tests hit a real model, not a stub.
4. **Force a failure:** temporarily point `scribe` at the custom adapter with a stub URL that returns malformed/empty output (or set a bogus model id). Re-run `omoikane agent test scribe`. Confirm exit `4`, a `block` checkpoint appears, and the role is reported blocked.
5. Run `omoikane review` (Task 15 — if not yet built, inspect `manifest.open_checkpoints`) and confirm the block checkpoint (CP-SMK-2) is listed. Override it and confirm the role is now flagged `low-trust` and the override is logged to `checkpoint_history.yaml`.
6. Restore the good Claude config, re-run `omoikane agent test scribe`, and confirm you are prompted to confirm re-trust before the `low-trust` flag clears.

**Pass criteria:** Healthy run → exit 0 and recorded results; broken run → exit 4 + block; override → low-trust + logged; recovery → re-trust prompt. Usage dashboard confirms real calls.

---

### Task 11: `omoikane repo init`

**What:** Repo initialisation: the interactive Architect learning-brief dialogue, writing `learning_brief.yaml` + `manifest.yaml`, creating bootstrap prompt files for each command type, generating a default `.omoikane/config.yaml`, and triggering smoke tests for all configured roles.
**Files:** `src/cli/commands/repo_init.js`, `src/runner/bootstrap_prompts.js`
**Done when:** In an empty directory, `omoikane repo init` runs the Architect `init` dialogue (rejecting output with an empty `questions_asked` per ARC-OV1), writes a schema-valid `learning_brief.yaml` and `manifest.yaml`, creates `prompts/p-<type>-1-<seq>.yaml` bootstrap entries (each carrying `generation`, `parent`, `prediction`, `prediction_outcome` per FC4), runs smoke tests, and returns exit `0` only if all pass (else `4`; `2` if already initialised; `5` on connectivity error). Re-running in the same dir returns exit `2`.
**Depends on:** 7, 9, 10
**Estimate:** 5
**Notes:** The dialogue is interactive — the runner mediates Q&A between researcher and Architect. Default config sets all Phase 1 roles to Claude; the researcher may switch a role to custom.
**Done:** [ ]

---

### Task 12: `outline`, `outline approve`, `outline amend`

**What:** Outline generation/revision via the Architect, approval that unlocks gather, and post-approval node amendment that flags staleness.
**Files:** `src/cli/commands/outline.js`, `src/cli/commands/outline_approve.js`, `src/cli/commands/outline_amend.js`
**Done when:** `omoikane outline` produces a schema-valid `outline.yaml` (enforcing ARC-OV2/OV3/OV4, and raising the ARC-OV5 *review checkpoint* when no `gap_placeholder` node exists), increments `outline.version`, sets status `draft`. `outline approve` advances `draft → approved`, sets `approved_at`, unlocks gather, emits an inform checkpoint (exit `2` if not in draft). `outline amend <node>` requires prior approval, updates the node, sets status `amended`, and raises a CP-OUT-1 review checkpoint marking the existing document potentially stale (exit `2` on bad precondition/unknown node).
**Depends on:** 11
**Estimate:** 5
**Notes:** Workflow ordering is enforced (DP1) — gather must be impossible until an outline is approved.
**Done:** [ ]

---

### 🚦 Gate C — Outline lifecycle

**Purpose:** Prove the Architect produces a valid, typed outline and that the approve/amend state machine and its checkpoints behave.

**Prerequisites:** A repo initialised via Gate B / Task 11 (`ANTHROPIC_API_KEY` set).

**Steps:**
1. Run `omoikane outline`. Answer nothing — it runs the Architect. When it returns, open `outline.yaml` and confirm: every node has a `type` from the enum, `version` is `1`, status is `draft`, and `contested_or_edge_case_node_count` matches the actual count of contested/edge_case nodes.
2. Confirm at least one `gap_placeholder` node exists. If none, run `omoikane review` and confirm an ARC-OV5 review checkpoint was raised (this is allowed — it is a review, not a block).
3. Attempt `omoikane gather --next` **now** and confirm it refuses (gather is locked until approval) with a specific message and exit `2`.
4. Run `omoikane outline approve`. Confirm status → `approved`, `approved_at` is set, exit `0`, and an inform checkpoint says gather is unlocked. Run it again and confirm exit `2` (not in draft).
5. Run `omoikane outline amend <some-node-id>`, change the description, and confirm status → `amended` and a CP-OUT-1 review checkpoint flags that node's (future) document as potentially stale.
6. Check the **Usage** dashboard: steps 1 (and any re-run) should show Architect calls; steps 3–5 should show none (they are pure state transitions).

**Pass criteria:** Valid typed outline; gather correctly locked pre-approval; approve/amend transitions and checkpoints fire as specified; no agent calls on pure state transitions.

---

### Task 13: `gather <node>` and `gather --next`

**What:** The Scribe gather run: select the active prompt for the node, invoke the Scribe, validate output (SCR-OV1–OV4) before writing, wrap it into a full document with provenance (adapter + model + prompt id/generation), write gap documents, append the gather signal-history entry, register the document in the manifest/index, and advance node status.
**Files:** `src/cli/commands/gather.js`, `src/runner/gather_pipeline.js`
**Done when:** `omoikane gather <node>` (and `--next`, which picks the first ungathered/stale node with no block) runs only when the outline is approved/amended and no block checkpoint is open on the node; validated output is written to `documents/<node-id>/...` with full provenance and `status` from the document enum (including the `low-trust`/`challenge_findings`/`re_gather_candidate` fields per FC1); each document has a `self_critique` with ≥1 unresolved question (else exit `3`); gaps produce `gaps/gap-*.yaml` and a CP-SCR-2 review checkpoint; a low-trust adapter produces a CP-SCR-3 checkpoint and a propagating low-trust flag. Exit `2`/`3`/`5` on precondition/validation/adapter failures respectively; `gather --next` returns `2` when nothing remains.
**Depends on:** 12
**Estimate:** 8
**Notes:** The Scribe's `output_schema` is narrower than the full document schema — the pipeline wraps it. Signal-history entries must carry `signal_type`/`signal_category` (FC5) and not preclude an `author` field (FC6). This is the heart of the core loop.
**Done:** [ ]

---

### 🚦 Gate D — Full core loop, end to end

**Purpose:** The headline Phase 1 proof. A researcher goes from empty directory to a fully gathered, cited, uncertainty-flagged knowledge base — and every guarantee is visible in the YAML.

**Prerequisites:** `ANTHROPIC_API_KEY` exported. A fresh empty directory. Optionally, one or two real source files to hand the Scribe as Tier 1 sources for a node. Have the **Anthropic Console → Usage** dashboard open (this gate makes the most calls — watch for cost and for any retry storms).

**Steps:**
1. `omoikane repo init` — complete the Architect dialogue with a small, real subject (e.g. "the Roman aqueduct system"). Confirm exit `0` and that smoke tests passed.
2. `omoikane outline` → inspect → `omoikane outline approve`.
3. Run `omoikane gather --next` repeatedly until it returns exit `2` ("nothing to do"). For at least one node, instead run `omoikane gather <node> --prompt <id>` to confirm the prompt override path works.
4. **Inspect a gathered document** under `documents/<node-id>/`. Confirm, by eye:
   - every claim has `source.tier`, `source.fidelity`, and `confidence.level` + `confidence.basis`;
   - every tier_1/tier_2 claim has a non-empty `citation` (no silently un-sourced claims);
   - `self_critique` is present with a non-empty `what_was_hard`, `confidence_floor`, and **at least one** `unresolved_questions` entry;
   - `provenance` records the `adapter` and `model` that produced it.
5. Confirm at least one node where the Scribe hit a ceiling produced a `gaps/gap-*.yaml` with a `nature` of `knowledge_ceiling` / `source_absence` / `contested_foundation` — and that the gap was **not** papered over with a confident claim.
6. **Adversarial spot check:** pick a node asking for an obscure precise statistic. Confirm the Scribe either marked the claim `tier_3` or produced a gap — it must not assert a specific external figure without a citation.
7. **Validation rejection check:** temporarily configure the node's prompt (or use the custom adapter stub) to coerce a document with an empty `unresolved_questions`. Confirm the runner **rejects** it (exit `3`) with the SCR-OV1 message and writes **nothing** to `documents/`.
8. Run `omoikane repo reindex` and confirm it reports the documents/claims/gaps it indexed with zero errors.
9. Check the **Usage** dashboard: confirm one Scribe call per node (plus your override/adversarial runs) and no unexpected bursts.

**Pass criteria:** Every node gathered or gap-documented; every claim carries provenance; every document self-critiques with an open question; gaps are first-class, not filled; the validator rejects a non-compliant document before writing. This gate passing **is** the Phase 1 capability.

---

### Task 14: `omoikane status`

**What:** The at-a-glance repo state display: subject, outline version/status, prompt-library version, last activity, per-node progress with symbols, open checkpoints, and research queue.
**Files:** `src/cli/commands/status.js`
**Done when:** `omoikane status` prints per-node progress using `✓` gathered / `⚠` stale-or-low-trust / `·` ungathered / `⊘` blocked, lists open checkpoints, and exits `0` (or `2` with a clear message when no manifest is present). Output is reproducible and reads from the index.
**Depends on:** 13
**Estimate:** 3
**Notes:** Read-only; no agent invocation. Scriptable output per DP4.
**Done:** [ ]

---

### Task 15: `omoikane review` and `omoikane resolve`

**What:** Listing open checkpoints (block → review → inform, recent first) with available actions, and acting on one by id with a type-appropriate action.
**Files:** `src/cli/commands/review.js`, `src/cli/commands/resolve.js`
**Done when:** `omoikane review` lists open checkpoints in the specified order with affected object + description + valid actions (exit `0` even when empty; `2` if no manifest). `omoikane resolve <id> --action <action>` accepts only actions valid for that type (`acknowledge` for inform/review; `note`/`dismiss` for review; `accept`/`override` for block), moves the checkpoint to history with timestamp, performs the side effect (e.g. `note` writes `user_notes`; `override` writes an inform log entry), and rejects unknown actions (exit `1`) or unknown ids (exit `2`). Running `review` auto-resolves inform checkpoints.
**Depends on:** 8, 13
**Estimate:** 3
**Notes:** Block checkpoints must genuinely gate progress — verified in Gate E.
**Done:** [ ]

---

### Task 16: `omoikane claim correct` and `omoikane claim retract`

**What:** Researcher edits to individual claims: correction (opens editor, sets status `corrected`, records a `user_correction` signal) and retraction (sets status `retracted`, claim retained not deleted), each appending a signal-history entry.
**Files:** `src/cli/commands/claim_correct.js`, `src/cli/commands/claim_retract.js`
**Done when:** `omoikane claim correct <id>` updates the claim content + status to `corrected` in its document YAML, appends a signal-history entry (with `signal_type`/`signal_category`), updates the `signal_events` index, and emits an inform checkpoint (exit `2` if claim not found / document inactive). `omoikane claim retract <id>` sets status `retracted` only from `active`/`disputed` (exit `2` if already retracted), retaining the claim. Both produce readable git diffs.
**Depends on:** 13
**Estimate:** 3
**Notes:** Signal recording here is the Phase 1 slice of the signal pipeline the Phase 3 aggregator/Methodologist consume — the entry format must already be aggregator-compatible (FC2/FC5).
**Done:** [ ]

---

### 🚦 Gate E — Status, checkpoints, and claim edits

**Purpose:** Prove the researcher-in-the-loop surfaces work: state is visible, blocks genuinely block, and human claim edits are recorded as signal with clean diffs.

**Prerequisites:** The fully gathered repo from Gate D. Set your `$EDITOR` (e.g. `export EDITOR=vim` or `code --wait`) so `claim correct` can open an editor.

**Steps:**
1. Run `omoikane status`. Confirm the symbol legend matches reality: gathered nodes show `✓`, the node you amended in Gate C shows `⚠` (stale), any ungathered show `·`. Confirm outline version/status, prompt-library version, and open checkpoints are shown.
2. Run `omoikane review`. Confirm ordering is block → review → inform, most recent first, and that each entry shows its valid actions.
3. **Block gating:** ensure a block checkpoint is open on a node (re-use the smoke-test block from Gate B, or force one). Attempt a command that would advance that node and confirm the state manager **refuses** it until you `omoikane resolve <id> --action accept` (or `override`). Confirm `override` writes an inform entry and is logged to `checkpoint_history.yaml`.
4. **Review actions:** `omoikane resolve <review-id> --action note`, enter a note, and confirm it lands in the affected object's `user_notes`. Try an invalid action for the type (e.g. `--action accept` on a review checkpoint) and confirm exit `1`.
5. **Claim correct:** pick a claim id from a gathered document, run `omoikane claim correct <id>`, edit the content, save. Confirm the claim's `status` is `corrected`, a signal-history entry was appended, and `git diff` shows a small, readable, semantically meaningful change.
6. **Claim retract:** run `omoikane claim retract <id>` on an active claim; confirm status `retracted` and the claim is still present (not deleted). Re-run and confirm exit `2` (already retracted).
7. `omoikane repo reindex` and confirm the `signal_events` and `checkpoints` tables reflect your edits (the inform checkpoints auto-cleared on review; the correction/retraction signals are indexed).

**Pass criteria:** Status reflects true per-node state; review ordering correct; blocks genuinely prevent progress until resolved; invalid actions rejected; claim edits change status, record signal, and produce clean diffs.

---

### 🚦 Final Gate — Phase 1 phase-gate sign-off

**Purpose:** Confirm the formal Phase 1 gate from `spec/machine/roadmap/phases.yaml` is met end to end, on a clean repo, by you, by hand.

**Prerequisites:** A brand-new empty directory. `ANTHROPIC_API_KEY` exported. Anthropic Console *Usage* dashboard open.

**Steps:**
1. From empty: `omoikane repo init` → `omoikane outline` → `omoikane outline approve` → `omoikane gather --next` until exhausted.
2. Confirm **every** node is either gathered (a document with full provenance) or has a gap document.
3. Confirm **every** claim across all documents has source tier, fidelity, and confidence.
4. Confirm **every** document has a self-critique with at least one unresolved question.
5. Confirm the output validation layer rejected at least one deliberately malformed document during your testing (re-use Gate D step 7 evidence) — i.e. prove constraints are enforced by the runner, not trusted to the model.
6. Confirm smoke tests blocked an untrusted adapter at some point (Gate B evidence) and that a `low-trust` document, if any, cannot be marked verified.
7. Confirm the whole repo is git-committable: `git status` shows text YAML files with readable diffs and `omoikane.db` is untracked.

**Pass criteria:** All of the above true simultaneously on a clean repo. This is the definition of Phase 1 done: *a researcher can build a cited, structured knowledge base with uncertainty explicitly flagged — without silently un-sourced claims, without papered-over gaps, and without trusting that the model followed instructions rather than knowing the runner verified it.*

---

## Summary

- **Total tasks:** 16 implementation tasks + 6 manual verification gates (A–E + Final).
- **Total estimated effort:** 65 story points.
- **Critical path:** Task 1 → 2 → 4 (via 3) → 9 → 11 → 12 → 13 → 15/16 → Final Gate. In short: validation engine → Claude adapter → smoke tests → init → outline → gather is the spine; status/review/resolve/claim hang off the gathered repo.
- **Risks:**
  - **Task 13 (gather pipeline, 8 pts)** is the highest-complexity, highest-value task — it composes the adapter, validator, state manager, checkpoint registry, and signal recording. Most likely place for integration surprises.
  - **Task 9 (smoke-test framework)** depends on subjective `pass_conditions` for adversarial cases; evaluator logic for "did the model confabulate?" needs care to avoid false passes/fails. Budget for tuning against real model output (Gate B).
  - **Live-model gates (A, B, D, Final)** cost real tokens and depend on a valid `ANTHROPIC_API_KEY` and Anthropic API availability. Watch the Usage dashboard for retry storms, especially while Task 4's backoff logic is young.
  - **Interactive dialogue in Task 11** (Architect init) is hard to unit-test; it will be exercised primarily through the manual gates.
