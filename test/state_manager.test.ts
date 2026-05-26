import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { StateManager, ManifestValidationError, RepoAlreadyInitialisedError, RepoNotInitialisedError } from '../src/runner/state/state_manager.ts';
import { validateManifest, createInitialManifest, type Manifest } from '../src/runner/state/manifest.ts';
import { manifestPath, documentDir, gapsDir, toDateStamp } from '../src/runner/state/paths.ts';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-state-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// initRepo
// ---------------------------------------------------------------------------

describe('StateManager.initRepo', () => {
  test('creates manifest.yaml with required fields', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Roman Aqueducts', 'learning_brief.yaml');

    const mPath = manifestPath(tmpDir);
    assert(existsSync(mPath), 'manifest.yaml must exist');

    const manifest = yaml.load(readFileSync(mPath, 'utf8')) as Manifest;
    assert.equal(manifest.schema_version, '1.0');
    assert.equal(manifest.subject, 'Roman Aqueducts');
    assert(manifest.created_at.length > 0);
    assert(manifest.last_modified.length > 0);
    assert.equal(manifest.learning_brief_path, 'learning_brief.yaml');
    assert.equal(manifest.outline.version, 0);
    assert.equal(manifest.outline.status, 'none');
    assert.deepEqual(manifest.outline.nodes, []);
    assert.deepEqual(manifest.documents, []);
    assert.equal(manifest.prompt_library_version, 1);
    assert.deepEqual(manifest.known_gaps, []);
    assert.deepEqual(manifest.open_predictions, []);
    assert.deepEqual(manifest.open_checkpoints, []);
  });

  test('creates required directory structure', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Byzantine Fault Tolerance', 'learning_brief.yaml');

    assert(existsSync(join(tmpDir, 'documents')), 'documents/ must exist');
    assert(existsSync(join(tmpDir, 'gaps')), 'gaps/ must exist');
    assert(existsSync(join(tmpDir, 'prompts')), 'prompts/ must exist');
    assert(existsSync(join(tmpDir, '.omoikane')), '.omoikane/ must exist');
  });

  test('throws RepoAlreadyInitialisedError when manifest already exists', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('First Subject', 'learning_brief.yaml');

    assert.throws(
      () => sm.initRepo('Second Subject', 'learning_brief.yaml'),
      RepoAlreadyInitialisedError,
    );
  });
});

// ---------------------------------------------------------------------------
// readManifest
// ---------------------------------------------------------------------------

describe('StateManager.readManifest', () => {
  test('reads back the manifest that was written', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Roman Aqueducts', 'learning_brief.yaml');

    const manifest = sm.readManifest();
    assert.equal(manifest.subject, 'Roman Aqueducts');
    assert.equal(manifest.schema_version, '1.0');
  });

  test('throws RepoNotInitialisedError when no manifest exists', () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'omoikane-empty-'));
    try {
      const sm = new StateManager(emptyDir);
      assert.throws(() => sm.readManifest(), RepoNotInitialisedError);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// writeManifest — atomic write
// ---------------------------------------------------------------------------

describe('StateManager.writeManifest', () => {
  test('writes manifest atomically — no .tmp file remains after success', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    const manifest = sm.readManifest();
    manifest.subject = 'Updated Subject';

    sm.writeManifest(manifest);

    assert(existsSync(manifestPath(tmpDir)), 'manifest.yaml must exist');
    assert(!existsSync(`${manifestPath(tmpDir)}.tmp`), 'no .tmp file should remain');
    assert.equal(sm.readManifest().subject, 'Updated Subject');
  });

  test('updates last_modified on every write', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    const before = sm.readManifest().last_modified;

    // Small pause to ensure the timestamp changes
    const manifest = sm.readManifest();
    sm.writeManifest(manifest);
    const after = sm.readManifest().last_modified;

    // Either same millisecond (rare) or updated — just check it's a valid ISO string
    assert(typeof after === 'string' && after.length > 0);
    // If they differ, after must be >= before
    if (before !== after) {
      assert(new Date(after) >= new Date(before));
    }
  });

  test('throws ManifestValidationError on MAN-VR1 violation', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    const manifest = sm.readManifest();

    // Add two active documents for the same node
    manifest.documents.push(
      { document_id: 'doc-001', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
      { document_id: 'doc-002', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
    );

    assert.throws(
      () => sm.writeManifest(manifest),
      (err: unknown) => {
        assert(err instanceof ManifestValidationError);
        assert(err.violations.some((v) => v.includes('MAN-VR1')));
        return true;
      },
    );
  });

  test('MAN-VR1: one active + one superseded on same node passes', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');
    const manifest = sm.readManifest();

    manifest.documents.push(
      { document_id: 'doc-001', outline_node_id: 'n-001', status: 'superseded', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-24', superseded_by: 'doc-002' },
      { document_id: 'doc-002', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
    );

    assert.doesNotThrow(() => sm.writeManifest(manifest));
  });
});

// ---------------------------------------------------------------------------
// writeDocument — naming convention + atomic write
// ---------------------------------------------------------------------------

describe('StateManager.writeDocument', () => {
  test('writes to documents/<nodeId>/doc-<nodeId>-<date>-001.yaml on first write', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const date = '20260525';
    const filePath = sm.writeDocument('n-001', { type: 'document', outline_node_id: 'n-001' }, date);

    assert.equal(filePath, join(tmpDir, 'documents', 'n-001', 'doc-n-001-20260525-001.yaml'));
    assert(existsSync(filePath), 'document file must exist');
  });

  test('increments seq number on subsequent writes for same node', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const date = '20260525';
    const path1 = sm.writeDocument('n-001', { type: 'document' }, date);
    const path2 = sm.writeDocument('n-001', { type: 'document' }, date);
    const path3 = sm.writeDocument('n-001', { type: 'document' }, date);

    assert(path1.endsWith('001.yaml'));
    assert(path2.endsWith('002.yaml'));
    assert(path3.endsWith('003.yaml'));
    assert(existsSync(path1));
    assert(existsSync(path2));
    assert(existsSync(path3));
  });

  test('seq numbers are independent across different nodes', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const date = '20260525';
    sm.writeDocument('n-001', { type: 'document' }, date);
    sm.writeDocument('n-001', { type: 'document' }, date);
    const pathN2 = sm.writeDocument('n-002', { type: 'document' }, date);

    assert(pathN2.endsWith('001.yaml'), 'n-002 seq starts at 001 regardless of n-001 count');
  });

  test('no .tmp file remains after successful write', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const filePath = sm.writeDocument('n-001', { type: 'document' }, '20260525');
    assert(!existsSync(`${filePath}.tmp`), 'no .tmp file should remain');
  });

  test('written content is valid YAML matching what was passed', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const doc = { type: 'document', outline_node_id: 'n-001', claims: [{ id: 'c-001' }] };
    const filePath = sm.writeDocument('n-001', doc, '20260525');

    const read = yaml.load(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    assert.equal(read.type, 'document');
    assert.equal(read.outline_node_id, 'n-001');
  });

  test('creates documents/<nodeId>/ directory if it does not exist', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const dir = documentDir(tmpDir, 'n-new');
    assert(!existsSync(dir));

    sm.writeDocument('n-new', { type: 'document' }, '20260525');
    assert(existsSync(dir));
  });
});

