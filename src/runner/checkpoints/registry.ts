import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import yaml from 'js-yaml';
import type { Manifest, ManifestCheckpoint } from '../state/manifest.ts';
import type { StateManager } from '../state/state_manager.ts';
import { checkpointHistoryPath, toDateStamp } from '../state/paths.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckpointType = 'inform' | 'review' | 'block';
export type ResolutionAction = 'acknowledge' | 'note' | 'dismiss' | 'accept' | 'override';

export interface CheckpointParams {
  prefix: string;
  type: CheckpointType;
  produced_by: string;
  affected_object_id: string;
  description: string;
  principle_ref?: string;
}

export interface CheckpointHistoryEntry {
  checkpoint_id: string;
  type: CheckpointType;
  produced_by: string;
  affected_object_id: string;
  description: string;
  created_at: string;
  principle_ref?: string;
  resolved_at: string;
  resolution_action: ResolutionAction;
  resolution_note?: string;
}

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class InvalidCheckpointActionError extends Error {
  constructor(action: string, checkpointType: CheckpointType) {
    super(`Action '${action}' is not valid for checkpoint type '${checkpointType}'. ` +
      `Valid actions: ${VALID_ACTIONS[checkpointType].join(', ')}`);
    this.name = 'InvalidCheckpointActionError';
  }
}

