import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import yaml from 'js-yaml';
import type { ParsedCommand } from '../types.ts';
import type { Adapter } from '../../runner/adapters/interface.ts';
import { AdapterParseError } from '../../runner/adapters/interface.ts';
import { loadConfig, writeDefaultConfig, KNOWN_ROLES, type OmoikaneConfig } from '../../runner/config.ts';
import { StateManager, RepoAlreadyInitialisedError } from '../../runner/state/state_manager.ts';
import { manifestPath, learningBriefPath } from '../../runner/state/paths.ts';
import { planReset, executeReset, describeTarget, CONFIG_REL } from '../../runner/state/reset.ts';
import { assembleConstitution } from '../../runner/constitution.ts';
import { validate } from '../../runner/validation/validator.ts';
import { createBootstrapPrompts } from '../../runner/bootstrap_prompts.ts';
import { runSmokeTests, SmokeTestBlockedError } from '../../runner/smoke/runner.ts';
import { buildAdapter } from './agent.ts';

// Roles active in Phase 1 — only these are smoke-tested during init.
const PHASE_1_ROLES = ['architect', 'scribe'];

export interface RepoInitOptions {
  promptFn?: (question: string) => Promise<string>;
  adapterFactory?: (role: string, config: OmoikaneConfig) => Adapter;
  specDir?: string;
}

export async function runRepoInit(repoDir: string, options: RepoInitOptions = {}): Promise<void> {
  const prompt = options.promptFn ?? defaultPromptFn;
  const makeAdapter = options.adapterFactory ?? buildAdapter;

  // 1. Fail fast if already initialised (before any API call).
  if (existsSync(manifestPath(repoDir))) {
    throw new RepoAlreadyInitialisedError(repoDir);
  }

  // 2. Write default config if not present, then load it.
  writeDefaultConfig(repoDir);
  const config = loadConfig(repoDir);

  // 3. Collect researcher input.
  process.stdout.write('\n=== Omoikane — Initialising knowledge repo ===\n\n');
  const subject = await prompt('What is the subject of this knowledge repo? ');
  const goal = await prompt('What is your research goal? ');
  const prior_knowledge = await prompt(
    'Describe your prior knowledge on this subject (or "none"): ',
  );
  const anglesRaw = await prompt(
    'What are your priority research angles? (comma-separated): ',
  );
  const priority_angles = anglesRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const definition_of_done = await prompt('How will you know when you have learned enough? ');

  const context: Record<string, unknown> = {
    command: 'init',
    subject,
    goal,
    prior_knowledge,
    priority_angles,
    definition_of_done,
  };

  // 4. Invoke Architect.
  process.stdout.write('\nInvoking Architect...\n');
  const constitution = assembleConstitution();
  const architectAdapter = makeAdapter('architect', config);
  const response = await architectAdapter.invoke('architect', context, constitution);

  // 5. Validate output — structural + ARC-OV1.
  const valResult = validate('architect', 'init', response.parsed);
  if (!valResult.valid) {
    const msgs = valResult.violations.map((v) => `  - [${v.ruleId}] ${v.message}`).join('\n');
    throw new AdapterParseError(`Architect init output failed validation:\n${msgs}`);
  }

  // 6. Show brief and confirm with researcher.
  const brief = response.parsed as Record<string, unknown>;
  const questionsAsked = brief.questions_asked as Array<{ question: string; answer: string }>;

  process.stdout.write('\n--- Learning brief ---\n');
  process.stdout.write(`Subject:            ${brief.subject}\n`);
  process.stdout.write(`Goal:               ${brief.goal}\n`);
  process.stdout.write(`Prior knowledge:    ${brief.prior_knowledge}\n`);
  const angles = (brief.priority_angles as string[]).map((a) => `  - ${a}`).join('\n');
  process.stdout.write(`Priority angles:\n${angles}\n`);
  process.stdout.write(`Definition of done: ${brief.definition_of_done}\n`);
  if (questionsAsked.length > 0) {
    process.stdout.write('\nQuestions asked:\n');
    for (const qa of questionsAsked) {
      process.stdout.write(`  Q: ${qa.question}\n  A: ${qa.answer}\n`);
    }
  }
  process.stdout.write('----------------------\n\n');

  const confirm = await prompt('Proceed with this learning brief? [y/N] ');
  if (!confirm.trim().toLowerCase().startsWith('y')) {
    process.stdout.write('Init cancelled.\n');
    return;
  }

  // 7. Initialise repo: create directory structure and write manifest.
  const sm = new StateManager(repoDir);
  sm.initRepo(subject, 'learning_brief.yaml');

  // 8. Write learning_brief.yaml atomically.
  const briefPath = learningBriefPath(repoDir);
  const tmpPath = `${briefPath}.tmp`;
  const briefData = { schema_version: '1.0', ...brief };
  writeFileSync(tmpPath, yaml.dump(briefData, { lineWidth: 120 }), 'utf8');
  renameSync(tmpPath, briefPath);

  // 9. Create bootstrap prompt entries.
  const { promptIds } = createBootstrapPrompts(repoDir);
  process.stdout.write(`\nCreated bootstrap prompts: ${promptIds.join(', ')}\n`);

  // 10. Run smoke tests for Phase 1 roles.
  process.stdout.write('\nRunning smoke tests...\n');
  const rolesToTest = PHASE_1_ROLES.filter((r) => KNOWN_ROLES.includes(r));

  for (const role of rolesToTest) {
    process.stdout.write(`\nRole: ${role}\n`);
    const roleAdapter = makeAdapter(role, config);
    const smokeResult = await runSmokeTests(repoDir, sm, roleAdapter, role, {
      specDir: options.specDir,
    });
    for (const c of smokeResult.cases) {
      const label = c.passed ? 'PASS' : 'FAIL';
      const reason = c.passed ? '' : ` — ${c.failure_reason ?? ''}`;
      process.stdout.write(`  [${label}] ${c.test_id}${reason}\n`);
    }
    if (!smokeResult.all_passed) {
      throw new SmokeTestBlockedError(role);
    }
  }

  process.stdout.write('\nAll smoke tests passed. Repository initialised.\n');
}