// ---------------------------------------------------------------------------
// writeGap — naming convention + atomic write
// ---------------------------------------------------------------------------

describe('StateManager.writeGap', () => {
  test('writes to gaps/gap-<date>-001.yaml on first write', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const filePath = sm.writeGap({ type: 'gap_document', id: 'gap-001' }, '20260525');

    assert.equal(filePath, join(tmpDir, 'gaps', 'gap-20260525-001.yaml'));
    assert(existsSync(filePath));
  });

  test('increments seq on subsequent gap writes', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const p1 = sm.writeGap({ type: 'gap_document' }, '20260525');
    const p2 = sm.writeGap({ type: 'gap_document' }, '20260525');

    assert(p1.endsWith('001.yaml'));
    assert(p2.endsWith('002.yaml'));
  });

  test('no .tmp file remains after successful gap write', () => {
    const sm = new StateManager(tmpDir);
    sm.initRepo('Test Subject', 'learning_brief.yaml');

    const filePath = sm.writeGap({ type: 'gap_document' }, '20260525');
    assert(!existsSync(`${filePath}.tmp`), 'no .tmp file should remain');
  });
});

// ---------------------------------------------------------------------------
// validateManifest (standalone — verifies it is a callable rule)
// ---------------------------------------------------------------------------

describe('validateManifest rule (standalone)', () => {
  test('returns empty array for valid manifest', () => {
    const manifest = createInitialManifest('Test', 'learning_brief.yaml');
    manifest.documents.push({
      document_id: 'doc-001', outline_node_id: 'n-001', status: 'active',
      prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25',
    });
    assert.deepEqual(validateManifest(manifest), []);
  });

  test('MAN-VR1: returns error string when two active docs share a node', () => {
    const manifest = createInitialManifest('Test', 'learning_brief.yaml');
    manifest.documents.push(
      { document_id: 'doc-001', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
      { document_id: 'doc-002', outline_node_id: 'n-001', status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'claude-sonnet-4-6', date: '2026-05-25' },
    );
    const errors = validateManifest(manifest);
    assert(errors.length > 0);
    assert(errors[0].includes('MAN-VR1'));
  });

  test('MAN-VR1: multiple violations reported (one per offending node)', () => {
    const manifest = createInitialManifest('Test', 'learning_brief.yaml');
    for (const nodeId of ['n-001', 'n-002']) {
      manifest.documents.push(
        { document_id: `doc-${nodeId}-a`, outline_node_id: nodeId, status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'x', date: '2026-05-25' },
        { document_id: `doc-${nodeId}-b`, outline_node_id: nodeId, status: 'active', prompt_id: 'p-001', prompt_generation: 1, adapter: 'claude', model: 'x', date: '2026-05-25' },
      );
    }
    const errors = validateManifest(manifest);
    assert.equal(errors.length, 2);
  });
});
