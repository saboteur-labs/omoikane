import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { StateManager } from '../src/runner/state/state_manager.ts';
import {
  runGather,
  runGatherNext,
  GatherOutlineNotReadyError,
  GatherNodeNotFoundError,
  GatherNodeNotGatherableError,
  GatherNodeBlockedError,
  GatherNothingTodoError,
  GatherPromptNotFoundError,
} from '../src/runner/gather_pipeline.ts';
import { createCheckpoint } from '../src/runner/checkpoints/registry.ts';
import { AdapterParseError } from '../src/runner/adapters/interface.ts';
import type { Adapter, AgentResponse, SmokeTestResult } from '../src/runner/adapters/interface.ts';
import type { OmoikaneConfig } from '../src/runner/config.ts';
import { smokeTestsPath, outlinePath, learningBriefPath } from '../src/runner/state/paths.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return mkdtempSync(join('/tmp', 'omoikane-gather-'));
}

function makeAdapter(response: Record<string, unknown>): (role: string, config: OmoikaneConfig) => Adapter {
  return () => ({
    async invoke(_role: string, _ctx: Record<string, unknown>): Promise<AgentResponse> {
      return {
        raw_text: yaml.dump(response),
        parsed: response,
        model_id: 'mock-model',
        token_usage: { input_tokens: 0, output_tokens: 0 },
      };
    },
    async smoke_test(): Promise<SmokeTestResult> {
      return { test_id: 'mock', passed: true };
    },
    get_model_id(): string { return 'mock-model'; },
    get_adapter_id(): string { return 'mock-adapter'; },
  });
}

function makeFailingAdapter(err: Error): (role: string, config: OmoikaneConfig) => Adapter {
  return () => ({
    async invoke(): Promise<AgentResponse> { throw err; },
    async smoke_test(): Promise<SmokeTestResult> { return { test_id: 'mock', passed: true }; },
    get_model_id(): string { return 'mock-model'; },
    get_adapter_id(): string { return 'mock-adapter'; },
  });
}

function writeSmokeFile(repoDir: string, role: string, trust: string): void {
  const data = {
    schema_version: '1.0',
    roles: {
      [role]: {
        trust_status: trust,
        last_run_at: new Date().toISOString(),
        last_run_adapter: 'mock',
        last_run_model: 'mock',
        cases: [],
      },
    },
  };
  writeFileSync(smokeTestsPath(repoDir), yaml.dump(data), 'utf8');
}

function writeBootstrapPrompt(repoDir: string): void {
  const promptsDir = join(repoDir, 'prompts');
  mkdirSync(promptsDir, { recursive: true });
  const entry = {
    schema_version: '1.0',
    type: 'prompt_entry',
    id: 'p-gather-1-001',
    prompt_type: 'gather',
    status: 'active',
    generation: 1,
    question: 'Gather content for this node.',
    rationale: 'Bootstrap prompt.',
    performance: { last_used: new Date().toISOString(), run_count: 0, produced_sources: 0, confidence_delta: 0, user_rating: 0 },
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(promptsDir, 'p-gather-1-001.yaml'), yaml.dump(entry), 'utf8');
}

function writeOutlineFile(repoDir: string, nodeId = 'node-001'): void {
  const outline = {
    schema_version: '1.0',
    created_at: new Date().toISOString(),
    last_modified: new Date().toISOString(),
    type: 'factual',
    version: 1,
    nodes: [{
      id: nodeId,
      type: 'factual',
      title: 'Test Node',
      description: 'A test outline node.',
      parent_id: null,
      status: 'ungathered',
    }],
    contested_or_edge_case_node_count: 0,
  };
  writeFileSync(outlinePath(repoDir), yaml.dump(outline), 'utf8');
}

function writeLearningBrief(repoDir: string): void {
  const brief = {
    schema_version: '1.0',
    subject: 'Test Subject',
    goal: 'Learn about test subject.',
    prior_knowledge: 'None.',
  };
  writeFileSync(learningBriefPath(repoDir), yaml.dump(brief), 'utf8');
}

