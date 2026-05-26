import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import type { Adapter, AgentResponse, SmokeTestResult } from '../src/runner/adapters/interface.ts';
import {
  evaluateCase,
  type SmokeTestCase,
} from '../src/runner/smoke/evaluators.ts';
import {
  runSmokeTests,
  readTrustStatus,
  applyLowTrustOverride,
  SmokeTestSpecNotFoundError,
} from '../src/runner/smoke/runner.ts';
import { StateManager } from '../src/runner/state/state_manager.ts';
import { smokeTestsPath } from '../src/runner/state/paths.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validScribeGather = {
  type: 'document',
  outline_node_id: 'node-001',
  prompt_id: 'p-bootstrap-001',
  prompt_generation: 1,
  date: '2026-05-25',
  claims: [
    {
      id: 'claim-001',
      type: 'factual',
      content: 'The speed of light in a vacuum is 299,792,458 m/s.',
      source: { tier: 'tier_1', fidelity: 'direct', citation: 'https://physics.nist.gov/' },
      confidence: { level: 'high', basis: 'Well-established physical constant.' },
      status: 'active',
    },
  ],
  self_critique: {
    what_was_hard: 'Distinguishing the exact defined value from approximations.',
    confidence_floor: 'High — this is a defined constant.',
    unresolved_questions: ['What are the implications for quantum gravity theories?'],
  },
  signal_history: [],
};

const validScribeGatherWithGap = {
  ...validScribeGather,
  gap_documents: [
    { id: 'gap-001', nature: 'knowledge_ceiling', description: 'Exact count unknown.', status: 'open' },
  ],
};

const validArchitectInit = {
  type: 'learning_brief',
  subject: 'Byzantine fault tolerance',
  goal: 'Understand how consensus is achieved when nodes may behave arbitrarily',
  prior_knowledge: 'Basic distributed systems; no prior fault tolerance theory',
  priority_angles: ['Practical consensus algorithms (PBFT)'],
  definition_of_done: 'Clear explanation of PBFT and its key assumptions',
  questions_asked: [{ question: 'What is your prior knowledge?', answer: 'Basic distributed systems.' }],
};

const validArchitectOutline = {
  type: 'outline',
  version: 1,
  nodes: [
    { id: 'n-001', type: 'factual', title: 'Overview', description: 'Overview of BFT.', parent_id: null, status: 'draft' },
    { id: 'n-002', type: 'contested', title: 'Fault models', description: 'Different failure assumptions.', parent_id: null, status: 'draft' },
    { id: 'n-003', type: 'gap_placeholder', title: 'Unknown proofs', description: 'Open theoretical questions.', parent_id: null, status: 'draft' },
  ],
  contested_or_edge_case_node_count: 1,
};

function makeResponse(parsed: Record<string, unknown>): AgentResponse {
  return { raw_text: yaml.dump(parsed), parsed, model_id: 'test-model' };
}

// ---------------------------------------------------------------------------
// ScenarioAdapter — configurable responses for runner integration tests
// ---------------------------------------------------------------------------

class ScenarioAdapter implements Adapter {
  constructor(
    private readonly connectivityPassed: boolean,
    private readonly commandResponses: Record<string, AgentResponse | Error>,
    private readonly fallbackResponse: AgentResponse,
  ) {}

  async invoke(_role: string, context: Record<string, unknown>, _constitution: string): Promise<AgentResponse> {
    const command = context.command as string | undefined;
    const resp = (command && this.commandResponses[command]) ?? this.fallbackResponse;
    if (resp instanceof Error) throw resp;
    return resp;
  }

  async smoke_test(_role: string, test_case: Record<string, unknown>): Promise<SmokeTestResult> {
    const testId = (test_case.id as string) ?? 'unknown';
    if (this.connectivityPassed) return { test_id: testId, passed: true };
    return { test_id: testId, passed: false, failure_reason: 'Connection failed in test' };
  }

  get_model_id() { return 'scenario-model'; }
  get_adapter_id() { return 'scenario'; }
}

// ---------------------------------------------------------------------------
// Setup / teardown (for runner tests only)
// ---------------------------------------------------------------------------

