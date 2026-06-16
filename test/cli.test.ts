import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../src/cli/parser.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');

function runCLI(args: string[]) {
  return spawnSync(
    process.execPath,
    ['dist/omoikane.js', ...args],
    { cwd: projectRoot, encoding: 'utf8' },
  );
}

// ---------------------------------------------------------------------------
// Parser unit tests
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('empty args → help', () => {
    assert.deepEqual(parseArgs([]), { type: 'help' });
  });

  test('--help → help', () => {
    assert.deepEqual(parseArgs(['--help']), { type: 'help' });
  });

  test('-h → help', () => {
    assert.deepEqual(parseArgs(['-h']), { type: 'help' });
  });

  test('repo init', () => {
    const result = parseArgs(['repo', 'init']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'repo_init');
  });

  test('repo reset', () => {
    const result = parseArgs(['repo', 'reset']);
    assert(result.type === 'command');
    assert.equal(result.command.id, 'repo_reset');
    assert.equal(result.command.yes, false);
    assert.equal(result.command.dryRun, false);
    assert.equal(result.command.keepConfig, false);
  });

  test('repo reset with flags', () => {
    const result = parseArgs(['repo', 'reset', '--yes', '--dry-run', '--keep-config']);
    assert(result.type === 'command');
    assert.equal(result.command.id, 'repo_reset');
    assert.equal(result.command.yes, true);
    assert.equal(result.command.dryRun, true);
    assert.equal(result.command.keepConfig, true);
  });

  test('repo reset rejects unknown flag', () => {
    const result = parseArgs(['repo', 'reset', '--nuke']);
    assert.equal(result.type, 'error');
  });

  test('status', () => {
    const result = parseArgs(['status']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'status');
  });

  test('outline', () => {
    const result = parseArgs(['outline']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'outline');
  });

  test('outline approve', () => {
    const result = parseArgs(['outline', 'approve']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'outline_approve');
  });

  test('outline amend <node-id>', () => {
    const result = parseArgs(['outline', 'amend', 'node-001']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'outline_amend');
    assert.equal(result.command.nodeId, 'node-001');
  });

  test('outline amend missing node-id → error', () => {
    const result = parseArgs(['outline', 'amend']);
    assert.equal(result.type, 'error');
  });

  test('gather <node-id>', () => {
    const result = parseArgs(['gather', 'node-001']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'gather');
    assert.equal(result.command.nodeId, 'node-001');
  });

  test('gather --next', () => {
    const result = parseArgs(['gather', '--next']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'gather_next');
  });

  test('gather <node-id> --prompt <id>', () => {
    const result = parseArgs(['gather', 'node-001', '--prompt', 'p-bootstrap-001']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'gather');
    assert.equal(result.command.nodeId, 'node-001');
    assert.equal(result.command.promptId, 'p-bootstrap-001');
  });

  test('gather with no node-id and no --next → error', () => {
    const result = parseArgs(['gather']);
    assert.equal(result.type, 'error');
  });

  test('review', () => {
    const result = parseArgs(['review']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'review');
  });

  test('resolve <checkpoint-id> --action <action>', () => {
    const result = parseArgs(['resolve', 'cp-001', '--action', 'acknowledge']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'resolve');
    assert.equal(result.command.checkpointId, 'cp-001');
    assert.equal(result.command.action, 'acknowledge');
  });

  test('resolve missing checkpoint-id → error', () => {
    assert.equal(parseArgs(['resolve']).type, 'error');
  });

  test('resolve missing --action → error', () => {
    assert.equal(parseArgs(['resolve', 'cp-001']).type, 'error');
  });

  test('claim correct <claim-id>', () => {
    const result = parseArgs(['claim', 'correct', 'claim-001']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'claim_correct');
    assert.equal(result.command.claimId, 'claim-001');
  });

  test('claim retract <claim-id>', () => {
    const result = parseArgs(['claim', 'retract', 'claim-001']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'claim_retract');
    assert.equal(result.command.claimId, 'claim-001');
  });

  test('claim correct missing claim-id → error', () => {
    assert.equal(parseArgs(['claim', 'correct']).type, 'error');
  });

  test('claim retract missing claim-id → error', () => {
    assert.equal(parseArgs(['claim', 'retract']).type, 'error');
  });

  test('agent test <role>', () => {
    const result = parseArgs(['agent', 'test', 'scribe']);
    assert.equal(result.type, 'command');
    assert(result.type === 'command');
    assert.equal(result.command.id, 'agent_test');
    assert.equal(result.command.role, 'scribe');
  });

  test('agent test missing role → error', () => {
    assert.equal(parseArgs(['agent', 'test']).type, 'error');
  });

  test('unknown top-level command → error', () => {
    assert.equal(parseArgs(['unknown-command']).type, 'error');
  });

  test('unknown repo subcommand → error', () => {
    assert.equal(parseArgs(['repo', 'deploy']).type, 'error');
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests (via subprocess)
// ---------------------------------------------------------------------------

describe('CLI integration', () => {
  test('--help lists all Phase 1 commands', () => {
    const result = runCLI(['--help']);
    assert.equal(result.status, 0, `exit code should be 0, got ${result.status}: ${result.stderr}`);
    const out = result.stdout;
    assert.match(out, /repo init/, 'help should list repo init');
    assert.match(out, /status/, 'help should list status');
    assert.match(out, /outline/, 'help should list outline');
    assert.match(out, /outline approve/, 'help should list outline approve');
    assert.match(out, /outline amend/, 'help should list outline amend');
    assert.match(out, /gather/, 'help should list gather');
    assert.match(out, /--next/, 'help should list gather --next');
    assert.match(out, /review/, 'help should list review');
    assert.match(out, /resolve/, 'help should list resolve');
    assert.match(out, /claim correct/, 'help should list claim correct');
    assert.match(out, /claim retract/, 'help should list claim retract');
    assert.match(out, /agent test/, 'help should list agent test');
  });

  test('no args shows help with exit 0', () => {
    const result = runCLI([]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /omoikane/i);
  });

  test('each Phase 1 stub command exits 0', () => {
    const stubs: string[][] = [
      ['status'],
      ['review'],
      ['resolve', 'cp-001', '--action', 'acknowledge'],
      ['claim', 'correct', 'claim-001'],
      ['claim', 'retract', 'claim-001'],
    ];
    for (const args of stubs) {
      const result = runCLI(args);
      assert.equal(
        result.status,
        0,
        `'omoikane ${args.join(' ')}' should exit 0, got ${result.status}\nstderr: ${result.stderr}`,
      );
    }
  });

  test('unknown command exits non-zero', () => {
    const result = runCLI(['unknowncmd']);
    assert.notEqual(result.status, 0);
  });
});

// ---------------------------------------------------------------------------
// Dependency importability
// ---------------------------------------------------------------------------

describe('dependencies', () => {
  test('js-yaml is importable and functional', async () => {
    const yaml = await import('js-yaml');
    const dumped = yaml.default.dump({ test: 'value', number: 42 });
    assert.match(dumped, /test: value/);
    assert.match(dumped, /number: 42/);
    const loaded = yaml.default.load('key: val') as Record<string, string>;
    assert.equal(loaded['key'], 'val');
  });

  test('better-sqlite3 is importable and functional', async () => {
    const Database = (await import('better-sqlite3')).default;
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('hello');
    const row = db.prepare('SELECT v FROM t').get() as { v: string };
    assert.equal(row.v, 'hello');
    db.close();
  });
});