function validScribeOutput(nodeId = 'node-001'): Record<string, unknown> {
  return {
    type: 'document',
    outline_node_id: nodeId,
    prompt_id: 'p-gather-1-001',
    prompt_generation: 1,
    date: new Date().toISOString(),
    claims: [{
      id: 'claim-001',
      type: 'factual',
      content: 'Test claim content.',
      source: { tier: 'tier_3', fidelity: 'direct' },
      confidence: { level: 'medium', basis: 'Model knowledge.' },
      status: 'active',
    }],
    self_critique: {
      what_was_hard: 'Finding primary sources.',
      confidence_floor: 'Medium confidence overall.',
      unresolved_questions: ['What is the primary source for this claim?'],
    },
  };
}

// Set up an approved repo with one ungathered node
function setupApprovedRepo(repoDir: string, nodeId = 'node-001'): StateManager {
  const sm = new StateManager(repoDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
  writeLearningBrief(repoDir);
  writeOutlineFile(repoDir, nodeId);
  writeBootstrapPrompt(repoDir);
  writeSmokeFile(repoDir, 'scribe', 'trusted');

  const manifest = sm.readManifest();
  manifest.outline.version = 1;
  manifest.outline.status = 'approved';
  manifest.outline.approved_at = new Date().toISOString();
  manifest.outline.nodes = [{
    id: nodeId,
    type: 'factual',
    title: 'Test Node',
    status: 'ungathered',
  }];
  sm.writeManifest(manifest);
  return sm;
}

// ---------------------------------------------------------------------------
// Precondition tests
// ---------------------------------------------------------------------------

describe('runGather preconditions', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('outline not approved → GatherOutlineNotReadyError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test', 'learning_brief.yaml');
    // outline.status is 'none' after init
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherOutlineNotReadyError,
    );
  });

  test('outline in draft → GatherOutlineNotReadyError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test', 'learning_brief.yaml');
    const manifest = sm.readManifest();
    manifest.outline.status = 'draft';
    sm.writeManifest(manifest);
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherOutlineNotReadyError,
    );
  });

  test('node not found → GatherNodeNotFoundError', async () => {
    setupApprovedRepo(repoDir);
    await assert.rejects(
      () => runGather(repoDir, 'nonexistent-node', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherNodeNotFoundError,
    );
  });

  test('node already gathered → GatherNodeNotGatherableError', async () => {
    const sm = setupApprovedRepo(repoDir);
    const manifest = sm.readManifest();
    manifest.outline.nodes[0].status = 'gathered';
    sm.writeManifest(manifest);
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherNodeNotGatherableError,
    );
  });

  test('node blocked → GatherNodeBlockedError', async () => {
    const sm = setupApprovedRepo(repoDir);
    createCheckpoint(repoDir, sm, {
      prefix: 'TST',
      type: 'block',
      produced_by: 'runner',
      affected_object_id: 'node-001',
      description: 'Test block.',
    });
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherNodeBlockedError,
    );
  });

  test('prompt not found → GatherPromptNotFoundError', async () => {
    setupApprovedRepo(repoDir);
    await assert.rejects(
      () => runGather(repoDir, 'node-001', 'p-gather-9-999', { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherPromptNotFoundError,
    );
  });

  test('no active gather prompts → GatherPromptNotFoundError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    writeLearningBrief(repoDir);
    writeOutlineFile(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'trusted');
    // Do NOT write bootstrap prompt
    const manifest = sm.readManifest();
    manifest.outline.version = 1;
    manifest.outline.status = 'approved';
    manifest.outline.approved_at = new Date().toISOString();
    manifest.outline.nodes = [{ id: 'node-001', type: 'factual', title: 'T', status: 'ungathered' }];
    sm.writeManifest(manifest);

    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherPromptNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('runGather happy path', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('writes document with correct structure', async () => {
    setupApprovedRepo(repoDir);
    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();

    assert.equal(manifest.documents.length, 1);
    const doc = manifest.documents[0];
    assert.equal(doc.outline_node_id, 'node-001');
    assert.equal(doc.status, 'active');
    assert.equal(doc.prompt_id, 'p-gather-1-001');
    assert.equal(doc.prompt_generation, 1);
    assert.equal(doc.adapter, 'mock-adapter');
    assert.equal(doc.model, 'mock-model');
    assert.match(doc.document_id, /^doc-node-001-/);
  });

  test('node status advances to gathered', async () => {
    setupApprovedRepo(repoDir);
    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.nodes[0].status, 'gathered');
  });

  test('document YAML written with provenance and signal_history', async () => {
    setupApprovedRepo(repoDir);
    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    const docId = manifest.documents[0].document_id;

    // Read the written document file
    const docDir = join(repoDir, 'documents', 'node-001');
    assert(existsSync(docDir), 'documents/node-001 directory should exist');
    const files = readdirSync(docDir);
    assert.equal(files.length, 1);
    const docContent = yaml.load(
      readFileSync(join(docDir, files[0]), 'utf8'),
    ) as Record<string, unknown>;

    assert.equal(docContent.id, docId);
    assert.equal(docContent.type, 'document');
    assert.equal(docContent.outline_node_id, 'node-001');
    assert.equal(docContent.status, 'active');
    assert.equal(docContent.staleness_flag, false);
    assert.equal(docContent.re_gather_candidate, false);
    assert.ok(Array.isArray(docContent.signal_history));
    assert.equal((docContent.signal_history as unknown[]).length, 0);

    const prov = docContent.provenance as Record<string, unknown>;
    assert.equal(prov.prompt_id, 'p-gather-1-001');
    assert.equal(prov.adapter, 'mock-adapter');
    assert.equal(prov.model, 'mock-model');
    const mix = prov.source_tier_mix as Record<string, number>;
    assert.equal(mix.tier_1, 0);
    assert.equal(mix.tier_2, 0);
    assert.equal(mix.tier_3, 1);
  });

  test('--prompt override loads specific prompt', async () => {
    const sm = setupApprovedRepo(repoDir);

    // Write a second prompt
    const alt = {
      schema_version: '1.0', type: 'prompt_entry', id: 'p-gather-2-001',
      prompt_type: 'gather', status: 'active', generation: 2,
      question: 'Alt prompt.', rationale: 'Alt.',
      performance: { last_used: new Date().toISOString(), run_count: 0, produced_sources: 0, confidence_delta: 0, user_rating: 0 },
      created_at: new Date().toISOString(),
    };
    writeFileSync(join(repoDir, 'prompts', 'p-gather-2-001.yaml'), yaml.dump(alt), 'utf8');

    await runGather(repoDir, 'node-001', 'p-gather-2-001', { adapterFactory: makeAdapter(validScribeOutput()) });

    const manifest = sm.readManifest();
    assert.equal(manifest.documents[0].prompt_id, 'p-gather-2-001');
    assert.equal(manifest.documents[0].prompt_generation, 2);
  });

  test('stale node can be re-gathered', async () => {
    const sm = setupApprovedRepo(repoDir);
    const manifest = sm.readManifest();
    manifest.outline.nodes[0].status = 'stale';
    sm.writeManifest(manifest);

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const manifest2 = sm.readManifest();
    assert.equal(manifest2.outline.nodes[0].status, 'gathered');
  });

  test('supersedes existing active document', async () => {
    setupApprovedRepo(repoDir);

    // First gather
    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    // Make node stale so it can be gathered again
    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    manifest.outline.nodes[0].status = 'stale';
    sm.writeManifest(manifest);

    // Second gather
    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()), date: '20260526' });

    const manifest2 = sm.readManifest();
    assert.equal(manifest2.documents.length, 2);

    const superseded = manifest2.documents.find((d) => d.status === 'superseded');
    const active = manifest2.documents.find((d) => d.status === 'active');
    assert.ok(superseded, 'should have a superseded document');
    assert.ok(active, 'should have an active document');
    assert.equal(superseded!.superseded_by, active!.document_id);
  });
});

