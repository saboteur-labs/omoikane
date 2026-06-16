import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Restores a knowledge repo to its "starting state" — the state before
 * `omoikane repo init` was ever run. The reset only ever touches the fixed
 * set of paths Omoikane generates (manifest, outline, learning brief, and the
 * documents/ gaps/ prompts/ .omoikane/ directories), so it can never delete
 * repo source even if pointed at the wrong directory.
 */

// Fixed artifacts produced by init / outline / gather, relative to the repo root.
const ARTIFACTS = [
  'manifest.yaml',
  'outline.yaml',
  'learning_brief.yaml',
  'documents',
  'gaps',
  'prompts',
  '.omoikane',
] as const;

/** Adapter/model configuration that --keep-config preserves. */
export const CONFIG_REL = join('.omoikane', 'config.yaml');

export interface ResetOptions {
  /** Preserve .omoikane/config.yaml (adapter/model choices). */
  keepConfig?: boolean;
}

export interface ResetPlan {
  /** Repo-relative paths that exist and will be removed. */
  targets: string[];
  /** True if config.yaml was present and is being preserved. */
  keptConfig: boolean;
}

/** Computes which artifacts actually exist and would be removed. Reads only. */
export function planReset(repoDir: string, options: ResetOptions = {}): ResetPlan {
  const targets: string[] = [];
  let keptConfig = false;

  for (const artifact of ARTIFACTS) {
    if (artifact === '.omoikane' && options.keepConfig) {
      // Remove .omoikane contents individually, sparing config.yaml.
      const dir = join(repoDir, '.omoikane');
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const rel = join('.omoikane', entry);
        if (rel === CONFIG_REL) {
          keptConfig = true;
          continue;
        }
        targets.push(rel);
      }
      continue;
    }
    if (existsSync(join(repoDir, artifact))) targets.push(artifact);
  }

  return { targets, keptConfig };
}

/** Permanently removes the planned targets. */
export function executeReset(repoDir: string, targets: string[]): void {
  for (const rel of targets) {
    rmSync(join(repoDir, rel), { recursive: true, force: true });
  }
}

/** Human-readable one-line description of a target, annotating directories. */
export function describeTarget(repoDir: string, rel: string): string {
  const abs = join(repoDir, rel);
  if (existsSync(abs) && statSync(abs).isDirectory()) {
    const count = readdirSync(abs).length;
    return `${rel}/  (${count} item${count === 1 ? '' : 's'})`;
  }
  return rel;
}
