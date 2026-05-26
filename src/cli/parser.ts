import type { ParseResult } from './types.ts';

/**
 * Parses process.argv (after stripping the first two elements) into a
 * typed ParseResult. Each command maps to a spec command id from
 * spec/machine/cli/commands.yaml.
 */
export function parseArgs(argv: string[]): ParseResult {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { type: 'help' };
  }

  const [first, second, third, ...rest] = argv;

  switch (first) {
    case 'repo':
      if (second === 'init') return { type: 'command', command: { id: 'repo_init' } };
      return { type: 'error', message: `Unknown repo subcommand: ${second ?? '(none)'}. Expected: init` };

    case 'status':
      return { type: 'command', command: { id: 'status' } };

    case 'outline': {
      if (!second) return { type: 'command', command: { id: 'outline' } };
      if (second === 'approve') return { type: 'command', command: { id: 'outline_approve' } };
      if (second === 'amend') {
        if (!third) return { type: 'error', message: 'outline amend requires <node-id>' };
        return { type: 'command', command: { id: 'outline_amend', nodeId: third } };
      }
      return { type: 'error', message: `Unknown outline subcommand: ${second}. Expected: approve | amend <node-id>` };
    }

    case 'gather': {
      if (!second) return { type: 'error', message: 'gather requires <node-id> or --next' };
      if (second === '--next') return { type: 'command', command: { id: 'gather_next' } };

      // second is a node-id; check for optional --prompt flag
      const allArgs = [second, third, ...rest].filter(Boolean) as string[];
      const promptIdx = allArgs.indexOf('--prompt');
      const promptId = promptIdx !== -1 ? allArgs[promptIdx + 1] : undefined;

      if (promptIdx !== -1 && !promptId) {
        return { type: 'error', message: 'gather --prompt requires a prompt id' };
      }

      return { type: 'command', command: { id: 'gather', nodeId: second, promptId } };
    }

    case 'review':
      return { type: 'command', command: { id: 'review' } };

    case 'resolve': {
      if (!second) return { type: 'error', message: 'resolve requires <checkpoint-id>' };
      const allArgs = [third, ...rest].filter(Boolean) as string[];
      const actionIdx = allArgs.indexOf('--action');
      const action = actionIdx !== -1 ? allArgs[actionIdx + 1] : undefined;
      if (!action) return { type: 'error', message: 'resolve requires --action <action>' };
      return { type: 'command', command: { id: 'resolve', checkpointId: second, action } };
    }

    case 'claim': {
      if (second === 'correct') {
        if (!third) return { type: 'error', message: 'claim correct requires <claim-id>' };
        return { type: 'command', command: { id: 'claim_correct', claimId: third } };
      }
      if (second === 'retract') {
        if (!third) return { type: 'error', message: 'claim retract requires <claim-id>' };
        return { type: 'command', command: { id: 'claim_retract', claimId: third } };
      }
      return {
        type: 'error',
        message: `Unknown claim subcommand: ${second ?? '(none)'}. Expected: correct | retract`,
      };
    }

    case 'agent': {
      if (second === 'test') {
        if (!third) return { type: 'error', message: 'agent test requires <role>' };
        return { type: 'command', command: { id: 'agent_test', role: third } };
      }
      return {
        type: 'error',
        message: `Unknown agent subcommand: ${second ?? '(none)'}. Expected: test <role>`,
      };
    }

    default:
      return { type: 'error', message: `Unknown command: ${first}. Run omoikane --help for usage.` };
  }
}
