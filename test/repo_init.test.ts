import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Adapter, AgentResponse, SmokeTestResult } from '../src/runner/adapters/interface.ts';
import { AdapterConnectionError, AdapterParseError } from '../src/runner/adapters/interface.ts';
import { RepoAlreadyInitialisedError } from '../src/runner/state/state_manager.ts';
import { SmokeTestBlockedError } from '../src/runner/smoke/runner.ts';
import type { OmoikaneConfig } from '../src/runner/config.ts';
import { runRepoInit } from '../src/cli/commands/repo.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validLearningBrief: Record<string, unknown> = {
  type: 'learning_brief',
  subject: 'Byzantine fault tolerance in distributed systems',
  goal: 'Understand how consensus is achieved when nodes may behave arbitrarily',
  prior_knowledge: 'Basic distributed systems knowledge; no prior fault tolerance theory',
  priority_angles: ['Practical consensus algorithms (PBFT)', 'Failure models and assumptions'],
  definition_of_done: 'Clear explanation of PBFT and its key assumptions',
  questions_asked: [
    {
      question: 'What is your primary focus area within fault tolerance?',
      answer: 'Practical consensus algorithms, specifically PBFT',
    },
  ],
};

const validOutline: Record<string, unknown> = {
  type: 'outline',
  version: 1,
  nodes: [
    {
      id: 'node-001',
      type: 'factual',
      title: 'Core definitions',
      description: 'Definitions of Byzantine faults and fault tolerance',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'node-002',
      type: 'contested',
      title: 'Performance trade-offs',
      description: 'Disputed claims about PBFT performance under load',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'node-003',
      type: 'gap_placeholder',
      title: 'Unknown aspects',
      description: 'Suspected gaps in available knowledge',
      parent_id: null,
      status: 'draft',
    },
  ],
  contested_or_edge_case_node_count: 1,
};

const validScribeGather: Record<string, unknown> = {
  type: 'document',
  outline_node_id: 'node-001',
  prompt_id: 'p-gather-1-001',
  prompt_generation: 1,
  date: '2026-05-25',
  claims: [
    {
      id: 'claim-001',
      type: 'factual',
      content: 'PBFT requires 3f+1 nodes to tolerate f Byzantine failures.',
      source: { tier: 'tier_1', fidelity: 'direct', citation: 'https://pmg.csail.mit.edu/papers/osdi99.pdf' },
      confidence: { level: 'high', basis: 'Primary source paper.' },
      status: 'active',
    },
  ],
  self_critique: {
    what_was_hard: 'Distinguishing PBFT from other BFT variants.',
    confidence_floor: 'High — based on primary source.',
    unresolved_questions: ['How does PBFT compare to HotStuff in practice?'],
  },
  signal_history: [],
  gap_documents: [
    { id: 'gap-001', nature: 'knowledge_ceiling', description: 'Implementation details unclear.', status: 'open' },
  ],
};

function makeResponse(parsed: Record<string, unknown>): AgentResponse {
  return { raw_text: JSON.stringify(parsed), parsed, model_id: 'mock-model' };
}

// ---------------------------------------------------------------------------
// Smart mock adapter — returns responses keyed by "role:command"
// ---------------------------------------------------------------------------

class SmartMockAdapter implements Adapter {
  constructor(
    private readonly responses: Map<string, AgentResponse>,
    private readonly connectivityPassed: boolean,
  ) {}

  async invoke(
    role: string,
    context: Record<string, unknown>,
    _constitution: string,
  ): Promise<AgentResponse> {
    const command = (context.command as string) ?? 'gather';
    const key = `${role}:${command}`;
    const resp = this.responses.get(key)
      ?? this.responses.get(`*:${command}`)
      ?? this.responses.get(`${role}:*`);
    if (!resp) throw new Error(`SmartMockAdapter: no response configured for "${key}"`);
    return resp;
  }

