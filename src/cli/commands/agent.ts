import type { ParsedCommand } from '../types.ts';

export async function handleAgent(command: ParsedCommand): Promise<void> {
  // Re-run smoke test for the specified agent role; update .omoikane/smoke_tests.yaml
  process.stderr.write(`Not yet implemented: agent test ${command.role}\n`);
}
