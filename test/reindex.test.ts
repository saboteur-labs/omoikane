import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { reindexRepo } from '../src/runner/state/reindex.ts';
import { StateManager } from '../src/runner/state/state_manager.ts';
import { openDb, dbPath } from '../src/runner/state/index_db.ts';
import { manifestPath, gapsDir, promptsDir, omoikaneDir } from '../src/runner/state/paths.ts';
import type { Manifest } from '../src/runner/state/manifest.ts';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-reindex-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function initRepo(): StateManager {
  const sm = new StateManager(tmpDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
  return sm;
}

function readManifestRaw(): string {
  return readFileSync(manifestPath(tmpDir), 'utf8');
}

function writeGapFile(gapId: string, nodeId?: string): void {
  const dir = gapsDir(tmpDir);
  mkdirSync(dir, { recursive: true });
  const gap = {
    id: gapId,
    nature: 'knowledge_ceiling',
    status: 'open',
    outline_node_id: nodeId ?? null,
    produced_by: 'cartographer',
    created_at: '2026-05-25T00:00:00Z',
  };
  writeFileSync(join(dir, `${gapId}.yaml`), yaml.dump(gap), 'utf8');
}

function writeDocumentFile(nodeId: string, docId: string, claims: unknown[], signalHistory?: unknown[]): void {
  const dir = join(tmpDir, 'documents', nodeId);
  mkdirSync(dir, { recursive: true });
  const doc = {
    id: docId,
    outline_node_id: nodeId,
    prompt_id: 'p-001',
    claims,
    signal_history: signalHistory ?? [],
  };
  writeFileSync(join(dir, `doc-${nodeId}-20260525-001.yaml`), yaml.dump(doc), 'utf8');
}

function writePromptFile(promptId: string, promptType: string): void {
  const dir = promptsDir(tmpDir);
  mkdirSync(dir, { recursive: true });
  const prompt = {
    id: promptId,
    prompt_type: promptType,
    target: 'n-001',
    status: 'active',
    origin: 'system',
    generation: 1,
    parent: null,
  };
  writeFileSync(join(dir, `${promptId}.yaml`), yaml.dump(prompt), 'utf8');
}

function queryAll(sql: string): unknown[] {
  const db = openDb(tmpDir);
  return db.prepare(sql).all();
}

// ---------------------------------------------------------------------------
// Basic operation
// ---------------------------------------------------------------------------

describe('reindexRepo — empty repo', () => {
  test('returns zero summary when manifest is missing', () => {
    const summary = reindexRepo(tmpDir);
    assert.equal(summary.files_read, 0);
    assert.equal(summary.records_indexed, 0);
    assert.equal(summary.warnings_produced, 1);
  });

  test('returns correct summary for freshly initialised repo with no content', () => {
    initRepo();
    const summary = reindexRepo(tmpDir);
    assert.equal(summary.files_read, 1);
    assert.equal(summary.records_indexed, 0);
    assert.equal(summary.warnings_produced, 0);
  });
});

// ---------------------------------------------------------------------------
// YAML immutability
// ---------------------------------------------------------------------------

describe('reindexRepo — YAML never modified', () => {
  test('manifest.yaml content is byte-for-byte identical after reindex', () => {
    initRepo();
    const before = readManifestRaw();
    reindexRepo(tmpDir);
    const after = readManifestRaw();
    assert.equal(after, before);
  });

  test('no .tmp files remain after reindex', () => {
    initRepo();
    reindexRepo(tmpDir);
    assert(!existsSync(`${manifestPath(tmpDir)}.tmp`));
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('reindexRepo — idempotency', () => {
  test('running reindex twice produces the same table contents', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    manifest.open_checkpoints.push({
      checkpoint_id: 'cp-001', type: 'review', produced_by: 'critic',
      affected_object_id: 'doc-001', description: 'Test checkpoint',
      created_at: '2026-05-25T00:00:00Z',
    });
    sm.writeManifest(manifest);

    reindexRepo(tmpDir);
    const docs1 = queryAll('SELECT * FROM documents');
    const cps1 = queryAll('SELECT * FROM checkpoints');

    reindexRepo(tmpDir);
    const docs2 = queryAll('SELECT * FROM documents');
    const cps2 = queryAll('SELECT * FROM checkpoints');

    assert.deepEqual(docs1, docs2);
    assert.deepEqual(cps1, cps2);
  });

  test('deleting db and reindexing gives same result as original write', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    sm.writeManifest(manifest);

    const docs1 = queryAll('SELECT * FROM documents ORDER BY document_id');

    // Delete db and reindex
    unlinkSync(dbPath(tmpDir));
    reindexRepo(tmpDir);
    const docs2 = queryAll('SELECT * FROM documents ORDER BY document_id');

    assert.deepEqual(docs1, docs2);
  });
});

// ---------------------------------------------------------------------------
// Documents + checkpoints from manifest
// ---------------------------------------------------------------------------

describe('reindexRepo — documents table', () => {
  test('indexes all documents from manifest', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push(
      { document_id: 'doc-001', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
      { document_id: 'doc-002', outline_node_id: 'n-001', status: 'superseded', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-24', superseded_by: 'doc-001' },
    );
    sm.writeManifest(manifest);

    reindexRepo(tmpDir);
    const docs = queryAll('SELECT document_id, status FROM documents ORDER BY document_id') as { document_id: string; status: string }[];
    assert.equal(docs.length, 2);
    assert.equal(docs[0].document_id, 'doc-001');
    assert.equal(docs[0].status, 'active');
    assert.equal(docs[1].document_id, 'doc-002');
    assert.equal(docs[1].status, 'superseded');
  });

  test('indexes checkpoints from manifest.open_checkpoints', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.open_checkpoints.push({
      checkpoint_id: 'cp-001', type: 'block', produced_by: 'critic',
      affected_object_id: 'doc-001', description: 'Needs attention',
      created_at: '2026-05-25T00:00:00Z', principle_ref: 'P2',
    });
    sm.writeManifest(manifest);

    reindexRepo(tmpDir);
    const cps = queryAll('SELECT * FROM checkpoints') as { checkpoint_id: string; checkpoint_type: string; principle_ref: string }[];
    assert.equal(cps.length, 1);
    assert.equal(cps[0].checkpoint_id, 'cp-001');
    assert.equal(cps[0].checkpoint_type, 'block');
    assert.equal(cps[0].principle_ref, 'P2');
  });
});

// ---------------------------------------------------------------------------
// Gap documents
// ---------------------------------------------------------------------------

describe('reindexRepo — gap_documents table', () => {
  test('indexes gap files referenced in manifest.known_gaps', () => {
    initRepo();
    writeGapFile('gap-001', 'n-001');
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.known_gaps.push({ gap_id: 'gap-001', nature: 'knowledge_ceiling', status: 'open', outline_node_id: 'n-001' });
    sm.writeManifest(manifest);

    reindexRepo(tmpDir);
    const gaps = queryAll('SELECT gap_id, nature FROM gap_documents') as { gap_id: string; nature: string }[];
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0].gap_id, 'gap-001');
    assert.equal(gaps[0].nature, 'knowledge_ceiling');
  });

  test('warns when gap_id in manifest has no corresponding file', () => {
    initRepo();
    // Manually add known_gaps entry without creating the file
    const manifest = yaml.load(readFileSync(manifestPath(tmpDir), 'utf8')) as Manifest;
    manifest.known_gaps = [{ gap_id: 'gap-missing', nature: 'source_absence', status: 'open' }];
    writeFileSync(manifestPath(tmpDir), yaml.dump(manifest), 'utf8');

    const summary = reindexRepo(tmpDir);
    assert(summary.warnings_produced >= 1, 'must warn about missing gap file');
    const gaps = queryAll('SELECT * FROM gap_documents');
    assert.equal(gaps.length, 0, 'missing file must not create a db record');
  });
});

// ---------------------------------------------------------------------------
// Claims + signal_events from document files
// ---------------------------------------------------------------------------

describe('reindexRepo — claims and signal_events tables', () => {
  test('indexes claims from document YAML files', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    sm.writeManifest(manifest);

    writeDocumentFile('n-001', 'doc-001', [
      { id: 'c-001', type: 'factual', status: 'active', source: { tier: 'tier_1' }, confidence: { level: 'high' } },
      { id: 'c-002', type: 'inferred', status: 'active', source: { tier: 'tier_3' }, confidence: { level: 'low' } },
    ]);

    reindexRepo(tmpDir);
    const claims = queryAll('SELECT claim_id, source_tier, confidence_level FROM claims ORDER BY claim_id') as { claim_id: string; source_tier: string; confidence_level: string }[];
    assert.equal(claims.length, 2);
    assert.equal(claims[0].claim_id, 'c-001');
    assert.equal(claims[0].source_tier, 'tier_1');
    assert.equal(claims[0].confidence_level, 'high');
    assert.equal(claims[1].claim_id, 'c-002');
  });

  test('indexes signal_history entries from document YAML files', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    sm.writeManifest(manifest);

    writeDocumentFile('n-001', 'doc-001', [], [
      { entry_id: 'se-001', type: 'confidence_delta', signal_category: 'ai_derived', timestamp: '2026-05-25T00:00:00Z' },
    ]);

    reindexRepo(tmpDir);
    const events = queryAll('SELECT entry_id, signal_type FROM signal_events') as { entry_id: string; signal_type: string }[];
    assert.equal(events.length, 1);
    assert.equal(events[0].entry_id, 'se-001');
    assert.equal(events[0].signal_type, 'confidence_delta');
  });

  test('warns when a document YAML file has no id field', () => {
    initRepo();
    const dir = join(tmpDir, 'documents', 'n-001');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'doc-n-001-20260525-001.yaml'), yaml.dump({ outline_node_id: 'n-001' }), 'utf8');

    const summary = reindexRepo(tmpDir);
    assert(summary.warnings_produced >= 1);
  });

  test('warns when a claim has no id field', () => {
    initRepo();
    writeDocumentFile('n-001', 'doc-001', [
      { type: 'factual' }, // missing id
    ]);

    const summary = reindexRepo(tmpDir);
    assert(summary.warnings_produced >= 1);
  });
});

