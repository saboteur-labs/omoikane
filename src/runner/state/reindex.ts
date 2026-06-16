import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { openDb, createSchema, dropSchema, syncManifestToDb, insertClaim, insertSignalEvent, insertGapDocument, insertPrompt } from './index_db.ts';
import { manifestPath, documentDir, gapsDir, promptsDir } from './paths.ts';
import type { Manifest } from './manifest.ts';

export interface ReindexSummary {
  files_read: number;
  records_indexed: number;
  warnings_produced: number;
}

/**
 * Drops and rebuilds the SQLite index from YAML. Idempotent and always safe.
 * Never modifies YAML. Treats all reference errors as warnings.
 */
export function reindexRepo(repoDir: string): ReindexSummary {
  const db = openDb(repoDir);
  let files_read = 0;
  let records_indexed = 0;
  const warnings: string[] = [];

  const warn = (msg: string) => warnings.push(msg);

  // Step REINDEX-1: drop and rebuild schema
  dropSchema(db);
  createSchema(db);

  const reindex = db.transaction(() => {
    // Step REINDEX-2: manifest.yaml
    const mPath = manifestPath(repoDir);
    if (!existsSync(mPath)) {
      warn('manifest.yaml not found — skipping');
      return;
    }

    files_read++;
    const manifest = yaml.load(readFileSync(mPath, 'utf8')) as Manifest;

    // Populate documents + checkpoints from manifest
    syncManifestToDb(db, manifest);
    records_indexed += manifest.documents.length + manifest.open_checkpoints.length;

    // Step REINDEX-2 cont: gap_documents from manifest.known_gaps
    for (const gapRef of manifest.known_gaps ?? []) {
      const gapFile = join(gapsDir(repoDir), `${gapRef.gap_id}.yaml`);
      if (!existsSync(gapFile)) {
        warn(`MAN-VR3: gap_id '${gapRef.gap_id}' in manifest has no corresponding file`);
        continue;
      }
      files_read++;
      const gap = yaml.load(readFileSync(gapFile, 'utf8')) as Record<string, unknown>;
      insertGapDocument(db, {
        gap_id: gap['id'] as string,
        nature: gap['nature'] as string,
        status: gap['status'] as string,
        outline_node_id: (gap['outline_node_id'] as string | null) ?? null,
        produced_by: gap['produced_by'] as string,
        created_at: gap['created_at'] as string,
      });
      records_indexed++;
    }

    // Step REINDEX-2 cont: documents/<node-id>/*.yaml — extract claims + signal_events
    const docBaseDir = join(repoDir, 'documents');
    if (existsSync(docBaseDir)) {
      for (const nodeId of readdirSync(docBaseDir)) {
        const nodeDir = join(docBaseDir, nodeId);
        let nodeFiles: string[];
        try {
          nodeFiles = readdirSync(nodeDir).filter((f) => f.endsWith('.yaml'));
        } catch {
          warn(`Could not read directory documents/${nodeId}`);
          continue;
        }
        for (const fileName of nodeFiles) {
          const filePath = join(nodeDir, fileName);
          files_read++;
          let doc: Record<string, unknown>;
          try {
            doc = yaml.load(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
          } catch {
            warn(`Could not parse ${filePath} as YAML`);
            continue;
          }

          const docId = doc['id'] as string | undefined;
          if (!docId) { warn(`Document at ${filePath} has no id field`); continue; }
          const outlineNodeId = doc['outline_node_id'] as string | undefined ?? nodeId;

          // Index claims
          for (const claim of (doc['claims'] as unknown[]) ?? []) {
            const c = claim as Record<string, unknown>;
            const claimId = c['id'] as string | undefined;
            if (!claimId) { warn(`Claim with no id in ${filePath}`); continue; }
            const source = c['source'] as Record<string, unknown> | undefined;
            const confidence = c['confidence'] as Record<string, unknown> | undefined;
            insertClaim(db, {
              claim_id: claimId,
              document_id: docId,
              outline_node_id: outlineNodeId,
              claim_type: (c['type'] as string) ?? 'unknown',
              source_tier: (source?.['tier'] as string) ?? 'unknown',
              confidence_level: (confidence?.['level'] as string) ?? 'unknown',
              status: (c['status'] as string) ?? 'active',
            });
            records_indexed++;
          }

          // Index signal_history entries
          for (const entry of (doc['signal_history'] as unknown[]) ?? []) {
            const e = entry as Record<string, unknown>;
            const entryId = e['entry_id'] as string | undefined;
            if (!entryId) { warn(`Signal entry with no entry_id in ${filePath}`); continue; }
            const promptId = (e['prompt_id'] as string | undefined) ?? (doc['prompt_id'] as string) ?? 'unknown';
            insertSignalEvent(db, {
              entry_id: entryId,
              prompt_id: promptId,
              signal_type: (e['type'] as string) ?? 'unknown',
              signal_category: (e['signal_category'] as string) ?? 'ai_derived',
              document_id: docId,
              event_date: (e['timestamp'] as string) ?? '',
            });
            records_indexed++;
          }
        }
      }
    }

    // Step REINDEX-2 cont: prompts/*.yaml
    const promptDir = promptsDir(repoDir);
    if (existsSync(promptDir)) {
      for (const fileName of readdirSync(promptDir).filter((f) => f.endsWith('.yaml'))) {
        const filePath = join(promptDir, fileName);
        files_read++;
        let prompt: Record<string, unknown>;
        try {
          prompt = yaml.load(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
        } catch {
          warn(`Could not parse ${filePath} as YAML`);
          continue;
        }
        const promptId = prompt['id'] as string | undefined;
        if (!promptId) { warn(`Prompt at ${filePath} has no id field`); continue; }
        insertPrompt(db, {
          prompt_id: promptId,
          prompt_type: (prompt['prompt_type'] as string) ?? 'unknown',
          target: (prompt['target'] as string | null) ?? null,
          status: (prompt['status'] as string) ?? 'active',
          origin: (prompt['origin'] as string) ?? 'unknown',
          generation: (prompt['generation'] as number) ?? 1,
          parent: (prompt['parent'] as string | null) ?? null,
        });
        records_indexed++;
      }
    }

    // Step REINDEX-5: integrity check — MAN-VR1
    const nodeRows = db.prepare(`
      SELECT outline_node_id, COUNT(*) as cnt
      FROM documents
      WHERE status = 'active'
      GROUP BY outline_node_id
      HAVING cnt > 1
    `).all() as { outline_node_id: string; cnt: number }[];
    for (const row of nodeRows) {
      warn(`MAN-VR1: node '${row.outline_node_id}' has ${row.cnt} active documents`);
    }
  });

  reindex();

  return { files_read, records_indexed, warnings_produced: warnings.length };
}
