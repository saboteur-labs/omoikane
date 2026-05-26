import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { Adapter, SmokeTestResult } from '../adapters/interface.ts';
import type { StateManager } from '../state/state_manager.ts';
import { assembleConstitution } from '../constitution.ts';
import { createCheckpoint } from '../checkpoints/registry.ts';
import { smokeTestsPath, toDateStamp } from '../state/paths.ts';
import { evaluateCase, type SmokeTestCase } from './evaluators.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TrustStatus = 'untrusted' | 'trusted' | 'blocked' | 'low-trust';

export interface SmokeRunResult {
  role: string;
  all_passed: boolean;
  adapter_id: string;
  model_id: string;
  ran_at: string;
  cases: SmokeTestResult[];
}

export interface SmokeRunOptions {
  specDir?: string;
  constitutionPath?: string;
  date?: string;
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export class SmokeTestSpecNotFoundError extends Error {
  constructor(role: string) {
    super(`Smoke test spec not found for role: '${role}'`);
    this.name = 'SmokeTestSpecNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal types (file format)
// ---------------------------------------------------------------------------

interface SmokeTestSpec {
  schema_version: string;
  role: string;
  description: string;
  cases: SmokeTestCase[];
}

interface RoleSmokeRecord {
  trust_status: TrustStatus;
  last_run_at: string;
  last_run_adapter: string;
  last_run_model: string;
  cases: SmokeTestResult[];
}

interface SmokeTestsFile {
  schema_version: string;
  roles: Record<string, RoleSmokeRecord>;
}

// ---------------------------------------------------------------------------
// Spec loading
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC_DIR = resolve(__dirname, '..', '..', '..', 'spec', 'machine', 'agents');

function loadSmokeTestSpec(role: string, specDir: string = DEFAULT_SPEC_DIR): SmokeTestSpec {
  const filePath = resolve(specDir, `${role}_smoke_test.yaml`);
  if (!existsSync(filePath)) throw new SmokeTestSpecNotFoundError(role);
  return yaml.load(readFileSync(filePath, 'utf8')) as SmokeTestSpec;
}

// ---------------------------------------------------------------------------
// smoke_tests.yaml read/write
// ---------------------------------------------------------------------------

function readSmokeTestsFile(repoDir: string): SmokeTestsFile {
  const p = smokeTestsPath(repoDir);
  if (!existsSync(p)) return { schema_version: '1.0', roles: {} };
  return yaml.load(readFileSync(p, 'utf8')) as SmokeTestsFile;
}

function writeSmokeTestsFile(repoDir: string, data: SmokeTestsFile): void {
  const finalPath = smokeTestsPath(repoDir);
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, yaml.dump(data, { lineWidth: 120 }), 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Runs all smoke test cases for a role through the configured adapter.
 * Writes results to .omoikane/smoke_tests.yaml and creates CP-SMK-1 (pass)
 * or CP-SMK-2 (fail) checkpoints in the manifest.
 */
export async function runSmokeTests(
  repoDir: string,
  sm: StateManager,
  adapter: Adapter,
  role: string,
  options?: SmokeRunOptions,
): Promise<SmokeRunResult> {
  const spec = loadSmokeTestSpec(role, options?.specDir);
  const constitution = assembleConstitution(options?.constitutionPath);
  const ran_at = new Date().toISOString();
  const date = options?.date ?? toDateStamp();

  const caseResults: SmokeTestResult[] = [];

  for (const testCase of spec.cases) {
    let result: SmokeTestResult;

    if (testCase.type === 'connectivity') {
      result = await adapter.smoke_test(role, testCase as unknown as Record<string, unknown>);
    } else {
      try {
        const response = await adapter.invoke(role, testCase.input, constitution);
        result = evaluateCase(testCase, response, role);
      } catch (err) {
        result = {
          test_id: testCase.id,
          passed: false,
          failure_reason: err instanceof Error ? err.message : String(err),
        };
      }
    }

    caseResults.push(result);
  }

  const all_passed = caseResults.every((r) => r.passed);

  // Persist results
  const file = readSmokeTestsFile(repoDir);
  file.roles[role] = {
    trust_status: all_passed ? 'trusted' : 'blocked',
    last_run_at: ran_at,
    last_run_adapter: adapter.get_adapter_id(),
    last_run_model: adapter.get_model_id(),
    cases: caseResults,
  };
  writeSmokeTestsFile(repoDir, file);

  // Create checkpoint
  if (all_passed) {
    createCheckpoint(repoDir, sm, {
      prefix: 'SMK',
      type: 'inform',
      produced_by: 'runner',
      affected_object_id: role,
      description: `Smoke test passed. Role '${role}' is trusted for this adapter/model.`,
    }, date);
  } else {
    createCheckpoint(repoDir, sm, {
      prefix: 'SMK',
      type: 'block',
      produced_by: 'runner',
      affected_object_id: role,
      description: `Smoke test failed for role '${role}'. Role is blocked. ` +
        'Reconfigure the adapter/model or override to proceed with low-trust outputs.',
      principle_ref: 'P2',
    }, date);
  }

  return {
    role,
    all_passed,
    adapter_id: adapter.get_adapter_id(),
    model_id: adapter.get_model_id(),
    ran_at,
    cases: caseResults,
  };
}

/**
 * Returns the current trust status for a role.
 * Returns 'untrusted' if no smoke tests have ever been run for the role.
 */
export function readTrustStatus(repoDir: string, role: string): TrustStatus {
  const file = readSmokeTestsFile(repoDir);
  return file.roles[role]?.trust_status ?? 'untrusted';
}

/**
 * Sets a role's trust status to 'low-trust' after a researcher overrides
 * a CP-SMK-2 block checkpoint. Call this from the resolve command handler
 * when it detects an override action on a CP-SMK-2 checkpoint.
 */
export function applyLowTrustOverride(repoDir: string, role: string): void {
  const file = readSmokeTestsFile(repoDir);

  if (!file.roles[role]) {
    file.roles[role] = {
      trust_status: 'low-trust',
      last_run_at: new Date().toISOString(),
      last_run_adapter: 'unknown',
      last_run_model: 'unknown',
      cases: [],
    };
  } else {
    file.roles[role].trust_status = 'low-trust';
  }

  writeSmokeTestsFile(repoDir, file);
}
