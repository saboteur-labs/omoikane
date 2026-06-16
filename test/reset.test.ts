import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planReset, executeReset, CONFIG_REL } from '../src/runner/state/reset.ts';

let tmpDir: string;

function seedRepo(dir: string): void {
  writeFileSync(join(dir, 'manifest.yaml'), 'subject: test\n');
  writeFileSync(join(dir, 'outline.yaml'), 'nodes: []\n');
  writeFileSync(join(dir, 'learning_brief.yaml'), 'subject: test\n');
  mkdirSync(join(dir, 'documents', 'A'), { recursive: true });
  writeFileSync(join(dir, 'documents', 'A', 'doc.yaml'), 'x: 1\n');
  mkdirSync(join(dir, 'gaps'), { recursive: true });
  mkdirSync(join(dir, 'prompts'), { recursive: true });
  writeFileSync(join(dir, 'prompts', 'p-init-1-001.yaml'), 'x: 1\n');
  mkdirSync(join(dir, '.omoikane'), { recursive: true });
  writeFileSync(join(dir, CONFIG_REL), 'schema_version: "1.0"\n');
  writeFileSync(join(dir, '.omoikane', 'omoikane.db'), 'binary');
  writeFileSync(join(dir, '.omoikane', 'smoke_tests.yaml'), 'x: 1\n');
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-reset-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('planReset', () => {
  test('lists all generated artifacts in a seeded repo', () => {
    seedRepo(tmpDir);
    const { targets, keptConfig } = planReset(tmpDir);
    assert.equal(keptConfig, false);
    for (const a of ['manifest.yaml', 'outline.yaml', 'learning_brief.yaml', 'documents', 'gaps', 'prompts', '.omoikane']) {
      assert(targets.includes(a), `expected ${a} in targets`);
    }
  });

  test('empty repo yields no targets', () => {
    const { targets } = planReset(tmpDir);
    assert.deepEqual(targets, []);
  });

  test('only lists artifacts that exist', () => {
    writeFileSync(join(tmpDir, 'manifest.yaml'), 'subject: test\n');
    const { targets } = planReset(tmpDir);
    assert.deepEqual(targets, ['manifest.yaml']);
  });

  test('keepConfig spares config.yaml but lists other .omoikane contents', () => {
    seedRepo(tmpDir);
    const { targets, keptConfig } = planReset(tmpDir, { keepConfig: true });
    assert.equal(keptConfig, true);
    assert(!targets.includes('.omoikane'));
    assert(targets.includes(join('.omoikane', 'omoikane.db')));
    assert(targets.includes(join('.omoikane', 'smoke_tests.yaml')));
    assert(!targets.includes(CONFIG_REL));
  });
});

describe('executeReset', () => {
  test('removes targets and restores starting state', () => {
    seedRepo(tmpDir);
    const { targets } = planReset(tmpDir);
    executeReset(tmpDir, targets);
    assert.deepEqual(planReset(tmpDir).targets, []);
    assert(!existsSync(join(tmpDir, 'manifest.yaml')));
    assert(!existsSync(join(tmpDir, 'documents')));
    assert(!existsSync(join(tmpDir, '.omoikane')));
  });

  test('keepConfig leaves config.yaml in place', () => {
    seedRepo(tmpDir);
    const { targets } = planReset(tmpDir, { keepConfig: true });
    executeReset(tmpDir, targets);
    assert(existsSync(join(tmpDir, CONFIG_REL)));
    assert(!existsSync(join(tmpDir, '.omoikane', 'omoikane.db')));
    assert(!existsSync(join(tmpDir, 'manifest.yaml')));
  });
});
