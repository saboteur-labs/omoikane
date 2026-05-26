import type { ParsedCommand } from '../types.ts';

export async function handleOutline(command: ParsedCommand): Promise<void> {
  switch (command.id) {
    case 'outline':
      // Generate or revise the outline via the Architect
      process.stderr.write('Not yet implemented: outline\n');
      break;
    case 'outline_approve':
      // Approve the draft outline, unlocking gather
      process.stderr.write('Not yet implemented: outline approve\n');
      break;
    case 'outline_amend':
      // Amend a specific outline node after approval
      process.stderr.write(`Not yet implemented: outline amend ${command.nodeId}\n`);
      break;
  }
}
