import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';

export interface AgentConfig {
  adapter: string;
  model: string;
}

export interface OmoikaneConfig {
  agents: Record<string, AgentConfig>;
}

const DEFAULT_ADAPTER = 'claude';
const DEFAULT_MODEL = 'claude-sonnet-4-6';

const KNOWN_ROLES = ['architect', 'scribe', 'critic', 'auditor', 'cartographer', 'methodologist'];

function defaults(): OmoikaneConfig {
  const agents: Record<string, AgentConfig> = {};
  for (const role of KNOWN_ROLES) {
    agents[role] = { adapter: DEFAULT_ADAPTER, model: DEFAULT_MODEL };
  }
  return { agents };
}

export function loadConfig(repoDir: string): OmoikaneConfig {
  const configPath = resolve(repoDir, '.omoikane', 'config.yaml');
  if (!existsSync(configPath)) return defaults();

  const raw = readFileSync(configPath, 'utf8');
  const parsed = yaml.load(raw) as Partial<OmoikaneConfig>;

  const base = defaults();
  if (parsed?.agents) {
    for (const [role, cfg] of Object.entries(parsed.agents)) {
      base.agents[role] = cfg;
    }
  }
  return base;
}
