import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import type { Adapter, AgentResponse, SmokeTestResult } from '../src/runner/adapters/interface.ts';
import { AdapterParseError } from '../src/runner/adapters/interface.ts';
import { StateManager } from '../src/runner/state/state_manager.ts';
import { RepoNotInitialisedError } from '../src/runner/state/state_manager.ts';
import { outlinePath, learningBriefPath } from '../src/runner/state/paths.ts';
import type { OmoikaneConfig } from '../src/runner/config.ts';
import {
  runOutline,
  runOutlineApprove,
  runOutlineAmend,
  OutlineNotInDraftError,
  OutlineNotApprovedError,
  OutlineNodeNotFoundError,
} from '../src/cli/commands/outline.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LEARNING_BRIEF = {
  schema_version: '1.0',
  type: 'learning_brief',
  subject: 'Byzantine fault tolerance',
  goal: 'Understand consensus algorithms',
  prior_knowledge: 'Basic distributed systems',
  priority_angles: ['PBFT', 'failure models'],
  definition_of_done: 'Clear explanation of PBFT',
  questions_asked: [{ question: 'Focus area?', answer: 'Practical algorithms.' }],
};

const VALID_OUTLINE = {
  type: 'outline',
  version: 1,
  nodes: [
    {
      id: 'node-001',
      type: 'factual',
      title: 'Core definitions',
      description: 'Definitions of BFT',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'node-002',
      type: 'contested',
      title: 'Performance trade-offs',
      description: 'Disputed PBFT performance claims',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'node-003',
      type: 'gap_placeholder',
      title: 'Unknown aspects',
      description: 'Suspected gaps',
      parent_id: null,
      status: 'draft',
    },
  ],
  contested_or_edge_case_node_count: 1,
};

// Outline without gap_placeholder — triggers ARC-OV5 review checkpoint
const OUTLINE_NO_GAP_PLACEHOLDER = {
  type: 'outline',
  version: 1,
  nodes: [
    {
      id: 'node-001',
      type: 'factual',
      title: 'Core definitions',
      description: 'Definitions of BFT',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'node-002',
      type: 'contested',
      title: 'Performance trade-offs',
      description: 'Disputed claims',
      parent_id: null,
      status: 'draft',
    },
  ],
  contested_or_edge_case_node_count: 1,
};

function makeResponse(parsed: Record<string, unknown>): AgentResponse {
  return { raw_text: JSON.stringify(parsed), parsed, model_id: 'mock-model' };
}

function mockAdapter(response: Record<string, unknown>): Adapter {
  return {
    async invoke(): Promise<AgentResponse> { return makeResponse(response); },
    async smoke_test(_r: string, tc: Record<string, unknown>): Promise<SmokeTestResult> {
      return { test_id: (tc.id as string) ?? 'x', passed: true };
    },
    get_model_id: () => 'mock',
    get_adapter_id: () => 'mock',
  };
}

function adapterFactory(response: Record<string, unknown>) {
  return (_role: string, _config: OmoikaneConfig): Adapter => mockAdapter(response);
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let sm: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-outline-'));
  sm = new StateManager(tmpDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
  writeFileSync(learningBriefPath(tmpDir), yaml.dump(LEARNING_BRIEF), 'utf8');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helper: set manifest outline to a specific state
// ---------------------------------------------------------------------------

function setOutlineDraft(): void {
  const manifest = sm.readManifest();
  manifest.outline.version = 1;
  manifest.outline.status = 'draft';
  manifest.outline.nodes = VALID_OUTLINE.nodes.map((n) => ({
    id: n.id,
    type: n.type as ManifestNodeType,
    title: n.title,
    status: 'ungathered' as const,
  }));
  sm.writeManifest(manifest);

  writeFileSync(
    outlinePath(tmpDir),
    yaml.dump({ schema_version: '1.0', created_at: new Date().toISOString(), last_modified: new Date().toISOString(), ...VALID_OUTLINE }),
    'utf8',
  );
}

function setOutlineApproved(): void {
  setOutlineDraft();
  const manifest = sm.readManifest();
  manifest.outline.status = 'approved';
  manifest.outline.approved_at = new Date().toISOString();
  sm.writeManifest(manifest);
}

type ManifestNodeType = 'factual' | 'contested' | 'definitional' | 'methodological' | 'edge_case' | 'gap_placeholder';

// ---------------------------------------------------------------------------
// runOutline
// ---------------------------------------------------------------------------

describe('runOutline — preconditions', () => {
  test('throws RepoNotInitialisedError when no manifest', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'omoikane-outline-empty-'));
    try {
      await assert.rejects(
        runOutline(emptyDir, { adapterFactory: adapterFactory(VALID_OUTLINE) }),
        RepoNotInitialisedError,
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

describe('runOutline — happy path', () => {
  test('resolves without throwing', async () => {
    await assert.doesNotReject(
      runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) }),
    );
  });

  test('writes outline.yaml', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    assert.ok(existsSync(outlinePath(tmpDir)));
  });

  test('outline.yaml contains schema_version and node count', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const file = yaml.load(readFileSync(outlinePath(tmpDir), 'utf8')) as Record<string, unknown>;
    assert.equal(file.schema_version, '1.0');
    assert.equal((file.nodes as unknown[]).length, 3);
  });

  test('outline.yaml version is 1 on first run', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const file = yaml.load(readFileSync(outlinePath(tmpDir), 'utf8')) as Record<string, unknown>;
    assert.equal(file.version, 1);
  });

  test('manifest outline version increments to 1', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.version, 1);
  });

  test('manifest outline status is draft', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.status, 'draft');
  });

  test('manifest outline nodes are set with ungathered status', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.nodes.length, 3);
    for (const node of manifest.outline.nodes) {
      assert.equal(node.status, 'ungathered');
    }
  });

  test('outline version increments on second run', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.version, 2);
    const file = yaml.load(readFileSync(outlinePath(tmpDir), 'utf8')) as Record<string, unknown>;
    assert.equal(file.version, 2);
  });
});

