import { createInterface } from 'node:readline';
import type { ParsedCommand } from '../types.ts';
import type { Adapter } from '../../runner/adapters/interface.ts';
import { AdapterConnectionError } from '../../runner/adapters/interface.ts';
import { ClaudeAdapter } from '../../runner/adapters/claude.ts';
import { CustomAdapter } from '../../runner/adapters/custom.ts';
import { loadConfig, KNOWN_ROLES, type OmoikaneConfig } from '../../runner/config.ts';
import { StateManager } from '../../runner/state/state_manager.ts';
import {
  runSmokeTests,
  readTrustStatus,
  applyLowTrustOverride,
  SmokeTestBlockedError,
} from '../../runner/smoke/runner.ts';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AgentTestOptions {
  promptFn?: (question: string) => Promise<string>;
  specDir?: string;
}

// ---------------------------------------------------------------------------
// Core logic (exported for tests)
// ---------------------------------------------------------------------------

export async function runAgentTest(
  repoDir: string,
  sm: StateManager,
  adapter: Adapter,
  role: string,
  options: AgentTestOptions = {},
): Promise<void> {
  const priorStatus = readTrustStatus(repoDir, role);

  process.stdout.write(`Running smoke tests for role '${role}'...\n`);

  const result = await runSmokeTests(repoDir, sm, adapter, role, { specDir: options.specDir });

  for (const c of result.cases) {
    const label = c.passed ? 'PASS' : 'FAIL';
    const reason = c.passed ? '' : ` — ${c.failure_reason ?? ''}`;
    process.stdout.write(`  [${label}] ${c.test_id}${reason}\n`);
  }

  if (!result.all_passed) {
    process.stdout.write(`\nSmoke tests failed. Role '${role}' is blocked.\n`);
    throw new SmokeTestBlockedError(role);
  }

  if (priorStatus === 'low-trust' || priorStatus === 'blocked') {
    const prompt = options.promptFn ?? defaultPromptFn;
    const answer = await prompt(
      `\nRole '${role}' was previously '${priorStatus}' but has now passed all smoke tests.\n` +
        `Clear the low-trust flag and mark as trusted? [y/N] `,
    );
    if (!answer.trim().toLowerCase().startsWith('y')) {
      applyLowTrustOverride(repoDir, role);
      process.stdout.write(`Re-trust declined. Role '${role}' remains low-trust.\n`);
      return;
    }
    process.stdout.write(`Re-trust confirmed. Role '${role}' is now trusted.\n`);
  }

  process.stdout.write(`\nAll smoke tests passed. Role '${role}' is trusted.\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function handleAgent(command: ParsedCommand): Promise<void> {
  const role = command.role!;
  const repoDir = process.cwd();

  if (!KNOWN_ROLES.includes(role)) {
    process.stderr.write(
      `Error: Unknown role '${role}'. Known roles: ${KNOWN_ROLES.join(', ')}\n`,
    );
    process.exit(1);
  }

  const config = loadConfig(repoDir);
  const adapter = buildAdapter(role, config);
  const sm = new StateManager(repoDir);

  await runAgentTest(repoDir, sm, adapter, role);
}

// ---------------------------------------------------------------------------
// Adapter factory
// ---------------------------------------------------------------------------

type AgentConfigExtended = { adapter: string; model?: string; url?: string };

export function buildAdapter(role: string, config: OmoikaneConfig): Adapter {
  const agentConfig = config.agents[role] as AgentConfigExtended | undefined;
  const adapterId = agentConfig?.adapter ?? 'claude';
  const model = agentConfig?.model;

  if (adapterId === 'claude') {
    return new ClaudeAdapter({ model });
  }
  if (adapterId === 'custom') {
    const url = agentConfig?.url;
    if (!url) {
      throw new AdapterConnectionError(
        `Custom adapter for role '${role}' requires a url field in .omoikane/config.yaml`,
      );
    }
    return new CustomAdapter({ url, model });
  }
  throw new AdapterConnectionError(`Unknown adapter '${adapterId}' configured for role '${role}'`);
}

// ---------------------------------------------------------------------------
// Default stdin prompt
// ---------------------------------------------------------------------------

function defaultPromptFn(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
