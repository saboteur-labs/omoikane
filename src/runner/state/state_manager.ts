import {
  readFileSync,
  writeFileSync,
  renameSync,
  mkdirSync,
  existsSync,
  readdirSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import type { Manifest } from './manifest.ts';
import { createInitialManifest, validateManifest } from './manifest.ts';
import {
  manifestPath,
  documentDir,
  documentPath,
  gapsDir,
  gapPath,
  promptsDir,
  omoikaneDir,
  toDateStamp,
} from './paths.ts';

export class ManifestValidationError extends Error {
  constructor(public readonly violations: string[]) {
    super(`Manifest validation failed:\n${violations.join('\n')}`);
    this.name = 'ManifestValidationError';
  }
}

export class RepoAlreadyInitialisedError extends Error {
  constructor(repoDir: string) {
    super(`Repository already initialised at '${repoDir}'`);
    this.name = 'RepoAlreadyInitialisedError';
  }
}

export class RepoNotInitialisedError extends Error {
  constructor(repoDir: string) {
    super(`No manifest found at '${repoDir}'. Run omoikane repo init first.`);
    this.name = 'RepoNotInitialisedError';
  }
}

export class StateManager {
  constructor(private readonly repoDir: string) {}

  /**
   * Initialises a new repo: creates directory structure and writes manifest.yaml.
   * Throws RepoAlreadyInitialisedError if a manifest already exists.
   */
  initRepo(subject: string, learningBriefRelPath: string): void {
    const mPath = manifestPath(this.repoDir);
    if (existsSync(mPath)) throw new RepoAlreadyInitialisedError(this.repoDir);

    mkdirSync(this.repoDir, { recursive: true });
    mkdirSync(join(this.repoDir, 'documents'), { recursive: true });
    mkdirSync(join(this.repoDir, 'gaps'), { recursive: true });
    mkdirSync(join(this.repoDir, 'prompts'), { recursive: true });
    mkdirSync(omoikaneDir(this.repoDir), { recursive: true });

    const manifest = createInitialManifest(subject, learningBriefRelPath);
    this.writeManifest(manifest);
  }

  /** Reads and parses manifest.yaml. Throws RepoNotInitialisedError if missing. */
  readManifest(): Manifest {
    const mPath = manifestPath(this.repoDir);
    if (!existsSync(mPath)) throw new RepoNotInitialisedError(this.repoDir);
    const raw = readFileSync(mPath, 'utf8');
    return yaml.load(raw) as Manifest;
  }

  /**
   * Validates and atomically writes manifest.yaml via temp-then-rename.
   * Throws ManifestValidationError if MAN-VR1 or other rules are violated.
   * Note: SQLite transaction step is wired in Task 7 — for now, writes YAML only.
   */
  writeManifest(manifest: Manifest): void {
    manifest.last_modified = new Date().toISOString();

    const violations = validateManifest(manifest);
    if (violations.length > 0) throw new ManifestValidationError(violations);

    atomicWrite(manifestPath(this.repoDir), yaml.dump(manifest, { lineWidth: 120 }));
  }

  /**
   * Atomically writes a document YAML file to documents/<nodeId>/ using
   * the doc-<nodeId>-<YYYYMMDD>-<seq>.yaml naming convention.
   * Returns the final file path.
   */
  writeDocument(nodeId: string, document: Record<string, unknown>, date?: string): string {
    const dateStamp = date ?? toDateStamp();
    const dir = documentDir(this.repoDir, nodeId);
    mkdirSync(dir, { recursive: true });

    const seq = nextSeq(dir, `doc-${nodeId}-`);
    const finalPath = documentPath(this.repoDir, nodeId, dateStamp, seq);
    atomicWrite(finalPath, yaml.dump(document, { lineWidth: 120 }));
    return finalPath;
  }

  /**
   * Atomically writes a gap YAML file to gaps/ using
   * the gap-<YYYYMMDD>-<seq>.yaml naming convention.
   * Returns the final file path.
   */
  writeGap(gap: Record<string, unknown>, date?: string): string {
    const dateStamp = date ?? toDateStamp();
    const dir = gapsDir(this.repoDir);
    mkdirSync(dir, { recursive: true });

    const seq = nextSeq(dir, 'gap-');
    const finalPath = gapPath(this.repoDir, dateStamp, seq);
    atomicWrite(finalPath, yaml.dump(gap, { lineWidth: 120 }));
    return finalPath;
  }

  /** Exposes manifest validation for callers that need to pre-check before writing. */
  validateManifest(manifest: Manifest): string[] {
    return validateManifest(manifest);
  }
}

/**
 * Writes content to a temporary path then renames to the final path.
 * The rename is atomic on POSIX — the final path is never in a partial state.
 */
function atomicWrite(finalPath: string, content: string): void {
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
    throw err;
  }
}

/**
 * Returns the next sequence number for files in a directory whose names
 * start with a given prefix. Scans all .yaml files, extracts the numeric
 * suffix before .yaml, and returns max+1 (or 1 if the directory is empty).
 */
function nextSeq(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 1;

  const files = readdirSync(dir).filter(
    (f) => f.startsWith(prefix) && f.endsWith('.yaml'),
  );
  if (files.length === 0) return 1;

  const seqs = files
    .map((f) => {
      const withoutExt = f.slice(0, -5); // remove .yaml
      const parts = withoutExt.split('-');
      const last = parts[parts.length - 1];
      return parseInt(last, 10);
    })
    .filter((n) => !isNaN(n));

  return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
}
