import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import {
  createCheckpoint,
  resolveCheckpoint,
  autoResolveInformCheckpoints,
  hasBlockingCheckpoints,
  InvalidCheckpointActionError,
  CheckpointNotFoundError,
  type CheckpointHistoryEntry,
} from '../src/runner/checkpoints/registry.ts';
import { StateManager } from '../src/runner/state/state_manager.ts';
import { checkpointHistoryPath } from '../src/runner/state/paths.ts';
import type { Manifest } from '../src/runner/state/manifest.ts';

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let tmpDir: string;
let sm: StateManager;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-cp-test-'));
  sm = new StateManager(tmpDir);
  sm.initRepo('Test Subject', 'learning_brief.yaml');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function readHistory(): CheckpointHistoryEntry[] {
  const p = checkpointHistoryPath(tmpDir);
  if (!existsSync(p)) return [];
  return (yaml.load(readFileSync(p, 'utf8')) as CheckpointHistoryEntry[]) ?? [];
}

// ---------------------------------------------------------------------------
// createCheckpoint — ID format and storage
// ---------------------------------------------------------------------------

describe('createCheckpoint — ID format and storage', () => {
  test('returns an ID matching CP-<prefix>-<YYYYMMDD>-<seq> format', () => {
    const id = createCheckpoint(tmpDir, sm, {
      prefix: 'ARC',
      type: 'review',
      produced_by: 'architect',
      affected_object_id: 'outline',
      description: 'Test checkpoint',
    }, '20260525');

    assert.match(id, /^CP-ARC-20260525-\d{3}$/);
  });

  test('stores checkpoint in manifest.open_checkpoints', () => {
    const id = createCheckpoint(tmpDir, sm, {
      prefix: 'SCR',
      type: 'inform',
      produced_by: 'scribe',
      affected_object_id: 'doc-001',
      description: 'Gather complete',
    });

    const manifest = sm.readManifest();
    const cp = manifest.open_checkpoints.find((c) => c.checkpoint_id === id);
    assert(cp, 'checkpoint must appear in manifest.open_checkpoints');
    assert.equal(cp!.type, 'inform');
    assert.equal(cp!.produced_by, 'scribe');
    assert.equal(cp!.affected_object_id, 'doc-001');
  });

  test('seq starts at 001 for a new prefix+date', () => {
    const id = createCheckpoint(tmpDir, sm, {
      prefix: 'SMK',
      type: 'block',
      produced_by: 'runner',
      affected_object_id: 'role_config',
      description: 'Smoke test failed',
    }, '20260525');

    assert(id.endsWith('-001'));
  });

  test('sequential checkpoints with the same prefix+date get incrementing seq numbers', () => {
    const id1 = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-001', description: 'd1' }, '20260525');
    const id2 = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-002', description: 'd2' }, '20260525');
    const id3 = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-003', description: 'd3' }, '20260525');

    assert(id1.endsWith('-001'));
    assert(id2.endsWith('-002'));
    assert(id3.endsWith('-003'));
  });

  test('different prefixes have independent seq counters', () => {
    const id1 = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'o', description: 'd' }, '20260525');
    const id2 = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'o', description: 'd' }, '20260525');

    assert(id1.endsWith('-001'));
    assert(id2.endsWith('-001'), 'SCR seq is independent of ARC seq');
  });

  test('seq counts resolved (history) checkpoints to maintain global uniqueness', () => {
    // Create and resolve a checkpoint
    const id1 = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'o', description: 'd' }, '20260525');
    resolveCheckpoint(tmpDir, sm, id1, 'acknowledge');

    // Next checkpoint for same prefix+date must be seq 002, not 001
    const id2 = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'o', description: 'd2' }, '20260525');
    assert(id2.endsWith('-002'), 'seq must account for resolved checkpoints');
  });

  test('stores principle_ref when provided', () => {
    const id = createCheckpoint(tmpDir, sm, {
      prefix: 'ARC',
      type: 'review',
      produced_by: 'architect',
      affected_object_id: 'outline',
      description: 'Test',
      principle_ref: 'P1',
    });

    const manifest = sm.readManifest();
    const cp = manifest.open_checkpoints.find((c) => c.checkpoint_id === id);
    assert.equal(cp!.principle_ref, 'P1');
  });
});

