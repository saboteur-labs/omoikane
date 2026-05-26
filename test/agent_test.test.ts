import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Adapter, AgentResponse, SmokeTestResult } from '../src/runner/adapters/interface.ts';
import { AdapterConnectionError } from '../src/runner/adapters/interface.ts';
import { StateManager } from '../src/runner/state/state_manager.ts';
import { readTrustStatus, SmokeTestBlockedError } from '../src/runner/smoke/runner.ts';
import { runAgentTest, type AgentTestOptions } from '../src/cli/commands/agent.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const validScribeGatherWithGap: Record<string, unknown> = {
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
  gap_documents: [
    { id: 'gap-001', nature: 'knowledge_ceiling', description: 'Exact count unknown.', status: 'open' },
  ],
};

function makeResponse(parsed: Record<string, unknown>): AgentResponse {
  return { raw_text: JSON.stringify(parsed), parsed, model_id: 'test-model' };
}

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

class MockAdapter implements Adapter {
  constructor(
    private readonly connectivityPassed: boolean,
    private readonly invokeResponse: AgentResponse | Error,
  ) {}

  async invoke(
    _role: string,
    _context: Record<string, unknown>,
    _constitution: string,
  ): Promise<AgentResponse> {
    if (this.invokeResponse instanceof Error) throw this.invokeResponse;
    return this.invokeResponse;
  }

  async smoke_test(_role: string, test_case: Record<string, unknown>): Promise<SmokeTestResult> {
    const testId = (test_case.id as string) ?? 'unknown';
    if (this.connectivityPassed) return { test_id: testId, passed: true };
    return { test_id: testId, passed: false, failure_reason: 'Connection refused' };
  }

  get_model_id(): string { return 'mock-model'; }
  get_adapter_id(): string { return 'mock'; }
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let sm: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-agent-test-'));
  sm = new StateManager(tmpDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// No-op promptFn — should not be called on untrusted/trusted paths
// ---------------------------------------------------------------------------

function noPrompt(): Promise<string> {
  throw new Error('promptFn called unexpectedly');
}

function confirmPrompt(): Promise<string> {
  return Promise.resolve('y');
}

function declinePrompt(): Promise<string> {
  return Promise.resolve('n');
}

const baseOptions: AgentTestOptions = {
  promptFn: noPrompt,
};

// ---------------------------------------------------------------------------
// Happy path — role passes, no prior trust record
// ---------------------------------------------------------------------------

describe('runAgentTest — passing smoke tests', () => {
  test('resolves without throwing when all cases pass', async () => {
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await assert.doesNotReject(runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions));
  });

  test('trust status is set to trusted after a pass', async () => {
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions);
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted');
  });

  test('does not call promptFn when role was untrusted (no prior run)', async () => {
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    let promptCalled = false;
    const options: AgentTestOptions = {
      promptFn: () => { promptCalled = true; return Promise.resolve('y'); },
    };
    await runAgentTest(tmpDir, sm, adapter, 'scribe', options);
    assert.equal(promptCalled, false);
  });
});

// ---------------------------------------------------------------------------
// Failure — smoke test fails
// ---------------------------------------------------------------------------

describe('runAgentTest — failing smoke tests', () => {
  test('throws SmokeTestBlockedError when connectivity fails', async () => {
    const adapter = new MockAdapter(false, makeResponse(validScribeGatherWithGap));
    await assert.rejects(
      runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions),
      SmokeTestBlockedError,
    );
  });

  test('throws SmokeTestBlockedError when invoke returns invalid response', async () => {
    const adapter = new MockAdapter(true, makeResponse({ type: 'document' }));
    await assert.rejects(
      runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions),
      SmokeTestBlockedError,
    );
  });

  test('trust status is blocked after failure', async () => {
    const adapter = new MockAdapter(false, makeResponse(validScribeGatherWithGap));
    await assert.rejects(runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions));
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'blocked');
  });
});

// ---------------------------------------------------------------------------
// Connectivity error — propagates when smoke_test() throws
// ---------------------------------------------------------------------------

class ThrowingConnectivityAdapter extends MockAdapter {
  constructor(private readonly connErr: Error) {
    super(false, makeResponse(validScribeGatherWithGap));
  }

