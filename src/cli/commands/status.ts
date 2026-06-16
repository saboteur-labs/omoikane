import type { ParsedCommand } from '../types.ts';

export async function handleStatus(_command: ParsedCommand): Promise<void> {
  // status: display subject, outline version, per-node progress, open checkpoints
  process.stderr.write('Not yet implemented: status\n');
}
