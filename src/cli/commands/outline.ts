import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'node:fs';
import { createInterface } from 'node:readline';
import yaml from 'js-yaml';
import type { ParsedCommand } from '../types.ts';
import type { Adapter } from '../../runner/adapters/interface.ts';
import { AdapterParseError } from '../../runner/adapters/interface.ts';
import { loadConfig, type OmoikaneConfig } from '../../runner/config.ts';
import { StateManager } from '../../runner/state/state_manager.ts';
import type { ManifestOutlineNode } from '../../runner/state/manifest.ts';
import { outlinePath, learningBriefPath } from '../../runner/state/paths.ts';
import { assembleConstitution } from '../../runner/constitution.ts';
import { validate } from '../../runner/validation/validator.ts';
import { createCheckpoint } from '../../runner/checkpoints/registry.ts';
import { buildAdapter } from './agent.ts';

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

export class OutlineNotInDraftError extends Error {
  constructor(status: string) {
    super(`Outline is not in draft status (current status: ${status}). Run "omoikane outline" to produce a draft.`);
    this.name = 'OutlineNotInDraftError';
  }
}

export class OutlineNotApprovedError extends Error {
  constructor() {
    super('Outline has not been approved. Run "omoikane outline approve" before amending nodes.');
    this.name = 'OutlineNotApprovedError';
  }
}

export class OutlineNodeNotFoundError extends Error {
  constructor(nodeId: string) {
    super(`Node '${nodeId}' not found in the current outline.`);
    this.name = 'OutlineNodeNotFoundError';
  }
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface OutlineNode {
  id: string;
  type: ManifestOutlineNode['type'];
  title: string;
  description: string;
  parent_id: string | null;
  status: string;
}

interface OutlineFile {
  schema_version: string;
  created_at: string;
  last_modified: string;
  type: string;
  version: number;
  nodes: OutlineNode[];
  contested_or_edge_case_node_count: number;
  justification_if_no_contested_nodes?: string;
}

// ---------------------------------------------------------------------------
// Public option types
// ---------------------------------------------------------------------------

export interface OutlineOptions {
  adapterFactory?: (role: string, config: OmoikaneConfig) => Adapter;
}

export interface OutlineAmendOptions {
  promptFn?: (question: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// runOutline
// ---------------------------------------------------------------------------

export async function runOutline(repoDir: string, options: OutlineOptions = {}): Promise<void> {
  const sm = new StateManager(repoDir);
  const manifest = sm.readManifest(); // throws RepoNotInitialisedError if missing

  const briefPath = learningBriefPath(repoDir);
  if (!existsSync(briefPath)) {
    throw new Error(
      'learning_brief.yaml not found. Ensure "omoikane repo init" completed successfully.',
    );
  }
  const learningBrief = yaml.load(readFileSync(briefPath, 'utf8')) as Record<string, unknown>;

  const oPath = outlinePath(repoDir);
  let existingOutline: OutlineFile | undefined;
  if (existsSync(oPath)) {
    existingOutline = yaml.load(readFileSync(oPath, 'utf8')) as OutlineFile;
  }

  const context: Record<string, unknown> = {
    command: 'outline',
    learning_brief: learningBrief,
    repo_manifest: {
      subject: manifest.subject,
      outline_version: manifest.outline.version,
      outline_status: manifest.outline.status,
      node_count: manifest.outline.nodes.length,
    },
  };
  if (existingOutline) {
    context.existing_outline = existingOutline;
  }

  const config = loadConfig(repoDir);
  const makeAdapter = options.adapterFactory ?? buildAdapter;
  const adapter = makeAdapter('architect', config);
  const constitution = assembleConstitution();

  process.stdout.write('Invoking Architect for outline...\n');
  const response = await adapter.invoke('architect', context, constitution);

  // Validate raw output — ARC-OV3 fires as checkpoint_review if the declared
  // count doesn't match actual nodes. Other rules fire as hard violations.
  const parsedOutline = response.parsed as Record<string, unknown>;
  const valResult = validate('architect', 'outline', parsedOutline);
  if (!valResult.valid) {
    const msgs = valResult.violations.map((v) => `  - [${v.ruleId}] ${v.message}`).join('\n');
    throw new AdapterParseError(`Architect outline output failed validation:\n${msgs}`);
  }

  // Compute the correct count from actual node types — always use this when
  // writing. ARC-OV3 checkpoint (if fired above) signals any mismatch.
  const nodes = (parsedOutline.nodes as OutlineNode[]) ?? [];
  const actualContestedCount = nodes.filter(
    (n) => n.type === 'contested' || n.type === 'edge_case',
  ).length;
  const now = new Date().toISOString();
  const newVersion = manifest.outline.version + 1;

  const outlineData: OutlineFile = {
    schema_version: '1.0',
    created_at: existingOutline?.created_at ?? now,
    last_modified: now,
    type: parsedOutline.type as string,
    version: newVersion,
    nodes,
    contested_or_edge_case_node_count: actualContestedCount,
    ...(parsedOutline.justification_if_no_contested_nodes != null
      ? { justification_if_no_contested_nodes: parsedOutline.justification_if_no_contested_nodes as string }
      : {}),
  };

  atomicYamlWrite(oPath, yaml.dump(outlineData, { lineWidth: 120 }));

  manifest.outline.version = newVersion;
  manifest.outline.status = 'draft';
  manifest.outline.nodes = nodes.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    status: 'ungathered' as const,
  }));
  sm.writeManifest(manifest);

