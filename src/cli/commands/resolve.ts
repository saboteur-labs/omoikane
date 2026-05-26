import type { ParsedCommand } from '../types.ts';

export async function handleResolve(command: ParsedCommand): Promise<void> {
  // Act on an open checkpoint; valid actions depend on the checkpoint type
  process.stderr.write(
    `Not yet implemented: resolve ${command.checkpointId} --action ${command.action}\n`,
  );
}
