import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Router, ContextBudgetViolationError, UnknownAdapterError } from '../src/runner/router.ts';
import { FakeAdapter } from '../src/runner/adapters/fake.ts';
import { assembleConstitution, clearConstitutionCache } from '../src/runner/constitution.ts';
import { clearCache as clearSpecCache } from '../src/runner/validation/schema_loader.ts';

// ---------------------------------------------------------------------------
// Minimal agent YAML fixtures — only the fields the router reads
// ---------------------------------------------------------------------------

const ARCHITECT_YAML = `
role: architect
context_budget:
  required:
    - learning_brief
  optional:
    - existing_outline
    - repo_manifest
  forbidden:
    - document_files
    - challenge_reports
    - verification_reports
    - gaps_reports
    - prompt_library
output_schema: {}
output_validation: []
hard_constraints: []
`;

const SCRIBE_YAML = `
role: scribe
context_budget:
  required:
    - outline_node
    - learning_brief
    - assigned_prompt
  optional:
    - tier_1_sources
  forbidden:
    - other_document_files
    - challenge_reports
    - verification_reports
    - gaps_reports
    - prompt_library
output_schema: {}
output_validation: []
hard_constraints: []
`;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let specDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'omoikane-test-'));
  specDir = join(tmpDir, 'agents');
  mkdirSync(specDir, { recursive: true });

  writeFileSync(join(specDir, 'architect.yaml'), ARCHITECT_YAML);
  writeFileSync(join(specDir, 'scribe.yaml'), SCRIBE_YAML);

  clearSpecCache();
  clearConstitutionCache();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  clearSpecCache();
  clearConstitutionCache();
});

function makeRouter(repoDir: string = tmpDir): Router {
  const router = new Router({ repoDir, specDir });
  router.registerAdapter('fake', new FakeAdapter('fake', 'fake-model-1'));
  return router;
}

// ---------------------------------------------------------------------------
// Context budget enforcement
// ---------------------------------------------------------------------------

describe('context budget enforcement', () => {
  test('throws ContextBudgetViolationError when a forbidden key is present (architect)', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    const router = makeRouter();
    await assert.rejects(
      () => router.invoke('architect', 'init', { document_files: ['file1.yaml'] }),
      (err: unknown) => {
        assert(err instanceof ContextBudgetViolationError);
        assert.equal(err.role, 'architect');
        assert.equal(err.key, 'document_files');
        return true;
      },
    );
  });

  test('throws before any network call — no adapter invocation on forbidden key', async () => {
    const fake = new FakeAdapter('fake', 'fake-model-1');
    const router = new Router({ repoDir: tmpDir, specDir });
    router.registerAdapter('fake', fake);

    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    await assert.rejects(
      () => router.invoke('architect', 'init', { challenge_reports: [] }),
    );

    assert.equal(fake.lastInvokedRole, null, 'adapter.invoke must not be called');
  });

  test('allows context with only permitted keys (architect)', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    const fake = new FakeAdapter('fake', 'fake-model-1');
    const router = new Router({ repoDir: tmpDir, specDir });
    router.registerAdapter('fake', fake);

    await router.invoke('architect', 'init', { learning_brief: { subject: 'Rome' } });

    assert.equal(fake.lastInvokedRole, 'architect');
  });

  test('throws for scribe forbidden key (other_document_files)', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  scribe:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    const router = makeRouter();
    await assert.rejects(
      () => router.invoke('scribe', 'gather', { other_document_files: ['doc.yaml'] }),
      ContextBudgetViolationError,
    );
  });

  test('allows empty context when no keys are forbidden or required', async () => {
    // Use a role with no context_budget at all (not in our test YAMLs — use a custom one)
    mkdirSync(join(specDir), { recursive: true });
    writeFileSync(
      join(specDir, 'auditor.yaml'),
      `role: auditor\noutput_schema: {}\noutput_validation: []\nhard_constraints: []\n`,
    );
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  auditor:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    const fake = new FakeAdapter('fake', 'fake-model-1');
    const router = new Router({ repoDir: tmpDir, specDir });
    router.registerAdapter('fake', fake);

    await router.invoke('auditor', 'verify', {});
    assert.equal(fake.lastInvokedRole, 'auditor');
  });
});

// ---------------------------------------------------------------------------
// Constitution injection
// ---------------------------------------------------------------------------

describe('constitution injection', () => {
  test('constitution passed to adapter is non-null and non-empty', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: fake\n    model: fake-model-1\n`,
    );

    const fake = new FakeAdapter('fake', 'fake-model-1');
    const router = new Router({ repoDir: tmpDir, specDir });
    router.registerAdapter('fake', fake);

    await router.invoke('architect', 'init', { learning_brief: {} });

    assert(fake.lastConstitution !== null);
    assert((fake.lastConstitution?.length ?? 0) > 0, 'constitution must be non-empty');
  });

  test('constitution includes all five directives (EC-D1 through EC-D5)', () => {
    const constitution = assembleConstitution();

    for (let i = 1; i <= 5; i++) {
      assert(
        constitution.includes(`EC-D${i}`),
        `constitution must include directive EC-D${i}`,
      );
    }
  });

  test('constitution includes the core statement verbatim excerpt', () => {
    const constitution = assembleConstitution();
    assert(
      constitution.includes('Your highest obligation is accuracy'),
      'constitution must include core statement text',
    );
  });

  test('assembleConstitution returns the same string on repeated calls (cached)', () => {
    const first = assembleConstitution();
    const second = assembleConstitution();
    assert.equal(first, second);
  });
});

// ---------------------------------------------------------------------------
// Adapter registration and routing
// ---------------------------------------------------------------------------

describe('adapter routing', () => {
  test('routes to registered adapter based on config', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: fake\n    model: test-model\n`,
    );

    const fake = new FakeAdapter('fake', 'test-model');
    const router = new Router({ repoDir: tmpDir, specDir });
    router.registerAdapter('fake', fake);

    const result = await router.invoke('architect', 'init', { learning_brief: {} });

    assert.equal(result.model_id, 'test-model');
  });

  test('throws UnknownAdapterError when configured adapter is not registered', async () => {
    mkdirSync(join(tmpDir, '.omoikane'), { recursive: true });
    writeFileSync(
      join(tmpDir, '.omoikane', 'config.yaml'),
      `agents:\n  architect:\n    adapter: nonexistent\n    model: some-model\n`,
    );

    const router = new Router({ repoDir: tmpDir, specDir });

    await assert.rejects(
      () => router.invoke('architect', 'init', { learning_brief: {} }),
      UnknownAdapterError,
    );
  });

  test('FakeAdapter satisfies the Adapter interface', () => {
    const fake = new FakeAdapter();
    assert.equal(typeof fake.invoke, 'function');
    assert.equal(typeof fake.smoke_test, 'function');
    assert.equal(typeof fake.get_model_id, 'function');
    assert.equal(typeof fake.get_adapter_id, 'function');
    assert.equal(fake.get_adapter_id(), 'fake');
    assert.equal(fake.get_model_id(), 'fake-model-1');
  });
});