// ---------------------------------------------------------------------------
// Prompts table
// ---------------------------------------------------------------------------

describe('reindexRepo — prompts table', () => {
  test('indexes prompts from prompts/ directory', () => {
    initRepo();
    writePromptFile('p-scribe-001', 'gather');
    writePromptFile('p-scribe-002', 'gather');

    reindexRepo(tmpDir);
    const prompts = queryAll('SELECT prompt_id, prompt_type FROM prompts ORDER BY prompt_id') as { prompt_id: string; prompt_type: string }[];
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0].prompt_id, 'p-scribe-001');
    assert.equal(prompts[0].prompt_type, 'gather');
  });

  test('warns when a prompt file has no id field', () => {
    initRepo();
    const dir = promptsDir(tmpDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'bad-prompt.yaml'), yaml.dump({ prompt_type: 'gather' }), 'utf8');

    const summary = reindexRepo(tmpDir);
    assert(summary.warnings_produced >= 1);
  });
});

// ---------------------------------------------------------------------------
// MAN-VR1 integrity check
// ---------------------------------------------------------------------------

describe('reindexRepo — MAN-VR1 integrity warning', () => {
  test('warns when two active documents share an outline node', () => {
    initRepo();
    // Write directly to YAML to bypass writeManifest validation, simulating a
    // corrupt or externally-modified manifest that reindex must handle gracefully
    const manifest = yaml.load(readFileSync(manifestPath(tmpDir), 'utf8')) as Manifest;
    manifest.documents = [
      { document_id: 'doc-001', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'x', date: '2026-05-25' },
      { document_id: 'doc-002', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'x', date: '2026-05-25' },
    ];
    writeFileSync(manifestPath(tmpDir), yaml.dump(manifest), 'utf8');

    const summary = reindexRepo(tmpDir);
    assert(summary.warnings_produced >= 1, 'must warn on MAN-VR1 violation');
  });
});