// ---------------------------------------------------------------------------
// Validation failure
// ---------------------------------------------------------------------------

describe('runGather validation failure', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('empty unresolved_questions → AdapterParseError (SCR-OV1)', async () => {
    setupApprovedRepo(repoDir);
    const badOutput = {
      ...validScribeOutput(),
      self_critique: {
        what_was_hard: 'Nothing.',
        confidence_floor: 'High.',
        unresolved_questions: [], // violates SCR-OV1
      },
    };
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(badOutput) }),
      AdapterParseError,
    );
  });

  test('document not written on validation failure', async () => {
    setupApprovedRepo(repoDir);
    const badOutput = {
      ...validScribeOutput(),
      claims: [{
        id: 'c-001',
        type: 'factual',
        content: 'Test.',
        source: { tier: 'tier_1', fidelity: 'direct' }, // tier_1 without citation → SCR-OV2
        confidence: { level: 'medium', basis: 'Basis.' },
        status: 'active',
      }],
    };
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(badOutput) }),
      AdapterParseError,
    );

    const docDir = join(repoDir, 'documents', 'node-001');
    assert(!existsSync(docDir), 'documents/ should not be written on validation failure');

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.documents.length, 0, 'manifest should not register a document');
    assert.equal(manifest.outline.nodes[0].status, 'ungathered', 'node status should not change');
  });

  test('missing claims → AdapterParseError (structural)', async () => {
    setupApprovedRepo(repoDir);
    const badOutput = { ...validScribeOutput(), claims: undefined };
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(badOutput) }),
      AdapterParseError,
    );
  });
});

