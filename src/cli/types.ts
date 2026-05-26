export type CommandId =
  | 'repo_init'
  | 'repo_reindex'
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
}

export type ParseResult =
  | { type: 'command'; command: ParsedCommand }
  | { type: 'help' }
  | { type: 'error'; message: string };

export interface CommandHandler {
  (command: ParsedCommand): Promise<void>;
}
