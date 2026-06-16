export type CommandId =
  | 'repo_init'
  | 'repo_reindex'
  | 'repo_reset'
  | 'status'
  | 'outline'
  | 'outline_approve'
  | 'outline_amend'
  | 'gather'
  | 'gather_next'
  | 'review'
  | 'resolve'
  | 'claim_correct'
  | 'claim_retract'
  | 'agent_test';

export interface ParsedCommand {
  id: CommandId;
  nodeId?: string;
  promptId?: string;
  checkpointId?: string;
  action?: string;
  claimId?: string;
  role?: string;
  yes?: boolean;
  dryRun?: boolean;
  keepConfig?: boolean;
}

export type ParseResult =
  | { type: 'command'; command: ParsedCommand }
  | { type: 'help' }
  | { type: 'error'; message: string };

export interface CommandHandler {
  (command: ParsedCommand): Promise<void>;
}
