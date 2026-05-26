import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import type { AgentSpec } from './types.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SPEC_DIR = resolve(__dirname, '..', '..', '..', 'spec', 'machine', 'agents');

const cache = new Map<string, AgentSpec>();

export function loadAgentSpec(role: string, specDir: string = DEFAULT_SPEC_DIR): AgentSpec {
  const cacheKey = `${specDir}:${role}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey)!;

  const filePath = resolve(specDir, `${role}.yaml`);
  const raw = readFileSync(filePath, 'utf8');
  const parsed = yaml.load(raw) as AgentSpec;

  cache.set(cacheKey, parsed);
  return parsed;
}

export function clearCache(): void {
  cache.clear();
}