  override async smoke_test(
    _role: string,
    _test_case: Record<string, unknown>,
  ): Promise<SmokeTestResult> {
    throw this.connErr;
  }
}

describe('runAgentTest — connectivity error', () => {
  test('AdapterConnectionError from smoke_test propagates without wrapping', async () => {
    const connErr = new AdapterConnectionError('Endpoint unreachable');
    const adapter = new ThrowingConnectivityAdapter(connErr);
    await assert.rejects(
      runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions),
      AdapterConnectionError,
    );
  });

  test('AdapterConnectionError from invoke is caught and becomes a blocked failure', async () => {
    const connErr = new AdapterConnectionError('Endpoint unreachable');
    const adapter = new MockAdapter(true, connErr);
    await assert.rejects(
      runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions),
      SmokeTestBlockedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Re-trust flow — prior low-trust, passes, prompts researcher
// ---------------------------------------------------------------------------

describe('runAgentTest — re-trust prompt after low-trust', () => {
  async function setupLowTrust(): Promise<void> {
    // Fail once to create blocked state, then override to low-trust
    const failAdapter = new MockAdapter(false, makeResponse(validScribeGatherWithGap));
    await assert.rejects(runAgentTest(tmpDir, sm, failAdapter, 'scribe', baseOptions));
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'blocked');

    // Manually apply low-trust override (simulates researcher overriding CP-SMK-2)
    const { applyLowTrustOverride } = await import('../src/runner/smoke/runner.ts');
    applyLowTrustOverride(tmpDir, 'scribe');
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'low-trust');
  }

  test('prompts for re-trust confirmation when prior status is low-trust', async () => {
    await setupLowTrust();

    let promptCalled = false;
    const options: AgentTestOptions = {
      promptFn: (q) => { promptCalled = true; assert.match(q, /low-trust/); return Promise.resolve('y'); },
    };
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', options);
    assert.equal(promptCalled, true);
  });

  test('clears low-trust flag when researcher confirms re-trust', async () => {
    await setupLowTrust();
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', { promptFn: confirmPrompt });
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted');
  });

  test('keeps low-trust when researcher declines re-trust', async () => {
    await setupLowTrust();
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', { promptFn: declinePrompt });
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'low-trust');
  });
});

// ---------------------------------------------------------------------------
// Re-trust flow — prior blocked (not overridden), passes, prompts researcher
// ---------------------------------------------------------------------------

describe('runAgentTest — re-trust prompt after blocked', () => {
  async function setupBlocked(): Promise<void> {
    const failAdapter = new MockAdapter(false, makeResponse(validScribeGatherWithGap));
    await assert.rejects(runAgentTest(tmpDir, sm, failAdapter, 'scribe', baseOptions));
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'blocked');
  }

  test('prompts for re-trust when prior status is blocked', async () => {
    await setupBlocked();

    let promptCalled = false;
    const options: AgentTestOptions = {
      promptFn: (q) => { promptCalled = true; assert.match(q, /blocked/); return Promise.resolve('y'); },
    };
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', options);
    assert.equal(promptCalled, true);
  });

  test('clears blocked flag when researcher confirms re-trust', async () => {
    await setupBlocked();
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', { promptFn: confirmPrompt });
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'trusted');
  });

  test('sets low-trust when researcher declines re-trust from blocked', async () => {
    await setupBlocked();
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    await runAgentTest(tmpDir, sm, adapter, 'scribe', { promptFn: declinePrompt });
    assert.equal(readTrustStatus(tmpDir, 'scribe'), 'low-trust');
  });
});

// ---------------------------------------------------------------------------
// Already trusted — no prompt
// ---------------------------------------------------------------------------

describe('runAgentTest — already trusted', () => {
  test('does not prompt when role was already trusted', async () => {
    const adapter = new MockAdapter(true, makeResponse(validScribeGatherWithGap));
    // First run to establish trusted status
    await runAgentTest(tmpDir, sm, adapter, 'scribe', baseOptions);
    // Second run — should not prompt
    let promptCalled = false;
    await runAgentTest(tmpDir, sm, adapter, 'scribe', {
      promptFn: () => { promptCalled = true; return Promise.resolve('y'); },
    });
    assert.equal(promptCalled, false);
  });
});