// ---------------------------------------------------------------------------
// Gap documents
// ---------------------------------------------------------------------------

describe('runGather gap documents', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('gaps written to gaps/ and registered in manifest', async () => {
    setupApprovedRepo(repoDir);
    const outputWithGap = {
      ...validScribeOutput(),
      gap_documents: [{
        id: 'gap-001',
        nature: 'knowledge_ceiling',
        description: 'Could not find primary sources.',
        status: 'open',
      }],
    };

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(outputWithGap) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();

    assert.equal(manifest.known_gaps.length, 1);
    assert.match(manifest.known_gaps[0].gap_id, /^gap-/);
    assert.equal(manifest.known_gaps[0].nature, 'knowledge_ceiling');
    assert.equal(manifest.known_gaps[0].outline_node_id, 'node-001');
    assert.equal(manifest.known_gaps[0].status, 'open');

    // Verify gap file exists
    const gapsDir = join(repoDir, 'gaps');
    assert(existsSync(gapsDir), 'gaps/ directory should exist');
    const gapFiles = readdirSync(gapsDir);
    assert.equal(gapFiles.length, 1);
  });

  test('gap creates CP-SCR-2 review checkpoint', async () => {
    setupApprovedRepo(repoDir);
    const outputWithGap = {
      ...validScribeOutput(),
      gap_documents: [{
        id: 'gap-001',
        nature: 'source_absence',
        description: 'No sources found.',
        status: 'open',
      }],
    };

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(outputWithGap) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();

    const gapCheckpoints = manifest.open_checkpoints.filter(
      (c) => c.type === 'review' && c.produced_by === 'runner',
    );
    assert.ok(gapCheckpoints.length >= 1, 'at least one review checkpoint for gap');
    assert.match(gapCheckpoints[0].checkpoint_id, /^CP-SCR-/);
  });

  test('document gap_documents field contains {gap_id, nature} references', async () => {
    setupApprovedRepo(repoDir);
    const outputWithGap = {
      ...validScribeOutput(),
      gap_documents: [{
        id: 'gap-001',
        nature: 'contested_foundation',
        description: 'Contested.',
        status: 'open',
      }],
    };

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(outputWithGap) });

    const docDir = join(repoDir, 'documents', 'node-001');
    const docFiles = readdirSync(docDir);
    assert.equal(docFiles.length, 1);
    const docContent = yaml.load(readFileSync(join(docDir, docFiles[0]), 'utf8')) as Record<string, unknown>;

    const docGaps = docContent.gap_documents as Array<{ gap_id: string; nature: string }>;
    assert.ok(Array.isArray(docGaps) && docGaps.length === 1);
    assert.match(docGaps[0].gap_id, /^gap-/);
    assert.equal(docGaps[0].nature, 'contested_foundation');
  });

  test('multiple gaps create multiple CP-SCR checkpoints', async () => {
    setupApprovedRepo(repoDir);
    const outputWithGaps = {
      ...validScribeOutput(),
      gap_documents: [
        { id: 'gap-001', nature: 'knowledge_ceiling', description: 'Gap 1.', status: 'open' },
        { id: 'gap-002', nature: 'source_absence', description: 'Gap 2.', status: 'open' },
      ],
    };

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(outputWithGaps) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();

    assert.equal(manifest.known_gaps.length, 2);
    const scrCheckpoints = manifest.open_checkpoints.filter((c) => c.checkpoint_id.startsWith('CP-SCR-'));
    assert.ok(scrCheckpoints.length >= 2);

    const gapFiles = readdirSync(join(repoDir, 'gaps'));
    assert.equal(gapFiles.length, 2);
  });
});