  // ARC-OV5 and ARC-OV3 fire as review checkpoints (on_failure: checkpoint_review)
  for (const cp of valResult.checkpoints) {
    if (cp.ruleId === 'ARC-OV5') {
      createCheckpoint(repoDir, sm, {
        prefix: 'ARC',
        type: 'review',
        produced_by: 'runner',
        affected_object_id: 'outline',
        description:
          'No gap_placeholder nodes found in outline. The outline may be presenting the ' +
          'subject as fully mappable. Verify this is intentional.',
        principle_ref: 'P1',
      });
    }
    if (cp.ruleId === 'ARC-OV3') {
      createCheckpoint(repoDir, sm, {
        prefix: 'ARC',
        type: 'review',
        produced_by: 'runner',
        affected_object_id: 'outline',
        description:
          'Architect contested_or_edge_case_node_count was auto-corrected by the runner. ' +
          `Corrected count: ${actualContestedCount}. Review the outline node types.`,
        principle_ref: 'P1',
      });
    }
  }

  process.stdout.write(`Outline v${newVersion} written to outline.yaml (${nodes.length} nodes, status: draft).\n`);
}

// ---------------------------------------------------------------------------
// runOutlineApprove
// ---------------------------------------------------------------------------

export async function runOutlineApprove(repoDir: string): Promise<void> {
  const sm = new StateManager(repoDir);
  const manifest = sm.readManifest();

  if (manifest.outline.status !== 'draft') {
    throw new OutlineNotInDraftError(manifest.outline.status);
  }

  manifest.outline.status = 'approved';
  manifest.outline.approved_at = new Date().toISOString();
  sm.writeManifest(manifest);

  createCheckpoint(repoDir, sm, {
    prefix: 'OUT',
    type: 'inform',
    produced_by: 'runner',
    affected_object_id: 'outline',
    description: 'Outline approved. Gather is now unlocked.',
  });

  process.stdout.write('Outline approved. Gather is now unlocked.\n');
}

// ---------------------------------------------------------------------------
// runOutlineAmend
// ---------------------------------------------------------------------------

export async function runOutlineAmend(
  repoDir: string,
  nodeId: string,
  options: OutlineAmendOptions = {},
): Promise<void> {
  const prompt = options.promptFn ?? defaultPromptFn;
  const sm = new StateManager(repoDir);
  const manifest = sm.readManifest();

  // Must have been approved at least once
  if (!manifest.outline.approved_at) {
    throw new OutlineNotApprovedError();
  }

  // Node must exist in the manifest summary
  const nodeIdx = manifest.outline.nodes.findIndex((n) => n.id === nodeId);
  if (nodeIdx === -1) {
    throw new OutlineNodeNotFoundError(nodeId);
  }

  // Load full node details from outline.yaml
  const oPath = outlinePath(repoDir);
  const outlineFile = yaml.load(readFileSync(oPath, 'utf8')) as OutlineFile;
  const fullNodeIdx = outlineFile.nodes.findIndex((n) => n.id === nodeId);
  const currentNode = outlineFile.nodes[fullNodeIdx];

  // Collect new values; pressing enter keeps the current value
  const newTitle =
    (await prompt(`Node title [${currentNode.title}]: `)).trim() || currentNode.title;
  const newDescription =
    (await prompt(`Node description [${currentNode.description}]: `)).trim() ||
    currentNode.description;

  // Write updated outline.yaml
  outlineFile.nodes[fullNodeIdx] = { ...currentNode, title: newTitle, description: newDescription };
  outlineFile.last_modified = new Date().toISOString();
  atomicYamlWrite(oPath, yaml.dump(outlineFile, { lineWidth: 120 }));

  // Update manifest: status → amended, sync node title, mark active docs stale
  manifest.outline.status = 'amended';
  manifest.outline.nodes[nodeIdx].title = newTitle;
  for (const doc of manifest.documents) {
    if (doc.outline_node_id === nodeId && doc.status === 'active') {
      doc.status = 'stale';
    }
  }
  sm.writeManifest(manifest);

  // CP-OUT review checkpoint for the affected node
  createCheckpoint(repoDir, sm, {
    prefix: 'OUT',
    type: 'review',
    produced_by: 'runner',
    affected_object_id: nodeId,
    description:
      `Outline node '${nodeId}' amended after approval. ` +
      'Any existing gathered document for this node may be stale.',
  });

  process.stdout.write(`Node '${nodeId}' amended. Outline status: amended.\n`);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function handleOutline(command: ParsedCommand): Promise<void> {
  const repoDir = process.cwd();
  switch (command.id) {
    case 'outline':
      return runOutline(repoDir);
    case 'outline_approve':
      return runOutlineApprove(repoDir);
    case 'outline_amend':
      return runOutlineAmend(repoDir, command.nodeId!);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function atomicYamlWrite(filePath: string, content: string): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    writeFileSync(tmpPath, content, 'utf8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* best-effort */
    }
    throw err;
  }
}

function defaultPromptFn(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}