// ---------------------------------------------------------------------------
// resolveCheckpoint — action validation
// ---------------------------------------------------------------------------

describe('resolveCheckpoint — action validation', () => {
  test('throws InvalidCheckpointActionError when action invalid for inform type', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-001', description: 'd' });

    assert.throws(
      () => resolveCheckpoint(tmpDir, sm, id, 'dismiss'),
      InvalidCheckpointActionError,
    );
  });

  test('throws InvalidCheckpointActionError when action invalid for block type', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'scribe', description: 'd' });

    assert.throws(
      () => resolveCheckpoint(tmpDir, sm, id, 'acknowledge'),
      InvalidCheckpointActionError,
    );
  });

  test('throws InvalidCheckpointActionError when action invalid for review type', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'd' });

    assert.throws(
      () => resolveCheckpoint(tmpDir, sm, id, 'accept'),
      InvalidCheckpointActionError,
    );
  });

  test('throws CheckpointNotFoundError for unknown checkpoint ID', () => {
    assert.throws(
      () => resolveCheckpoint(tmpDir, sm, 'CP-UNKNOWN-20260525-999', 'acknowledge'),
      CheckpointNotFoundError,
    );
  });
});

// ---------------------------------------------------------------------------
// resolveCheckpoint — happy path
// ---------------------------------------------------------------------------

describe('resolveCheckpoint — resolution', () => {
  test('removes checkpoint from manifest.open_checkpoints on resolution', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'd' });

    resolveCheckpoint(tmpDir, sm, id, 'acknowledge');

    const manifest = sm.readManifest();
    assert(!manifest.open_checkpoints.some((c) => c.checkpoint_id === id));
  });

  test('appends resolution entry to checkpoint_history.yaml', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'd' });

    resolveCheckpoint(tmpDir, sm, id, 'dismiss');

    const history = readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].checkpoint_id, id);
    assert.equal(history[0].resolution_action, 'dismiss');
    assert(typeof history[0].resolved_at === 'string' && history[0].resolved_at.length > 0);
  });

  test('records resolution note in history when provided', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'd' });

    resolveCheckpoint(tmpDir, sm, id, 'note', 'This needs follow-up');

    const history = readHistory();
    assert.equal(history[0].resolution_note, 'This needs follow-up');
  });

  test('history file grows on each resolution', () => {
    const id1 = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd1' });
    const id2 = createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'd2' });

    resolveCheckpoint(tmpDir, sm, id1, 'acknowledge');
    resolveCheckpoint(tmpDir, sm, id2, 'dismiss');

    const history = readHistory();
    assert.equal(history.length, 2);
  });

  test('block checkpoint accepts accept action', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'scribe', description: 'd' });

    assert.doesNotThrow(() => resolveCheckpoint(tmpDir, sm, id, 'accept'));

    const manifest = sm.readManifest();
    assert(!manifest.open_checkpoints.some((c) => c.checkpoint_id === id));
  });
});

// ---------------------------------------------------------------------------
// override on block produces inform checkpoint
// ---------------------------------------------------------------------------

describe('resolveCheckpoint — override on block produces inform entry', () => {
  test('overriding a block leaves a new inform checkpoint in open_checkpoints', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'scribe', description: 'd' });

    resolveCheckpoint(tmpDir, sm, id, 'override');

    const manifest = sm.readManifest();
    const overrideInform = manifest.open_checkpoints.find((c) => c.type === 'inform');
    assert(overrideInform, 'an inform checkpoint must be created for the override');
    assert(overrideInform!.description.includes(id), 'inform description must reference the overridden checkpoint');
  });

  test('the block itself is moved to history on override', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'scribe', description: 'd' });

    resolveCheckpoint(tmpDir, sm, id, 'override');

    const history = readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].checkpoint_id, id);
    assert.equal(history[0].resolution_action, 'override');

    const manifest = sm.readManifest();
    assert(!manifest.open_checkpoints.some((c) => c.checkpoint_id === id), 'block must not remain open');
  });
});

// ---------------------------------------------------------------------------
// inform auto-resolve
// ---------------------------------------------------------------------------