// ---------------------------------------------------------------------------
// Summary field correctness
// ---------------------------------------------------------------------------

describe('reindexRepo — summary accuracy', () => {
  test('files_read counts manifest + document files + gap files + prompt files', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    manifest.known_gaps.push({ gap_id: 'gap-001', nature: 'knowledge_ceiling', status: 'open' });
    sm.writeManifest(manifest);

    writeGapFile('gap-001');
    writeDocumentFile('n-001', 'doc-001', []);
    writePromptFile('p-001', 'gather');

    const summary = reindexRepo(tmpDir);
    // manifest + gap-001.yaml + doc file + prompt file = 4
    assert.equal(summary.files_read, 4);
  });

  test('records_indexed counts documents + checkpoints + gaps + claims + signals + prompts', () => {
    initRepo();
    const sm = new StateManager(tmpDir);
    const manifest = sm.readManifest();
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude',
      model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    manifest.open_checkpoints.push({
      checkpoint_id: 'cp-001', type: 'review', produced_by: 'critic',
      affected_object_id: 'doc-001', description: 'desc', created_at: '2026-05-25T00:00:00Z',
    });
    manifest.known_gaps.push({ gap_id: 'gap-001', nature: 'knowledge_ceiling', status: 'open' });
    sm.writeManifest(manifest);

    writeGapFile('gap-001');
    writeDocumentFile('n-001', 'doc-001', [
      { id: 'c-001', type: 'factual', status: 'active', source: { tier: 'tier_1' }, confidence: { level: 'high' } },
    ], [
      { entry_id: 'se-001', type: 'confidence_delta', signal_category: 'ai_derived', timestamp: '2026-05-25T00:00:00Z' },
    ]);
    writePromptFile('p-001', 'gather');

    const summary = reindexRepo(tmpDir);
    // 1 doc + 1 checkpoint + 1 gap + 1 claim + 1 signal + 1 prompt = 6
    assert.equal(summary.records_indexed, 6);
  });
});
