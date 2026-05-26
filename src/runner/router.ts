import type { Adapter, AgentResponse } from './adapters/interface.ts';
import { loadAgentSpec } from './validation/schema_loader.ts';
import { assembleConstitution } from './constitution.ts';
import { loadConfig } from './config.ts';

export class ContextBudgetViolationError extends Error {
  constructor(public readonly role: string, public readonly key: string) {
    super(`Context budget violation for role '${role}': key '${key}' is forbidden`);
    this.name = 'ContextBudgetViolationError';
  }
}

export class UnknownAdapterError extends Error {
  constructor(public readonly adapterId: string) {
    super(`Unknown adapter: '${adapterId}'`);
    this.name = 'UnknownAdapterError';
  }
}

export class Router {
  private adapters: Map<string, Adapter>;
  private repoDir: string;
  private specDir?: string;

  constructor(options: { repoDir: string; specDir?: string }) {
    this.adapters = new Map();
    this.repoDir = options.repoDir;
    this.specDir = options.specDir;
  }

  registerAdapter(id: string, adapter: Adapter): void {
    this.adapters.set(id, adapter);
  }

  async invoke(
    role: string,
    command: string,
    context: Record<string, unknown>,
  ): Promise<AgentResponse> {
    this.enforceContextBudget(role, context);

    const adapter = this.resolveAdapter(role);
    const constitution = assembleConstitution();

    return adapter.invoke(role, context, constitution);
  }

  private enforceContextBudget(role: string, context: Record<string, unknown>): void {
    const spec = loadAgentSpec(role, this.specDir);
    const forbidden = spec.context_budget?.forbidden ?? [];

    for (const key of Object.keys(context)) {
      if (forbidden.includes(key)) {
        throw new ContextBudgetViolationError(role, key);
      }
    }
  }

  private resolveAdapter(role: string): Adapter {
    const config = loadConfig(this.repoDir);
    const agentConfig = config.agents[role];
    const adapterId = agentConfig?.adapter ?? 'claude';

    const adapter = this.adapters.get(adapterId);
    if (!adapter) throw new UnknownAdapterError(adapterId);

    return adapter;
  }
}
