# Follow-up Work — Core Loop

---

## 2026-05-25 — Task 8: Checkpoint registry

**Item:** Wire `hasBlockingCheckpoints` into gather and outline command handlers

**Why deferred:** The `hasBlockingCheckpoints` function exists and is tested, but the gather and outline command handlers (Tasks 11–12) are not yet implemented. The enforcement can only be wired once those handlers exist.

**Context:** When a `block` checkpoint is open for an affected object, the spec requires the system to refuse any command that would advance that object. The mechanism is `hasBlockingCheckpoints(manifest, affectedObjectId)` from `src/runner/checkpoints/registry.ts`. Each command handler that advances an outline node or document must call this before proceeding, and surface a precondition failure (exit 2) if a block is found.

---

## 2026-05-25 — Task 9: Smoke-test framework

**Item:** Wire `applyLowTrustOverride` into the `resolve` command handler for CP-SMK-2 overrides

**Why deferred:** `applyLowTrustOverride(repoDir, role)` is implemented in `src/runner/smoke/runner.ts` and ready to call. The `resolve` command handler (`src/cli/commands/resolve.ts`) is still a stub. When that handler is implemented (Task 16), it must detect that it is resolving a `block` checkpoint whose affected_object_id is a role (and not a document/node), and call `applyLowTrustOverride` to complete the low-trust state transition.

**Context:** The sequence is: `omoikane resolve <CP-SMK-2-id> --action override` → resolve handler → detect smoke test block → call `applyLowTrustOverride(repoDir, affectedObjectId)` → trust_status set to 'low-trust' in `.omoikane/smoke_tests.yaml`. The `checkpoint_id` prefix 'SMK' or the `produced_by: runner` field can be used to identify smoke test blocks.

---

## 2026-05-25 — Task 9: Smoke-test framework (additional)

**Item:** EC-ST3 universal probe (generic uncertainty) not mechanically evaluated

**Why deferred:** EC-ST3 requires detecting that uncertainty is described *specifically*, not generically. This is a semantic check that cannot be evaluated mechanically without a separate model call. The SCR-ST4/ST5 adversarial cases provide coverage for EC-ST1/EC-ST2; EC-ST3 relies on the constitution being followed.

**Context:** If a future task adds a second-pass evaluator (e.g., a critic agent evaluating smoke test outputs), EC-ST3 could be wired there. For now, structural + OV rule compliance is the mechanical bound.

---

## 2026-05-25 — Task 11: `omoikane repo init`

**Item:** Smoke tests during init cover only Phase 1 roles (architect, scribe), not all 6 configured roles

**Why deferred:** Phase 2 agents (critic, auditor, cartographer, methodologist) are not invoked in Phase 1. Running their smoke tests during init would require valid mock responses for all their output schemas in tests, and would add latency to init with no functional benefit until Phase 2 is built.

**Context:** `PHASE_1_ROLES = ['architect', 'scribe']` is hard-coded in `src/cli/commands/repo.ts`. When Phase 2 agents are added, update `runRepoInit` to smoke test all configured roles (or roles up to the highest active phase).
