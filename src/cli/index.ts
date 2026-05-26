import { parseArgs } from './parser.ts';
import { handleRepo } from './commands/repo.ts';
import { handleStatus } from './commands/status.ts';
import { handleOutline } from './commands/outline.ts';
import { handleGather } from './commands/gather.ts';
import { handleReview } from './commands/review.ts';
import { handleResolve } from './commands/resolve.ts';
import { handleClaim } from './commands/claim.ts';
import { handleAgent } from './commands/agent.ts';
import type { ParsedCommand } from './types.ts';
import {
  AdapterConnectionError,
  AdapterTimeoutError,
  AdapterRateLimitError,
  AdapterParseError,
} from '../runner/adapters/interface.ts';

const HELP = `
Omoikane — AI-augmented research and learning tool

Usage: omoikane <command> [arguments] [flags]

Commands:
  repo init                                   Initialise a new knowledge repo
  status                                      Show repo state at a glance
  outline                                     Generate or revise the outline
  outline approve                             Approve the draft outline
  outline amend <node-id>                     Amend an outline node after approval
  gather <node-id> [--prompt <prompt-id>]     Gather on a specific outline node
  gather --next                               Gather the next ungathered node
  review                                      List all open checkpoints
  resolve <checkpoint-id> --action <action>   Act on an open checkpoint
  claim correct <claim-id>                    Correct a claim
  claim retract <claim-id>                    Retract a claim
  agent test <role>                           Re-run smoke test for an agent role

Exit codes:
  0  Success
  1  Unknown action for this checkpoint type
  2  Precondition failed (specific reason in stderr)
  3  Agent output failed validation (specific rule in stderr)
  4  Smoke test failed — role blocked
  5  Adapter connectivity error

Run omoikane <command> --help for details on a specific command.
`.trim();

async function dispatch(command: ParsedCommand): Promise<void> {
  switch (command.id) {
    case 'repo_init':
      return handleRepo(command);
    case 'status':
      return handleStatus(command);
    case 'outline':
    case 'outline_approve':
    case 'outline_amend':
      return handleOutline(command);
    case 'gather':
    case 'gather_next':
      return handleGather(command);
    case 'review':
      return handleReview(command);
    case 'resolve':
      return handleResolve(command);
    case 'claim_correct':
    case 'claim_retract':
      return handleClaim(command);
    case 'agent_test':
      return handleAgent(command);
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(argv);

  if (parsed.type === 'help') {
    process.stdout.write(HELP + '\n');
    process.exit(0);
  }

  if (parsed.type === 'error') {
    process.stderr.write(`Error: ${parsed.message}\n\nRun omoikane --help for usage.\n`);
    process.exit(2);
  }

  await dispatch(parsed.command);
}

function handleFatalError(err: unknown): never {
  if (err instanceof AdapterConnectionError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(5);
  }
  if (err instanceof AdapterTimeoutError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(5);
  }
  if (err instanceof AdapterRateLimitError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(5);
  }
  if (err instanceof AdapterParseError) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exit(3);
  }
  if (err instanceof Error) {
    process.stderr.write(`Unexpected error: ${err.message}\n`);
  } else {
    process.stderr.write(`Unexpected error: ${String(err)}\n`);
  }
  process.exit(1);
}

main().catch(handleFatalError);
