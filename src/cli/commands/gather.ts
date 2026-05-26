import type { ParsedCommand } from '../types.ts';
import {
  runGather,
  runGatherNext,
  GatherOutlineNotReadyError,
  GatherNodeNotFoundError,
  GatherNodeNotGatherableError,
  GatherNodeBlockedError,
  GatherNothingTodoError,
  GatherPromptNotFoundError,
} from '../../runner/gather_pipeline.ts';
import { buildAdapter } from './agent.ts';

export {
  GatherOutlineNotReadyError,
  GatherNodeNotFoundError,
  GatherNodeNotGatherableError,
  GatherNodeBlockedError,
  GatherNothingTodoError,
  GatherPromptNotFoundError,
};

export async function handleGather(command: ParsedCommand): Promise<void> {
  const repoDir = process.cwd();
  const options = { adapterFactory: buildAdapter };

  if (command.id === 'gather_next') {
    return runGatherNext(repoDir, options);
  } else {
    return runGather(repoDir, command.nodeId!, command.promptId, options);
  }
}
