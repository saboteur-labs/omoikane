import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';
import type { Adapter } from './adapters/interface.ts';
import { AdapterParseError } from './adapters/interface.ts';
import { loadConfig, type OmoikaneConfig } from './config.ts';
import { StateManager } from './state/state_manager.ts';
import {
  outlinePath,
  learningBriefPath,
  promptsDir,
  documentDir,
  documentPath,
  gapsDir,
  toDateStamp,
} from './state/paths.ts';
import { assembleConstitution } from './constitution.ts';
import { validate } from './validation/validator.ts';
import { createCheckpoint, hasBlockingCheckpoints } from './checkpoints/registry.ts';
import { readTrustStatus } from './smoke/runner.ts';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class GatherOutlineNotReadyError extends Error {
  constructor(status: string) {
    super(
      `Outline is not approved or amended (current status: '${status}'). ` +
        'Run "omoikane outline approve" first.',
    );
    this.name = 'GatherOutlineNotReadyError';
  }
}

export class GatherNodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node '${nodeId}' not found in the current outline.`);
    this.name = 'GatherNodeNotFoundError';
  }
}

export class GatherNodeNotGatherableError extends Error {
  constructor(nodeId: string, status: string) {
    super(
      `Node '${nodeId}' cannot be gathered (current status: '${status}'). ` +
        `Only 'ungathered' or 'stale' nodes can be gathered.`,
    );
    this.name = 'GatherNodeNotGatherableError';
  }
}

export class GatherNodeBlockedError extends Error {
  constructor(nodeId: string) {
    super(
      `Node '${nodeId}' has an open block checkpoint. ` +
        'Resolve it first with "omoikane resolve".',
    );
    this.name = 'GatherNodeBlockedError';
  }
}

export class GatherNothingTodoError extends Error {
  constructor() {
    super(
      'No ungathered or stale nodes without open block checkpoints. ' +
        'All nodes have been gathered.',
    );
    this.name = 'GatherNothingTodoError';
  }
}

export class GatherPromptNotFoundError extends Error {
  constructor(ref: string) {
    super(
      `No active gather prompt found (ref: '${ref}'). Ensure the prompt library is initialised.`,
    );
    this.name = 'GatherPromptNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OutlineNode {
  id: string;
  type: string;
  title: string;
  description: string;
  parent_id: string | null;
  status: string;
}

interface OutlineFile {
  nodes: OutlineNode[];
}

interface PromptEntry {
  id: string;
  prompt_type: string;
  generation: number;
  status: string;
  question: string;
  rationale: string;
  performance?: Record<string, unknown>;
}

interface ScribeClaim {
  id: string;
  type: string;
  content: string;
  source: { tier: string; fidelity: string; citation?: string };
  confidence: { level: string; basis: string };
  status: string;
}

interface ScribeGap {
  id: string;
  nature: 'knowledge_ceiling' | 'source_absence' | 'contested_foundation';
  description: string;
  status: string;
  partial_knowledge?: string[];
  prompt_attempts?: string[];
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GatherOptions {
  adapterFactory: (role: string, config: OmoikaneConfig) => Adapter;
  date?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadActiveGatherPrompt(repoDir: string, promptId?: string): PromptEntry {
  const dir = promptsDir(repoDir);

  if (promptId) {
    const p = join(dir, `${promptId}.yaml`);
    if (!existsSync(p)) throw new GatherPromptNotFoundError(promptId);
    return yaml.load(readFileSync(p, 'utf8')) as PromptEntry;
  }

  if (!existsSync(dir)) throw new GatherPromptNotFoundError('active gather prompt');

  const files = readdirSync(dir).filter(
    (f) => f.startsWith('p-gather-') && f.endsWith('.yaml'),
  );
  if (files.length === 0) throw new GatherPromptNotFoundError('active gather prompt');

  const prompts: PromptEntry[] = files.map(
    (f) => yaml.load(readFileSync(join(dir, f), 'utf8')) as PromptEntry,
  );
  const active = prompts.filter((p) => p.status === 'active');
  if (active.length === 0) throw new GatherPromptNotFoundError('active gather prompt');

  // Prefer highest generation, then lexicographically latest id
  active.sort((a, b) => b.generation - a.generation || b.id.localeCompare(a.id));
  return active[0];
}

function computeSourceTierMix(
  claims: ScribeClaim[],
): { tier_1: number; tier_2: number; tier_3: number } {
  let tier_1 = 0;
  let tier_2 = 0;
  let tier_3 = 0;
  for (const c of claims) {
    if (c.source.tier === 'tier_1') tier_1++;
    else if (c.source.tier === 'tier_2') tier_2++;
    else if (c.source.tier === 'tier_3') tier_3++;
  }
  return { tier_1, tier_2, tier_3 };
}

// Computes the next seq for documents or gaps without writing, mirroring state_manager logic.
// Safe for a single-user CLI where no concurrent writes occur.
function nextSeq(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 1;
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.yaml'));
  if (files.length === 0) return 1;
  const seqs = files
    .map((f) => {
      const parts = f.slice(0, -5).split('-');
      return parseInt(parts[parts.length - 1], 10);
    })
    .filter((n) => !isNaN(n));
  return seqs.length === 0 ? 1 : Math.max(...seqs) + 1;
}

// ---------------------------------------------------------------------------
// runGather
// ---------------------------------------------------------------------------

export async function runGather(
  repoDir: string,
  nodeId: string,
  promptId: string | undefined,
  options: GatherOptions,
): Promise<void> {
  const sm = new StateManager(repoDir);
  const manifest = sm.readManifest(); // throws RepoNotInitialisedError if missing

  // Precondition: outline must be approved or amended
  if (manifest.outline.status !== 'approved' && manifest.outline.status !== 'amended') {
    throw new GatherOutlineNotReadyError(manifest.outline.status);
  }

  // Precondition: node must exist
  const nodeIdx = manifest.outline.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIdx === -1) throw new GatherNodeNotFoundError(nodeId);

  const manifestNode = manifest.outline.nodes[nodeIdx];

  // Precondition: node must be gatherable
  if (manifestNode.status !== 'ungathered' && manifestNode.status !== 'stale') {
    throw new GatherNodeNotGatherableError(nodeId, manifestNode.status);
  }

  // Precondition: no open block checkpoint for this node
  if (hasBlockingCheckpoints(manifest, nodeId)) {
    throw new GatherNodeBlockedError(nodeId);
  }

  // Load full node from outline.yaml
  const oPath = outlinePath(repoDir);
  const outlineFile = yaml.load(readFileSync(oPath, 'utf8')) as OutlineFile;
  const fullNode = outlineFile.nodes.find((n) => n.id === nodeId)!;

  // Load learning brief
  const briefPath = learningBriefPath(repoDir);
  const learningBrief = yaml.load(readFileSync(briefPath, 'utf8')) as Record<string, unknown>;

  // Load active gather prompt
  const prompt = loadActiveGatherPrompt(repoDir, promptId);

  // Determine trust status before invoking
  const trustStatus = readTrustStatus(repoDir, 'scribe');
  const isLowTrust = trustStatus === 'low-trust';

  // Build adapter and invoke Scribe
  const config = loadConfig(repoDir);
  const adapter = options.adapterFactory('scribe', config);
  const constitution = assembleConstitution();

  process.stdout.write(`Invoking Scribe for node '${nodeId}'...\n`);
  const response = await adapter.invoke(
    'scribe',
    {
      command: 'gather',
      outline_node: fullNode,
      learning_brief: learningBrief,
      assigned_prompt: prompt,
    },
    constitution,
  );

  // Validate — throws AdapterParseError on failure (exit 3)
  const valResult = validate('scribe', 'gather', response.parsed);
  if (!valResult.valid) {
    const msgs = valResult.violations.map((v) => `  - [${v.ruleId}] ${v.message}`).join('\n');
    throw new AdapterParseError(`Scribe gather output failed validation:\n${msgs}`);
  }

  // Extract Scribe output
  const scribeOutput = response.parsed as Record<string, unknown>;
  const claims = (scribeOutput.claims as ScribeClaim[]) ?? [];
  const selfCritique = scribeOutput.self_critique as Record<string, unknown>;
  const gapDocuments = (scribeOutput.gap_documents as ScribeGap[] | undefined) ?? [];
  const followUpPrompts = (scribeOutput.follow_up_prompts as string[] | undefined) ?? [];

  const now = new Date().toISOString();
  const dateStamp = options.date ?? toDateStamp();

  // ── Pre-compute doc ID (safe: single-user CLI, no concurrent writes) ──────
  const docDir = documentDir(repoDir, nodeId);
  const docSeq = nextSeq(docDir, `doc-${nodeId}-`);
  const docSeqStr = String(docSeq).padStart(3, '0');
  const docId = `doc-${nodeId}-${dateStamp}-${docSeqStr}`;
  const resolvedDocPath = documentPath(repoDir, nodeId, dateStamp, docSeq);

  // ── Pre-compute gap IDs (safe: single-user CLI, no concurrent writes) ──────
  const gapDirPath = gapsDir(repoDir);
  const writtenGaps: Array<{ gapId: string; nature: string }> = [];
  let gapSeq = nextSeq(gapDirPath, 'gap-');
  for (const gap of gapDocuments) {
    const gapId = `gap-${dateStamp}-${String(gapSeq).padStart(3, '0')}`;
    writtenGaps.push({ gapId, nature: gap.nature });
    gapSeq++;
  }

  // ── Find existing active doc (for supersede) ──────────────────────────────
  const existingActiveIdx = manifest.documents.findIndex(
    (d) => d.outline_node_id === nodeId && d.status === 'active',
  );
  const supersededDocId =
    existingActiveIdx !== -1 ? manifest.documents[existingActiveIdx].document_id : undefined;

  // ── Write gap YAML files (sm.writeGap computes same seq as above) ─────────
  for (let i = 0; i < gapDocuments.length; i++) {
    const gap = gapDocuments[i];
    const { gapId } = writtenGaps[i];
    sm.writeGap(
      {
        schema_version: '1.0',
        type: 'gap',
        id: gapId,
        nature: gap.nature,
        description: gap.description,
        outline_node_id: nodeId,
        status: gap.status ?? 'open',
        created_at: now,
        produced_by: 'scribe',
        ...(gap.partial_knowledge ? { partial_knowledge: gap.partial_knowledge } : {}),
        ...(gap.prompt_attempts ? { prompt_attempts: gap.prompt_attempts } : {}),
      },
      dateStamp,
    );
  }

  // ── Build document ────────────────────────────────────────────────────────
  const sourceTierMix = computeSourceTierMix(claims);
  const docStatus = isLowTrust ? 'low-trust' : 'active';

  const documentData: Record<string, unknown> = {
    schema_version: '1.0',
    type: 'document',
    id: docId,
    outline_node_id: nodeId,
    ...(supersededDocId ? { supersedes: supersededDocId } : {}),
    provenance: {
      prompt_id: prompt.id,
      prompt_generation: prompt.generation,
      adapter: adapter.get_adapter_id(),
      model: adapter.get_model_id(),
      source_tier_mix: sourceTierMix,
      date: now,
    },
    status: docStatus,
    staleness_flag: false,
    re_gather_candidate: false,
    claims,
    self_critique: selfCritique,
    ...(writtenGaps.length > 0
      ? { gap_documents: writtenGaps.map((g) => ({ gap_id: g.gapId, nature: g.nature })) }
      : {}),
    ...(followUpPrompts.length > 0 ? { follow_up_prompts: followUpPrompts } : {}),
    signal_history: [],
  };

  // ── Write document YAML ───────────────────────────────────────────────────
  const writtenDocPath = sm.writeDocument(nodeId, documentData, dateStamp);
  // Verify the pre-computed path matches what writeDocument produced
  if (writtenDocPath !== resolvedDocPath) {
    // Sequence number race — shouldn't happen in single-user CLI, but log for diagnostics
    process.stderr.write(
      `Warning: document path mismatch — expected '${resolvedDocPath}', got '${writtenDocPath}'\n`,
    );
  }

  // ── Update manifest ───────────────────────────────────────────────────────
  if (existingActiveIdx !== -1) {
    manifest.documents[existingActiveIdx].status = 'superseded';
    manifest.documents[existingActiveIdx].superseded_by = docId;
  }

  manifest.documents.push({
    document_id: docId,
    outline_node_id: nodeId,
    status: docStatus,
    prompt_id: prompt.id,
    prompt_generation: prompt.generation,
    adapter: adapter.get_adapter_id(),
    model: adapter.get_model_id(),
    date: now,
  });

  manifest.outline.nodes[nodeIdx].status = 'gathered';

  for (const { gapId, nature } of writtenGaps) {
    manifest.known_gaps.push({
      gap_id: gapId,
      nature: nature as 'knowledge_ceiling' | 'source_absence' | 'contested_foundation',
      outline_node_id: nodeId,
      status: 'open',
    });
  }

  sm.writeManifest(manifest);

  // ── Create checkpoints (after manifest write so createCheckpoint sees fresh state) ──
  for (const { gapId, nature } of writtenGaps) {
    createCheckpoint(repoDir, sm, {
      prefix: 'SCR',
      type: 'review',
      produced_by: 'runner',
      affected_object_id: gapId,
      description:
        `Gap document '${gapId}' (${nature}) found during gather for node '${nodeId}'. ` +
        'Review the gap findings — gaps are first-class findings, not failures.',
      principle_ref: 'P1',
    });
  }

  if (isLowTrust) {
    createCheckpoint(repoDir, sm, {
      prefix: 'SCR',
      type: 'review',
      produced_by: 'runner',
      affected_object_id: docId,
      description:
        `Document '${docId}' was gathered by a low-trust Scribe adapter. ` +
        "Status is 'low-trust' — additional scrutiny is recommended before relying on these claims. " +
        'Re-establish trust by re-running smoke tests (omoikane agent test scribe) ' +
        'and then re-gather this node.',
      principle_ref: 'P2',
    });
  }

  const trustNote = isLowTrust ? ' [low-trust]' : '';
  process.stdout.write(
    `Document '${docId}' written (${claims.length} claim${claims.length !== 1 ? 's' : ''}, ` +
      `${writtenGaps.length} gap${writtenGaps.length !== 1 ? 's' : ''})${trustNote}.\n`,
  );
}

// ---------------------------------------------------------------------------
// runGatherNext
// ---------------------------------------------------------------------------

export async function runGatherNext(repoDir: string, options: GatherOptions): Promise<void> {
  const sm = new StateManager(repoDir);
  const manifest = sm.readManifest(); // throws RepoNotInitialisedError if missing

  // Precondition: outline must be approved or amended
  if (manifest.outline.status !== 'approved' && manifest.outline.status !== 'amended') {
    throw new GatherOutlineNotReadyError(manifest.outline.status);
  }

  // Find first ungathered/stale node with no block checkpoint, in outline order
  const nextNode = manifest.outline.nodes.find(
    (n) =>
      (n.status === 'ungathered' || n.status === 'stale') &&
      !hasBlockingCheckpoints(manifest, n.id),
  );

  if (!nextNode) throw new GatherNothingTodoError();

  return runGather(repoDir, nextNode.id, undefined, options);
}