export class CheckpointNotFoundError extends Error {
  constructor(checkpointId: string) {
    super(`Checkpoint '${checkpointId}' not found in open_checkpoints`);
    this.name = 'CheckpointNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Valid action mapping (from spec/machine/cli/checkpoints.yaml)
// ---------------------------------------------------------------------------

const VALID_ACTIONS: Record<CheckpointType, ResolutionAction[]> = {
  inform: ['acknowledge'],
  review: ['acknowledge', 'note', 'dismiss'],
  block: ['accept', 'override'],
};

// ---------------------------------------------------------------------------
// History file helpers
// ---------------------------------------------------------------------------

function readHistory(repoDir: string): CheckpointHistoryEntry[] {
  const p = checkpointHistoryPath(repoDir);
  if (!existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8');
  return (yaml.load(raw) as CheckpointHistoryEntry[]) ?? [];
}

function writeHistory(repoDir: string, entries: CheckpointHistoryEntry[]): void {
  const finalPath = checkpointHistoryPath(repoDir);
  const tmpPath = `${finalPath}.tmp`;
  try {
    writeFileSync(tmpPath, yaml.dump(entries, { lineWidth: 120 }), 'utf8');
    renameSync(tmpPath, finalPath);
  } catch (err) {
    try { unlinkSync(tmpPath); } catch { /* best-effort */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Seq generation — unique across open + history
// ---------------------------------------------------------------------------

function nextCheckpointSeq(
  repoDir: string,
  prefix: string,
  dateStamp: string,
  manifest: Manifest,
): number {
  const pattern = `CP-${prefix}-${dateStamp}-`;

  const allIds: string[] = [
    ...manifest.open_checkpoints.map((c) => c.checkpoint_id),
    ...readHistory(repoDir).map((e) => e.checkpoint_id),
  ];

  const seqs = allIds
    .filter((id) => id.startsWith(pattern))
    .map((id) => {
      const parts = id.split('-');
      return parseInt(parts[parts.length - 1], 10);
    })
    .filter((n) => !isNaN(n));

  return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a checkpoint, stores it in manifest.open_checkpoints, and returns
 * the generated checkpoint ID (format: CP-<prefix>-<YYYYMMDD>-<seq>).
 */
export function createCheckpoint(
  repoDir: string,
  sm: StateManager,
  params: CheckpointParams,
  date?: string,
): string {
  const manifest = sm.readManifest();
  const dateStamp = date ?? toDateStamp();
  const seq = nextCheckpointSeq(repoDir, params.prefix, dateStamp, manifest);
  const seqStr = String(seq).padStart(3, '0');
  const checkpointId = `CP-${params.prefix}-${dateStamp}-${seqStr}`;

  const checkpoint: ManifestCheckpoint = {
    checkpoint_id: checkpointId,
    type: params.type,
    produced_by: params.produced_by,
    affected_object_id: params.affected_object_id,
    description: params.description,
    created_at: new Date().toISOString(),
    ...(params.principle_ref ? { principle_ref: params.principle_ref } : {}),
  };

  manifest.open_checkpoints.push(checkpoint);
  sm.writeManifest(manifest);
  return checkpointId;
}

/**
 * Resolves an open checkpoint: validates action against type, removes from
 * open_checkpoints, appends to checkpoint_history.yaml.
 *
 * If action is 'override' on a 'block' checkpoint, an inform checkpoint is
 * also created to record that the override occurred (spec: produces_inform_entry).
 *
 * Throws InvalidCheckpointActionError if action is not valid for the type.
 * Throws CheckpointNotFoundError if checkpointId is not in open_checkpoints.
 */
export function resolveCheckpoint(
  repoDir: string,
  sm: StateManager,
  checkpointId: string,
  action: string,
  note?: string,
): void {
  const manifest = sm.readManifest();
  const idx = manifest.open_checkpoints.findIndex((c) => c.checkpoint_id === checkpointId);

  if (idx === -1) throw new CheckpointNotFoundError(checkpointId);

  const checkpoint = manifest.open_checkpoints[idx];
  const validActions = VALID_ACTIONS[checkpoint.type];
  if (!validActions.includes(action as ResolutionAction)) {
    throw new InvalidCheckpointActionError(action, checkpoint.type);
  }

  const historyEntry: CheckpointHistoryEntry = {
    checkpoint_id: checkpoint.checkpoint_id,
    type: checkpoint.type,
    produced_by: checkpoint.produced_by,
    affected_object_id: checkpoint.affected_object_id,
    description: checkpoint.description,
    created_at: checkpoint.created_at,
    ...(checkpoint.principle_ref ? { principle_ref: checkpoint.principle_ref } : {}),
    resolved_at: new Date().toISOString(),
    resolution_action: action as ResolutionAction,
    ...(note ? { resolution_note: note } : {}),
  };

  // override on block: compute the inform ID while the block is still in the open list,
  // so nextCheckpointSeq sees it and won't reuse its seq number.
  let overrideInform: ManifestCheckpoint | undefined;
  if (action === 'override' && checkpoint.type === 'block') {
    const prefix = extractPrefix(checkpoint.checkpoint_id);
    const dateStamp = toDateStamp();
    const seq = nextCheckpointSeq(repoDir, prefix, dateStamp, manifest);
    const seqStr = String(seq).padStart(3, '0');
    const overrideInformId = `CP-${prefix}-${dateStamp}-${seqStr}`;

    overrideInform = {
      checkpoint_id: overrideInformId,
      type: 'inform',
      produced_by: 'runner',
      affected_object_id: checkpoint.affected_object_id,
      description: `Block checkpoint ${checkpointId} was overridden. The underlying issue remains unresolved.`,
      created_at: new Date().toISOString(),
    };
  }

  // Remove the resolved checkpoint from open list
  manifest.open_checkpoints.splice(idx, 1);

  if (overrideInform) {
    manifest.open_checkpoints.push(overrideInform);
  }

  sm.writeManifest(manifest);

  // Append to history after manifest write succeeds
  const history = readHistory(repoDir);
  history.push(historyEntry);
  writeHistory(repoDir, history);
}

/**
 * Auto-resolves all open 'inform' checkpoints (spec: auto_resolve_on_review).
 * Called when the researcher runs omoikane review. Returns the count resolved.
 */
export function autoResolveInformCheckpoints(repoDir: string, sm: StateManager): number {
  const manifest = sm.readManifest();
  const toResolve = manifest.open_checkpoints.filter((c) => c.type === 'inform');

  if (toResolve.length === 0) return 0;

  const now = new Date().toISOString();
  const newEntries: CheckpointHistoryEntry[] = toResolve.map((cp) => ({
    checkpoint_id: cp.checkpoint_id,
    type: cp.type as CheckpointType,
    produced_by: cp.produced_by,
    affected_object_id: cp.affected_object_id,
    description: cp.description,
    created_at: cp.created_at,
    ...(cp.principle_ref ? { principle_ref: cp.principle_ref } : {}),
    resolved_at: now,
    resolution_action: 'acknowledge' as ResolutionAction,
  }));

  manifest.open_checkpoints = manifest.open_checkpoints.filter((c) => c.type !== 'inform');
  sm.writeManifest(manifest);

  const history = readHistory(repoDir);
  writeHistory(repoDir, [...history, ...newEntries]);

  return toResolve.length;
}

/**
 * Returns true if the manifest contains any open 'block' checkpoints for the
 * given affected_object_id. Pure — no IO.
 */
export function hasBlockingCheckpoints(manifest: Manifest, affectedObjectId: string): boolean {
  return manifest.open_checkpoints.some(
    (c) => c.type === 'block' && c.affected_object_id === affectedObjectId,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractPrefix(checkpointId: string): string {
  // Format: CP-<prefix>-<date>-<seq> — prefix is the second segment
  const parts = checkpointId.split('-');
  return parts.length >= 2 ? parts[1] : 'RUN';
}