  async smoke_test(_role: string, test_case: Record<string, unknown>): Promise<SmokeTestResult> {
    const testId = (test_case.id as string) ?? 'unknown';
    if (this.connectivityPassed) return { test_id: testId, passed: true };
    return { test_id: testId, passed: false, failure_reason: 'Mock connectivity failure' };
  }

  get_model_id(): string { return 'mock-model'; }
  get_adapter_id(): string { return 'mock'; }
}

function defaultAdapter(connectivityPassed = true): SmartMockAdapter {
  const responses = new Map<string, AgentResponse>([
    ['architect:init', makeResponse(validLearningBrief)],
    ['architect:outline', makeResponse(validOutline)],
    ['scribe:gather', makeResponse(validScribeGather)],
  ]);
  return new SmartMockAdapter(responses, connectivityPassed);
}

// ---------------------------------------------------------------------------
// Prompt helper — returns answers in sequence
// ---------------------------------------------------------------------------

// subject, goal, prior_knowledge, priority_angles, definition_of_done, confirm
const INIT_ANSWERS_CONFIRM = [
  'Test subject',
  'Test goal',
  'none',
  'angle 1, angle 2',
  'Done when tested',
  'y',
];

const INIT_ANSWERS_CANCEL = [
  'Test subject',
  'Test goal',
  'none',
  'angle 1, angle 2',
  'Done when tested',
  'n',
];

function makePromptFn(answers: string[]): (q: string) => Promise<string> {
  let idx = 0;
  return (_q: string) => Promise.resolve(answers[idx++] ?? '');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-repo-init-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Already initialised
// ---------------------------------------------------------------------------

describe('runRepoInit — already initialised', () => {
  test('throws RepoAlreadyInitialisedError when manifest.yaml exists', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(join(tmpDir, 'manifest.yaml'), 'schema_version: "1.0"\n', 'utf8');

    const adapter = defaultAdapter();
    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory: () => adapter,
      }),
      RepoAlreadyInitialisedError,
    );
  });

  test('does not invoke the adapter when already initialised', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(join(tmpDir, 'manifest.yaml'), 'schema_version: "1.0"\n', 'utf8');

    let invokeCalled = false;
    const adapter: Adapter = {
      async invoke() { invokeCalled = true; return makeResponse(validLearningBrief); },
      async smoke_test(_r, tc) { return { test_id: (tc.id as string) ?? 'x', passed: true }; },
      get_model_id: () => 'mock',
      get_adapter_id: () => 'mock',
    };

    await assert.rejects(
      runRepoInit(tmpDir, { promptFn: makePromptFn(INIT_ANSWERS_CONFIRM), adapterFactory: () => adapter }),
    );
    assert.equal(invokeCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runRepoInit — happy path', () => {
  test('resolves without throwing', async () => {
    const adapter = defaultAdapter();
    await assert.doesNotReject(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory: () => adapter,
      }),
    );
  });

  test('writes manifest.yaml', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
      adapterFactory: () => adapter,
    });
    assert.ok(existsSync(join(tmpDir, 'manifest.yaml')));
  });

  test('writes learning_brief.yaml', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
      adapterFactory: () => adapter,
    });
    assert.ok(existsSync(join(tmpDir, 'learning_brief.yaml')));
  });

  test('creates bootstrap prompt files', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
      adapterFactory: () => adapter,
    });
    assert.ok(existsSync(join(tmpDir, 'prompts', 'p-init-1-001.yaml')));
    assert.ok(existsSync(join(tmpDir, 'prompts', 'p-outline-1-001.yaml')));
    assert.ok(existsSync(join(tmpDir, 'prompts', 'p-gather-1-001.yaml')));
  });

  test('writes default config when none exists', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
      adapterFactory: () => adapter,
    });
    assert.ok(existsSync(join(tmpDir, '.omoikane', 'config.yaml')));
  });

  test('writes smoke_tests.yaml', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
      adapterFactory: () => adapter,
    });
    assert.ok(existsSync(join(tmpDir, '.omoikane', 'smoke_tests.yaml')));
  });
});

// ---------------------------------------------------------------------------
// Validation failure
// ---------------------------------------------------------------------------

