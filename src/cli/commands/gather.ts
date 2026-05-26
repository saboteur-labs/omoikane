import type { ParsedCommand } from '../types.ts';

export async function handleGather(command: ParsedCommand): Promise<void> {
  if (command.id === 'gather_next') {
    // Gather the next ungathered node in outline order with no open block checkpoints
    process.stderr.write('Not yet implemented: gather --next\n');
  } else {
    // Gather a specific outline node using the active prompt (or --prompt override)
    const promptSuffix = command.promptId ? ` --prompt ${command.promptId}` : '';
    process.stderr.write(`Not yet implemented: gather ${command.nodeId}${promptSuffix}\n`);
  }
}
