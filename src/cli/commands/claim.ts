import type { ParsedCommand } from '../types.ts';

export async function handleClaim(command: ParsedCommand): Promise<void> {
  if (command.id === 'claim_correct') {
    // Correct claim content; record a user_correction signal event
    process.stderr.write(`Not yet implemented: claim correct ${command.claimId}\n`);
  } else {
    // Retract a claim; claim is retained in the document with status 'retracted'
    process.stderr.write(`Not yet implemented: claim retract ${command.claimId}\n`);
  }
}