let tmpDir: string;
let sm: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-smoke-test-'));
  sm = new StateManager(tmpDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// evaluateCase — structural_compliance
// ---------------------------------------------------------------------------

describe('evaluateCase — structural_compliance', () => {
  const baseCase: SmokeTestCase = {
    id: 'SCR-ST2',
    label: 'structural_compliance',
    type: 'structural_compliance',
    description: 'Structural compliance test',
    input: { command: 'gather' },
    pass_conditions: [],
  };

  test('passes for a valid scribe gather document', () => {
    const result = evaluateCase(baseCase, makeResponse(validScribeGather), 'scribe');
    assert.equal(result.passed, true);
    assert.equal(result.test_id, 'SCR-ST2');
  });

  test('fails when response has no required fields (empty object)', () => {
    const result = evaluateCase(baseCase, makeResponse({}), 'scribe');
    assert.equal(result.passed, false);
    assert(result.failure_reason!.includes('Validation failed'));
  });

  test('fails when claims array is missing', () => {
    const { claims: _claims, ...withoutClaims } = validScribeGather;
    const result = evaluateCase(baseCase, makeResponse(withoutClaims), 'scribe');
    assert.equal(result.passed, false);
  });

  test('passes for a valid architect init output', () => {
    const arcCase: SmokeTestCase = {
      id: 'ARC-ST2',
      label: 'structural_compliance_init',
      type: 'structural_compliance',
      description: 'Architect init structural test',
      input: { command: 'init' },
      pass_conditions: [],
    };
    const result = evaluateCase(arcCase, makeResponse(validArchitectInit), 'architect');
    assert.equal(result.passed, true);
  });
});

// ---------------------------------------------------------------------------
// evaluateCase — output_validation
// ---------------------------------------------------------------------------

describe('evaluateCase — output_validation', () => {
  const ovCase: SmokeTestCase = {
    id: 'SCR-ST3',
    label: 'output_validation_provenance',
    type: 'output_validation',
    description: 'OV provenance test',
    input: { command: 'gather' },
    pass_conditions: [],
  };

  test('passes for valid gather with proper tier_1 citation', () => {
    const result = evaluateCase(ovCase, makeResponse(validScribeGather), 'scribe');
    assert.equal(result.passed, true);
  });

  test('fails SCR-OV2 when tier_1 claim has no citation', () => {
    const badDoc = {
      ...validScribeGather,
      claims: [
        {
          id: 'claim-001',
          type: 'factual',
          content: 'Some content.',
          source: { tier: 'tier_1', fidelity: 'direct' }, // no citation
          confidence: { level: 'high', basis: 'Direct source.' },
          status: 'active',
        },
      ],
    };
    const result = evaluateCase(ovCase, makeResponse(badDoc), 'scribe');
    assert.equal(result.passed, false);
    assert(result.failure_detail !== undefined);
  });
});

// ---------------------------------------------------------------------------
// evaluateCase — epistemic_constitution
// ---------------------------------------------------------------------------

describe('evaluateCase — epistemic_constitution', () => {
  test('SCR-ST4: passes when tier_3 claim has no citation (correct parametric sourcing)', () => {
    const scr4Case: SmokeTestCase = {
      id: 'SCR-ST4',
      label: 'adversarial_confabulation_probe',
      type: 'epistemic_constitution',
      description: 'Confabulation probe',
      input: { command: 'gather' },
      pass_conditions: [],
    };
    const doc = {
      ...validScribeGather,
      claims: [
        {
          id: 'claim-001',
          type: 'factual',
          content: 'Exact count is parametric knowledge.',
          source: { tier: 'tier_3', fidelity: 'direct' }, // tier_3 — no citation required
          confidence: { level: 'low', basis: 'Parametric knowledge only.' },
          status: 'active',
        },
      ],
    };
    const result = evaluateCase(scr4Case, makeResponse(doc), 'scribe');
    assert.equal(result.passed, true);
  });

  test('SCR-ST5: passes when gap_documents is non-empty', () => {
    const scr5Case: SmokeTestCase = {
      id: 'SCR-ST5',
      label: 'adversarial_gap_filling',
      type: 'epistemic_constitution',
      description: 'Gap filling probe',
      input: { command: 'gather' },
      pass_conditions: [],
    };
    const result = evaluateCase(scr5Case, makeResponse(validScribeGatherWithGap), 'scribe');
    assert.equal(result.passed, true);
  });

  test('SCR-ST5: passes when a claim has type gap', () => {
    const scr5Case: SmokeTestCase = {
      id: 'SCR-ST5',
      label: 'adversarial_gap_filling',
      type: 'epistemic_constitution',
      description: 'Gap filling probe',
      input: { command: 'gather' },
      pass_conditions: [],
    };
    const doc = {
      ...validScribeGather,
      claims: [
        {
          id: 'claim-001',
          type: 'gap', // gap-type claim
          content: 'Unknown quantity.',
          source: { tier: 'tier_3', fidelity: 'direct' },
          confidence: { level: 'low', basis: 'Knowledge ceiling.' },
          status: 'active',
        },
      ],
    };
    const result = evaluateCase(scr5Case, makeResponse(doc), 'scribe');
    assert.equal(result.passed, true);
  });

  test('SCR-ST5: fails when no gap evidence is present', () => {
    const scr5Case: SmokeTestCase = {
      id: 'SCR-ST5',
      label: 'adversarial_gap_filling',
      type: 'epistemic_constitution',
      description: 'Gap filling probe',
      input: { command: 'gather' },
      pass_conditions: [],
    };
    const result = evaluateCase(scr5Case, makeResponse(validScribeGather), 'scribe');
    assert.equal(result.passed, false);
    assert(result.failure_reason!.includes('SCR-ST5'));
  });

  test('ARC-ST5: passes when questions_asked is non-empty', () => {
    const arcAdversarialCase: SmokeTestCase = {
      id: 'ARC-ST5',
      label: 'adversarial_no_clarification',
      type: 'epistemic_constitution',
      description: 'No clarification probe',
      input: { command: 'init' },
      pass_conditions: [],
    };
    const result = evaluateCase(arcAdversarialCase, makeResponse(validArchitectInit), 'architect');
    assert.equal(result.passed, true);
  });

  test('ARC-ST5: fails when questions_asked is empty (ARC-OV1 fires)', () => {
    const arcAdversarialCase: SmokeTestCase = {
      id: 'ARC-ST5',
      label: 'adversarial_no_clarification',
      type: 'epistemic_constitution',
      description: 'No clarification probe',
      input: { command: 'init' },
      pass_conditions: [],
    };
    const noQuestionsDoc = { ...validArchitectInit, questions_asked: [] };
    const result = evaluateCase(arcAdversarialCase, makeResponse(noQuestionsDoc), 'architect');
    assert.equal(result.passed, false);
  });
});

// ---------------------------------------------------------------------------
// runSmokeTests — integration (uses real scribe smoke test YAML)
// ---------------------------------------------------------------------------

describe('runSmokeTests — scribe all cases pass', () => {
  test('returns all_passed=true and sets trust_status to trusted', async () => {
    const adapter = new ScenarioAdapter(
      true,
      { gather: makeResponse(validScribeGatherWithGap) },
      makeResponse(validScribeGatherWithGap),
    );
    const result = await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    assert.equal(result.all_passed, true);
    assert.equal(result.role, 'scribe');
    assert.equal(result.adapter_id, 'scenario');
    assert.equal(result.model_id, 'scenario-model');
    assert(Array.isArray(result.cases) && result.cases.length > 0);
  });

  test('writes smoke_tests.yaml with trusted status', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    assert(existsSync(smokeTestsPath(tmpDir)));
    const file = yaml.load(readFileSync(smokeTestsPath(tmpDir), 'utf8')) as Record<string, unknown>;
    const roles = file.roles as Record<string, Record<string, unknown>>;
    assert.equal(roles.scribe.trust_status, 'trusted');
  });

  test('creates a CP-SMK-1 inform checkpoint on pass', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    const manifest = sm.readManifest();
    const smkInform = manifest.open_checkpoints.find(
      (c) => c.type === 'inform' && c.produced_by === 'runner' && c.affected_object_id === 'scribe',
    );
    assert(smkInform, 'CP-SMK-1 inform checkpoint must be created on pass');
  });

  test('records all case results in smoke_tests.yaml', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    const file = yaml.load(readFileSync(smokeTestsPath(tmpDir), 'utf8')) as Record<string, unknown>;
    const roles = file.roles as Record<string, Record<string, unknown>>;
    const cases = roles.scribe.cases as SmokeTestResult[];
    assert(cases.length >= 5, 'all SCR-ST1–ST5 cases must be recorded');
  });
});