describe('autoResolveInformCheckpoints', () => {
  test('returns 0 when no inform checkpoints are open', () => {
    const count = autoResolveInformCheckpoints(tmpDir, sm);
    assert.equal(count, 0);
  });

  test('resolves all inform checkpoints and returns count', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd1' });
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-2', description: 'd2' });

    const count = autoResolveInformCheckpoints(tmpDir, sm);
    assert.equal(count, 2);
  });

  test('removes all inform checkpoints from open_checkpoints', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd1' });

    autoResolveInformCheckpoints(tmpDir, sm);

    const manifest = sm.readManifest();
    assert.equal(manifest.open_checkpoints.filter((c) => c.type === 'inform').length, 0);
  });

  test('does not touch review or block checkpoints', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd1' });
    createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'outline', description: 'r' });
    createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'scribe', description: 'b' });

    autoResolveInformCheckpoints(tmpDir, sm);

    const manifest = sm.readManifest();
    assert.equal(manifest.open_checkpoints.length, 2, 'review and block must remain');
    assert(manifest.open_checkpoints.every((c) => c.type !== 'inform'));
  });

  test('records auto-resolved informs in history with acknowledge action', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd1' });

    autoResolveInformCheckpoints(tmpDir, sm);

    const history = readHistory();
    assert.equal(history.length, 1);
    assert.equal(history[0].resolution_action, 'acknowledge');
  });
});

// ---------------------------------------------------------------------------
// hasBlockingCheckpoints
// ---------------------------------------------------------------------------

describe('hasBlockingCheckpoints', () => {
  test('returns false when manifest has no checkpoints', () => {
    const manifest = sm.readManifest();
    assert.equal(hasBlockingCheckpoints(manifest, 'n-001'), false);
  });

  test('returns false when only inform/review checkpoints exist for the object', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'n-001', description: 'd' });
    createCheckpoint(tmpDir, sm, { prefix: 'ARC', type: 'review', produced_by: 'architect', affected_object_id: 'n-001', description: 'd' });

    const manifest = sm.readManifest();
    assert.equal(hasBlockingCheckpoints(manifest, 'n-001'), false);
  });

  test('returns true when a block checkpoint exists for the object', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'n-001', description: 'd' });

    const manifest = sm.readManifest();
    assert.equal(hasBlockingCheckpoints(manifest, 'n-001'), true);
  });

  test('returns false for a different affected_object_id', () => {
    createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'n-002', description: 'd' });

    const manifest = sm.readManifest();
    assert.equal(hasBlockingCheckpoints(manifest, 'n-001'), false);
  });

  test('returns false after a block checkpoint is resolved', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SMK', type: 'block', produced_by: 'runner', affected_object_id: 'n-001', description: 'd' });
    resolveCheckpoint(tmpDir, sm, id, 'accept');

    const manifest = sm.readManifest();
    assert.equal(hasBlockingCheckpoints(manifest, 'n-001'), false);
  });
});

// ---------------------------------------------------------------------------
// History file — append-only behaviour
// ---------------------------------------------------------------------------

describe('checkpoint_history.yaml — append-only', () => {
  test('history file is created on first resolution', () => {
    const histPath = checkpointHistoryPath(tmpDir);
    assert(!existsSync(histPath), 'must not exist before any resolution');

    const id = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd' });
    resolveCheckpoint(tmpDir, sm, id, 'acknowledge');

    assert(existsSync(histPath), 'must exist after resolution');
  });

  test('manifest.yaml is never modified during resolution (only open_checkpoints change)', () => {
    const id = createCheckpoint(tmpDir, sm, { prefix: 'SCR', type: 'inform', produced_by: 'scribe', affected_object_id: 'doc-1', description: 'd' });

    const manifestBefore = sm.readManifest();
    const subjectBefore = manifestBefore.subject;

    resolveCheckpoint(tmpDir, sm, id, 'acknowledge');

    const manifestAfter = sm.readManifest();
    assert.equal(manifestAfter.subject, subjectBefore, 'subject must not change');
    assert.equal(manifestAfter.open_checkpoints.length, 0, 'open_checkpoints must be empty after resolve');
  });
});