// ---------------------------------------------------------------------------
// Low-trust path
// ---------------------------------------------------------------------------

describe('runGather low-trust', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('low-trust adapter → document status low-trust', async () => {
    setupApprovedRepo(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'low-trust');

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.documents[0].status, 'low-trust');
  });

  test('low-trust → CP-SCR-3 review checkpoint', async () => {
    setupApprovedRepo(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'low-trust');

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();

    const ltCheckpoints = manifest.open_checkpoints.filter(
      (c) => c.type === 'review' && c.description.includes('low-trust'),
    );
    assert.ok(ltCheckpoints.length >= 1, 'should have a low-trust review checkpoint');
  });

  test('untrusted scribe → node still advances to gathered', async () => {
    setupApprovedRepo(repoDir);
    // 'untrusted' means no smoke test has been run — still proceeds but with default trust
    // (readTrustStatus returns 'untrusted' which is not 'low-trust', so doc status is 'active')
    writeSmokeFile(repoDir, 'scribe', 'untrusted');

    await runGather(repoDir, 'node-001', undefined, { adapterFactory: makeAdapter(validScribeOutput()) });

    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.outline.nodes[0].status, 'gathered');
    assert.equal(manifest.documents[0].status, 'active');
  });
});

// ---------------------------------------------------------------------------
// Adapter errors propagate
// ---------------------------------------------------------------------------

describe('runGather adapter errors', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('adapter connection error propagates', async () => {
    setupApprovedRepo(repoDir);
    const { AdapterConnectionError } = await import('../src/runner/adapters/interface.ts');
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, {
        adapterFactory: makeFailingAdapter(new AdapterConnectionError('Connection refused')),
      }),
      (err: Error) => err.constructor.name === 'AdapterConnectionError',
    );
  });

  test('document not written on adapter error', async () => {
    setupApprovedRepo(repoDir);
    const { AdapterTimeoutError } = await import('../src/runner/adapters/interface.ts');
    await assert.rejects(
      () => runGather(repoDir, 'node-001', undefined, {
        adapterFactory: makeFailingAdapter(new AdapterTimeoutError('Timeout')),
      }),
    );

    assert(!existsSync(join(repoDir, 'documents', 'node-001')));
    const sm = new StateManager(repoDir);
    const manifest = sm.readManifest();
    assert.equal(manifest.documents.length, 0);
    assert.equal(manifest.outline.nodes[0].status, 'ungathered');
  });
});

// ---------------------------------------------------------------------------
// gather --next
// ---------------------------------------------------------------------------

