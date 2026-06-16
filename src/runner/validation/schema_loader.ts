import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import yaml from 'js-yaml';
import type { AgentSpec } from './types.ts';
import { findProjectRoot } from '../project_root.ts';

const DEFAULT_SPEC_DIR = join(findProjectRoot(import.meta.url), 'spec', 'machine', 'agents');

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