export async function handleRepo(command: ParsedCommand): Promise<void> {
  if (command.id !== 'repo_init') {
    process.stderr.write(`Not yet implemented: ${command.id}\n`);
    return;
  }
  const repoDir = process.cwd();
  await runRepoInit(repoDir);
}

// ---------------------------------------------------------------------------
// repo reset — restore the repo to its starting state (pre-init)
// ---------------------------------------------------------------------------

export async function handleRepoReset(command: ParsedCommand): Promise<void> {
  const repoDir = process.cwd();
  const { targets, keptConfig } = planReset(repoDir, { keepConfig: command.keepConfig });

  if (targets.length === 0) {
    process.stdout.write('Already at starting state — nothing to remove.\n');
    return;
  }

  process.stdout.write(command.dryRun ? 'Would remove:\n' : 'Will remove:\n');
  for (const rel of targets) {
    process.stdout.write(`  - ${describeTarget(repoDir, rel)}\n`);
  }
  if (keptConfig) {
    process.stdout.write(`\nKeeping: ${CONFIG_REL}\n`);
  }

  if (command.dryRun) {
    process.stdout.write('\nDry run — nothing removed.\n');
    return;
  }

  if (!command.yes) {
    const answer = await defaultPromptFn(
      '\nPermanently remove these and reset to starting state? [y/N] ',
    );
    if (!answer.trim().toLowerCase().startsWith('y')) {
      process.stdout.write('Aborted. Nothing removed.\n');
      return;
    }
  }

  executeReset(repoDir, targets);
  process.stdout.write('\nRepository restored to starting state.\n');
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