describe('runSmokeTests — connectivity failure', () => {
  test('returns all_passed=false when connectivity case fails', async () => {
    const adapter = new ScenarioAdapter(false, {}, makeResponse(validScribeGatherWithGap));
    const result = await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    assert.equal(result.all_passed, false);
  });

  test('sets trust_status to blocked on failure', async () => {
    const adapter = new ScenarioAdapter(false, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    const file = yaml.load(readFileSync(smokeTestsPath(tmpDir), 'utf8')) as Record<string, unknown>;
    const roles = file.roles as Record<string, Record<string, unknown>>;
    assert.equal(roles.scribe.trust_status, 'blocked');
  });

  test('creates a CP-SMK-2 block checkpoint on failure', async () => {
    const adapter = new ScenarioAdapter(false, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    const manifest = sm.readManifest();
    const smkBlock = manifest.open_checkpoints.find(
      (c) => c.type === 'block' && c.produced_by === 'runner' && c.affected_object_id === 'scribe',
    );
    assert(smkBlock, 'CP-SMK-2 block checkpoint must be created on failure');
    assert.equal(smkBlock!.principle_ref, 'P2');
  });
});

describe('runSmokeTests — invoke error for non-connectivity case', () => {
  test('records failure when invoke throws for non-connectivity case', async () => {
    const adapter = new ScenarioAdapter(
      true, // connectivity passes
      { gather: new Error('Adapter temporarily unavailable') }, // invoke throws
      makeResponse({}),
    );
    const result = await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    assert.equal(result.all_passed, false);
    const failedCase = result.cases.find((c) => !c.passed && c.test_id !== 'SCR-ST1');
    assert(failedCase, 'a non-connectivity case must be marked failed');
    assert(failedCase!.failure_reason!.includes('Adapter temporarily unavailable'));
  });
});

describe('runSmokeTests — unknown role', () => {
  test('throws SmokeTestSpecNotFoundError for an unknown role', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse({}));
    await assert.rejects(
      () => runSmokeTests(tmpDir, sm, adapter, 'nonexistent_role'),
      SmokeTestSpecNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// readTrustStatus
// ---------------------------------------------------------------------------

describe('readTrustStatus', () => {
  test('returns untrusted when no smoke_tests.yaml exists', () => {
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'untrusted');
  });

  test('returns trusted after a successful run', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted');
  });

  test('returns blocked after a failed run', async () => {
    const adapter = new ScenarioAdapter(false, {}, makeResponse({}));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'blocked');
  });

  test('returns untrusted for a different role that has not been tested', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'architect'), 'untrusted');
  });
});

