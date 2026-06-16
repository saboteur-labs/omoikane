import type { ParsedCommand } from '../types.ts';

export async function handleReview(_command: ParsedCommand): Promise<void> {
  // List all open checkpoints: block first, then review, then inform
  process.stderr.write('Not yet implemented: review\n');
}
