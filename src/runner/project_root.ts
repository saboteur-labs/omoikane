import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks up from the caller's file location until it finds a directory that
 * contains `spec/machine/agents`. Works for both the source tree
 * (src/runner/...) and the esbuild bundle (dist/omoikane.js), where all
 * modules report import.meta.url as the bundle file.
 */
export function findProjectRoot(callerMetaUrl: string): string {
  let dir = dirname(fileURLToPath(callerMetaUrl));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, 'spec', 'machine', 'agents'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`Could not locate project root (spec/machine/agents) starting from ${dir}`);
}
