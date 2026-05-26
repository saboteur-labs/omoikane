export interface ManifestOutlineNode {
  id: string;
  type: 'factual' | 'contested' | 'definitional' | 'methodological' | 'edge_case' | 'gap_placeholder';
  title: string;
  status: 'ungathered' | 'gathering' | 'gathered' | 'stale' | 'blocked';
  open_checkpoint_ids?: string[];
}

export interface ManifestDocument {
  document_id: string;
  outline_node_id: string;
  status: 'active' | 'superseded' | 'stale' | 'low-trust';
  prompt_id: string;
  prompt_generation: number;
  adapter: string;
  model: string;
  date: string;
  superseded_by?: string;
}

export interface ManifestCheckpoint {
  checkpoint_id: string;
  type: 'inform' | 'review' | 'block';
  produced_by: string;
  affected_object_id: string;
  description: string;
  created_at: string;
  principle_ref?: string;
}

export interface ManifestGap {
  gap_id: string;
  nature: 'knowledge_ceiling' | 'source_absence' | 'contested_foundation';
  outline_node_id?: string;
  status: 'open' | 'externally_resolved' | 'user_closed';
}

export interface ManifestPrediction {
  prediction_id: string;
  prompt_candidate_id: string;
  prediction_text: string;
  status: 'pending' | 'confirmed' | 'refuted';
}

export interface Manifest {
  schema_version: string;
  subject: string;
  created_at: string;
  last_modified: string;
  learning_brief_path: string;
  outline: {
    version: number;
    status: 'none' | 'draft' | 'approved' | 'amended';
    approved_at?: string;
    nodes: ManifestOutlineNode[];
  };
  documents: ManifestDocument[];
  prompt_library_version: number;
  known_gaps: ManifestGap[];
  open_predictions: ManifestPrediction[];
  open_checkpoints: ManifestCheckpoint[];
}

export function createInitialManifest(subject: string, learningBriefPath: string): Manifest {
  const now = new Date().toISOString();
  return {
    schema_version: '1.0',
    subject,
    created_at: now,
    last_modified: now,
    learning_brief_path: learningBriefPath,
    outline: { version: 0, status: 'none', nodes: [] },
    documents: [],
    prompt_library_version: 1,
    known_gaps: [],
    open_predictions: [],
    open_checkpoints: [],
  };
}

/**
 * Validates manifest invariants. Returns human-readable error strings (empty = valid).
 * MAN-VR1: at most one active document per outline node.
 */
export function validateManifest(manifest: Manifest): string[] {
  const errors: string[] = [];

  const activeByNode = new Map<string, number>();
  for (const doc of manifest.documents) {
    if (doc.status === 'active') {
      activeByNode.set(doc.outline_node_id, (activeByNode.get(doc.outline_node_id) ?? 0) + 1);
    }
  }
  for (const [nodeId, count] of activeByNode) {
    if (count > 1) {
      errors.push(
        `MAN-VR1: more than one active document for outline node '${nodeId}' — ` +
          'Manifest integrity error: more than one active document for the same outline node.',
      );
    }
  }

  return errors;
}