describe('runRepoInit — validation failure', () => {
  test('throws AdapterParseError when questions_asked is empty (ARC-OV1)', async () => {
    const invalidBrief = { ...validLearningBrief, questions_asked: [] };
    const responses = new Map<string, AgentResponse>([
      ['architect:init', makeResponse(invalidBrief)],
      ['architect:outline', makeResponse(validOutline)],
      ['scribe:gather', makeResponse(validScribeGather)],
    ]);
    const adapter = new SmartMockAdapter(responses, true);

    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory: () => adapter,
      }),
      AdapterParseError,
    );
  });

  test('does not write manifest.yaml on validation failure', async () => {
    const invalidBrief = { ...validLearningBrief, questions_asked: [] };
    const responses = new Map<string, AgentResponse>([
      ['architect:init', makeResponse(invalidBrief)],
      ['architect:outline', makeResponse(validOutline)],
      ['scribe:gather', makeResponse(validScribeGather)],
    ]);
    const adapter = new SmartMockAdapter(responses, true);

    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory: () => adapter,
      }),
    );
    assert.equal(existsSync(join(tmpDir, 'manifest.yaml')), false);
  });
});

// ---------------------------------------------------------------------------
// Connectivity error
// ---------------------------------------------------------------------------

describe('runRepoInit — connectivity error', () => {
  test('propagates AdapterConnectionError from invoke', async () => {
    const err = new AdapterConnectionError('Endpoint unreachable');
    const adapter: Adapter = {
      async invoke() { throw err; },
      async smoke_test(_r, tc) { return { test_id: (tc.id as string) ?? 'x', passed: true }; },
      get_model_id: () => 'mock',
      get_adapter_id: () => 'mock',
    };

    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory: () => adapter,
      }),
      AdapterConnectionError,
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke test blocked
// ---------------------------------------------------------------------------

describe('runRepoInit — smoke test blocked', () => {
  test('throws SmokeTestBlockedError when scribe connectivity fails', async () => {
    const goodAdapter = defaultAdapter(true);  // architect passes everything
    const badAdapter = defaultAdapter(false);  // scribe fails connectivity

    const adapterFactory = (role: string, _config: OmoikaneConfig): Adapter => {
      if (role === 'scribe') return badAdapter;
      return goodAdapter;
    };

    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory,
      }),
      SmokeTestBlockedError,
    );
  });

  test('writes manifest.yaml before smoke tests run', async () => {
    // Manifest is written before smoke tests; a blocked smoke test should NOT
    // prevent the manifest from existing (the repo is created, just not trusted).
    const goodAdapter = defaultAdapter(true);
    const badAdapter = defaultAdapter(false);

    const adapterFactory = (role: string, _config: OmoikaneConfig): Adapter => {
      if (role === 'scribe') return badAdapter;
      return goodAdapter;
    };

    await assert.rejects(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CONFIRM),
        adapterFactory,
      }),
    );
    assert.ok(existsSync(join(tmpDir, 'manifest.yaml')));
  });
});

// ---------------------------------------------------------------------------
// User cancels
// ---------------------------------------------------------------------------

describe('runRepoInit — user cancels', () => {
  test('resolves without throwing when researcher declines', async () => {
    const adapter = defaultAdapter();
    await assert.doesNotReject(
      runRepoInit(tmpDir, {
        promptFn: makePromptFn(INIT_ANSWERS_CANCEL),
        adapterFactory: () => adapter,
      }),
    );
  });

  test('does not write manifest.yaml when researcher declines', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CANCEL),
      adapterFactory: () => adapter,
    });
    assert.equal(existsSync(join(tmpDir, 'manifest.yaml')), false);
  });

  test('does not write learning_brief.yaml when researcher declines', async () => {
    const adapter = defaultAdapter();
    await runRepoInit(tmpDir, {
      promptFn: makePromptFn(INIT_ANSWERS_CANCEL),
      adapterFactory: () => adapter,
    });
    assert.equal(existsSync(join(tmpDir, 'learning_brief.yaml')), false);
  });
});