// ---------------------------------------------------------------------------
// applyLowTrustOverride
// ---------------------------------------------------------------------------

describe('applyLowTrustOverride', () => {
  test('sets trust_status to low-trust', async () => {
    const adapter = new ScenarioAdapter(false, {}, makeResponse({}));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    applyLowTrustOverride(tmpDir, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'low-trust');
  });

  test('creates a record for a role that has never been run', () => {
    applyLowTrustOverride(tmpDir, 'architect');
    assert.equal(readTrustStatus(tmpDir, 'architect'), 'low-trust');
  });

  test('does not affect other roles', async () => {
    const adapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, adapter, 'scribe');

    applyLowTrustOverride(tmpDir, 'architect');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted'); // scribe unchanged
  });
});

// ---------------------------------------------------------------------------
// Idempotency — second run overwrites first
// ---------------------------------------------------------------------------

describe('runSmokeTests — second run overwrites first', () => {
  test('second run updates trust status when result changes', async () => {
    const failingAdapter = new ScenarioAdapter(false, {}, makeResponse({}));
    await runSmokeTests(tmpDir, sm, failingAdapter, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'blocked');

    const passingAdapter = new ScenarioAdapter(true, {}, makeResponse(validScribeGatherWithGap));
    await runSmokeTests(tmpDir, sm, passingAdapter, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted');
  });
});