describe('runGatherNext', () => {
  let repoDir: string;

  beforeEach(() => { repoDir = tmpDir(); });
  afterEach(() => { rmSync(repoDir, { recursive: true, force: true }); });

  test('picks first ungathered node in outline order', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    writeLearningBrief(repoDir);
    writeBootstrapPrompt(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'trusted');

    // Write outline with two nodes
    const outline = {
      schema_version: '1.0',
      created_at: new Date().toISOString(),
      last_modified: new Date().toISOString(),
      type: 'factual',
      version: 1,
      nodes: [
        { id: 'node-001', type: 'factual', title: 'Node 1', description: 'D1.', parent_id: null, status: 'ungathered' },
        { id: 'node-002', type: 'factual', title: 'Node 2', description: 'D2.', parent_id: null, status: 'ungathered' },
      ],
      contested_or_edge_case_node_count: 0,
    };
    writeFileSync(outlinePath(repoDir), yaml.dump(outline), 'utf8');

    const manifest = sm.readManifest();
    manifest.outline.version = 1;
    manifest.outline.status = 'approved';
    manifest.outline.approved_at = new Date().toISOString();
    manifest.outline.nodes = [
      { id: 'node-001', type: 'factual', title: 'Node 1', status: 'ungathered' },
      { id: 'node-002', type: 'factual', title: 'Node 2', status: 'ungathered' },
    ];
    sm.writeManifest(manifest);

    await runGatherNext(repoDir, { adapterFactory: makeAdapter(validScribeOutput('node-001')) });

    const manifest2 = sm.readManifest();
    assert.equal(manifest2.outline.nodes[0].status, 'gathered');
    assert.equal(manifest2.outline.nodes[1].status, 'ungathered');
  });

  test('skips blocked node, picks next', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    writeLearningBrief(repoDir);
    writeBootstrapPrompt(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'trusted');

    const outline = {
      schema_version: '1.0',
      created_at: new Date().toISOString(),
      last_modified: new Date().toISOString(),
      type: 'factual',
      version: 1,
      nodes: [
        { id: 'node-001', type: 'factual', title: 'Node 1', description: 'D1.', parent_id: null, status: 'ungathered' },
        { id: 'node-002', type: 'factual', title: 'Node 2', description: 'D2.', parent_id: null, status: 'ungathered' },
      ],
      contested_or_edge_case_node_count: 0,
    };
    writeFileSync(outlinePath(repoDir), yaml.dump(outline), 'utf8');

    const manifest = sm.readManifest();
    manifest.outline.version = 1;
    manifest.outline.status = 'approved';
    manifest.outline.approved_at = new Date().toISOString();
    manifest.outline.nodes = [
      { id: 'node-001', type: 'factual', title: 'Node 1', status: 'ungathered' },
      { id: 'node-002', type: 'factual', title: 'Node 2', status: 'ungathered' },
    ];
    sm.writeManifest(manifest);

    // Block node-001
    createCheckpoint(repoDir, sm, {
      prefix: 'TST', type: 'block', produced_by: 'runner',
      affected_object_id: 'node-001', description: 'Test block.',
    });

    await runGatherNext(repoDir, { adapterFactory: makeAdapter(validScribeOutput('node-002')) });

    const manifest2 = sm.readManifest();
    assert.equal(manifest2.outline.nodes[0].status, 'ungathered', 'blocked node stays ungathered');
    assert.equal(manifest2.outline.nodes[1].status, 'gathered', 'next node gathered');
  });

  test('all gathered → GatherNothingTodoError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    writeLearningBrief(repoDir);
    writeBootstrapPrompt(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'trusted');

    const manifest = sm.readManifest();
    manifest.outline.version = 1;
    manifest.outline.status = 'approved';
    manifest.outline.approved_at = new Date().toISOString();
    manifest.outline.nodes = [
      { id: 'node-001', type: 'factual', title: 'Node 1', status: 'gathered' },
    ];
    sm.writeManifest(manifest);

    await assert.rejects(
      () => runGatherNext(repoDir, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherNothingTodoError,
    );
  });

  test('all nodes blocked → GatherNothingTodoError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    writeLearningBrief(repoDir);
    writeBootstrapPrompt(repoDir);
    writeSmokeFile(repoDir, 'scribe', 'trusted');

    const manifest = sm.readManifest();
    manifest.outline.version = 1;
    manifest.outline.status = 'approved';
    manifest.outline.approved_at = new Date().toISOString();
    manifest.outline.nodes = [
      { id: 'node-001', type: 'factual', title: 'Node 1', status: 'ungathered' },
    ];
    sm.writeManifest(manifest);

    createCheckpoint(repoDir, sm, {
      prefix: 'TST', type: 'block', produced_by: 'runner',
      affected_object_id: 'node-001', description: 'Block.',
    });

    await assert.rejects(
      () => runGatherNext(repoDir, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherNothingTodoError,
    );
  });

  test('outline not approved → GatherOutlineNotReadyError', async () => {
    const sm = new StateManager(repoDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    // outline.status is 'none'
    await assert.rejects(
      () => runGatherNext(repoDir, { adapterFactory: makeAdapter(validScribeOutput()) }),
      GatherOutlineNotReadyError,
    );
  });
});