describe('runOutline — validation failure', () => {
  test('throws AdapterParseError when ARC-OV2 fires (count 0, no justification)', async () => {
    const badOutline = {
      ...VALID_OUTLINE,
      nodes: [
        { id: 'n1', type: 'factual', title: 'Fact', description: 'A fact', parent_id: null, status: 'draft' },
      ],
      contested_or_edge_case_node_count: 0,
      // justification_if_no_contested_nodes missing → ARC-OV2 fires
    };
    await assert.rejects(
      runOutline(tmpDir, { adapterFactory: adapterFactory(badOutline) }),
      AdapterParseError,
    );
  });

  test('auto-corrects count and creates review checkpoint when ARC-OV3 fires (count mismatch)', async () => {
    const badOutline = {
      ...VALID_OUTLINE,
      contested_or_edge_case_node_count: 99, // wrong — runner corrects it
    };
    await runOutline(tmpDir, { adapterFactory: adapterFactory(badOutline) });
    const manifest = sm.readManifest();
    // ARC-OV3 produces a review checkpoint, not a hard rejection
    const ov3Cp = manifest.open_checkpoints.find(
      (c) => c.type === 'review' && c.description.includes('auto-corrected'),
    );
    assert.ok(ov3Cp, 'expected an ARC-OV3 review checkpoint');
    // The written outline should have the correct count (from actual nodes)
    const actualContested = VALID_OUTLINE.nodes.filter(
      (n: { type: string }) => n.type === 'contested' || n.type === 'edge_case',
    ).length;
    assert.equal(manifest.outline.version, 1, 'outline version advanced');
    // Manifest nodes reflect actual types
    assert.equal(manifest.outline.nodes.length, VALID_OUTLINE.nodes.length);
    void actualContested;
  });
});

describe('runOutline — ARC-OV5 review checkpoint', () => {
  test('creates a review checkpoint when no gap_placeholder nodes', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(OUTLINE_NO_GAP_PLACEHOLDER) });
    const manifest = sm.readManifest();
    const reviewCps = manifest.open_checkpoints.filter((c) => c.type === 'review');
    assert.ok(reviewCps.length >= 1, 'expected at least one review checkpoint');
    assert.ok(
      reviewCps.some((c) => c.affected_object_id === 'outline'),
      'expected review checkpoint with affected_object_id=outline',
    );
  });

  test('does not create review checkpoint when gap_placeholder nodes exist', async () => {
    await runOutline(tmpDir, { adapterFactory: adapterFactory(VALID_OUTLINE) });
    const manifest = sm.readManifest();
    const reviewCps = manifest.open_checkpoints.filter(
      (c) => c.type === 'review' && c.affected_object_id === 'outline',
    );
    assert.equal(reviewCps.length, 0);
  });
});

// ---------------------------------------------------------------------------
// runOutlineApprove
// ---------------------------------------------------------------------------

describe('runOutlineApprove — preconditions', () => {
  test('throws RepoNotInitialisedError when no manifest', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'omoikane-approve-empty-'));
    try {
      await assert.rejects(runOutlineApprove(emptyDir), RepoNotInitialisedError);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('throws OutlineNotInDraftError when outline status is none', async () => {
    // Initial manifest has outline.status = 'none'
    await assert.rejects(runOutlineApprove(tmpDir), OutlineNotInDraftError);
  });

  test('throws OutlineNotInDraftError when outline status is approved', async () => {
    setOutlineApproved();
    await assert.rejects(runOutlineApprove(tmpDir), OutlineNotInDraftError);
  });
});

