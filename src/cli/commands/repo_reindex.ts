import type { ParsedCommand } from '../types.ts';
import { reindexRepo } from '../../runner/state/reindex.ts';

export async function handleRepoReindex(_command: ParsedCommand): Promise<void> {
  const summary = reindexRepo(process.cwd());
  process.stdout.write(
    `Reindex complete.\n` +
    `  files_read:        ${summary.files_read}\n` +
    `  records_indexed:   ${summary.records_indexed}\n` +
    `  warnings_produced: ${summary.warnings_produced}\n`,
  );
}