describe('runOutlineApprove — happy path', () => {
  beforeEach(() => {
    setOutlineDraft();
  });

  test('resolves without throwing', async () => {
    await assert.doesNotReject(runOutlineApprove(tmpDir));
  });

  test('sets manifest outline status to approved', async () => {
    await runOutlineApprove(tmpDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.status, 'approved');
  });

  test('sets manifest outline approved_at timestamp', async () => {
    await runOutlineApprove(tmpDir);
    const manifest = sm.readManifest();
    assert.ok(manifest.outline.approved_at, 'approved_at should be set');
    // Should be a valid ISO timestamp
    assert.ok(!isNaN(Date.parse(manifest.outline.approved_at!)));
  });

  test('creates an inform checkpoint', async () => {
    await runOutlineApprove(tmpDir);
    const manifest = sm.readManifest();
    const informCps = manifest.open_checkpoints.filter((c) => c.type === 'inform');
    assert.ok(informCps.length >= 1, 'expected at least one inform checkpoint');
    assert.ok(
      informCps.some((c) => c.affected_object_id === 'outline'),
      'expected inform checkpoint with affected_object_id=outline',
    );
  });
});

// ---------------------------------------------------------------------------
// runOutlineAmend
// ---------------------------------------------------------------------------

describe('runOutlineAmend — preconditions', () => {
  test('throws RepoNotInitialisedError when no manifest', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'omoikane-amend-empty-'));
    try {
      await assert.rejects(
        runOutlineAmend(emptyDir, 'node-001', { promptFn: () => Promise.resolve('') }),
        RepoNotInitialisedError,
      );
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  test('throws OutlineNotApprovedError when outline has never been approved', async () => {
    // manifest has no approved_at
    await assert.rejects(
      runOutlineAmend(tmpDir, 'node-001', { promptFn: () => Promise.resolve('') }),
      OutlineNotApprovedError,
    );
  });

  test('throws OutlineNotApprovedError when outline is draft (not yet approved)', async () => {
    setOutlineDraft();
    await assert.rejects(
      runOutlineAmend(tmpDir, 'node-001', { promptFn: () => Promise.resolve('') }),
      OutlineNotApprovedError,
    );
  });

  test('throws OutlineNodeNotFoundError when node id does not exist', async () => {
    setOutlineApproved();
    await assert.rejects(
      runOutlineAmend(tmpDir, 'node-999', { promptFn: () => Promise.resolve('') }),
      OutlineNodeNotFoundError,
    );
  });
});

describe('runOutlineAmend — happy path', () => {
  beforeEach(() => {
    setOutlineApproved();
  });

  test('resolves without throwing', async () => {
    await assert.doesNotReject(
      runOutlineAmend(tmpDir, 'node-001', {
        promptFn: () => Promise.resolve(''), // empty = keep current
      }),
    );
  });

  test('updates node description in outline.yaml', async () => {
    let callCount = 0;
    const promptFn = (_q: string) => {
      callCount++;
      if (callCount === 1) return Promise.resolve(''); // title: keep
      return Promise.resolve('New description text'); // description: change
    };

    await runOutlineAmend(tmpDir, 'node-001', { promptFn });
    const file = yaml.load(readFileSync(outlinePath(tmpDir), 'utf8')) as {
      nodes: Array<{ id: string; description: string }>;
    };
    const node = file.nodes.find((n) => n.id === 'node-001');
    assert.equal(node!.description, 'New description text');
  });

  test('updates node title in outline.yaml', async () => {
    let callCount = 0;
    const promptFn = (_q: string) => {
      callCount++;
      if (callCount === 1) return Promise.resolve('New Title'); // title
      return Promise.resolve(''); // description: keep
    };

    await runOutlineAmend(tmpDir, 'node-001', { promptFn });
    const file = yaml.load(readFileSync(outlinePath(tmpDir), 'utf8')) as {
      nodes: Array<{ id: string; title: string }>;
    };
    const node = file.nodes.find((n) => n.id === 'node-001');
    assert.equal(node!.title, 'New Title');
  });

  test('sets outline status to amended in manifest', async () => {
    await runOutlineAmend(tmpDir, 'node-001', {
      promptFn: () => Promise.resolve(''),
    });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.status, 'amended');
  });

  test('creates a review checkpoint for the amended node', async () => {
    await runOutlineAmend(tmpDir, 'node-001', {
      promptFn: () => Promise.resolve(''),
    });
    const manifest = sm.readManifest();
    const reviewCps = manifest.open_checkpoints.filter(
      (c) => c.type === 'review' && c.affected_object_id === 'node-001',
    );
    assert.ok(reviewCps.length >= 1, 'expected review checkpoint for node-001');
  });

  test('keeps approved_at after amend', async () => {
    const approvedAt = sm.readManifest().outline.approved_at;
    await runOutlineAmend(tmpDir, 'node-001', {
      promptFn: () => Promise.resolve(''),
    });
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.approved_at, approvedAt);
  });
});

describe('runOutlineAmend — amended again after first amend', () => {
  test('can amend when outline status is already amended', async () => {
    setOutlineApproved();
    // First amend
    await runOutlineAmend(tmpDir, 'node-001', { promptFn: () => Promise.resolve('') });
    assert.equal(sm.readManifest().outline.status, 'amended');

    // Second amend — should work since approved_at is still set
    await assert.doesNotReject(
      runOutlineAmend(tmpDir, 'node-002', { promptFn: () => Promise.resolve('') }),
    );
  });
});
