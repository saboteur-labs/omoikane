import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { omoikaneDir } from './paths.ts';
import type { Manifest, ManifestDocument, ManifestCheckpoint } from './manifest.ts';

export function dbPath(repoDir: string): string {
  return join(omoikaneDir(repoDir), 'omoikane.db');
}

export function openDb(repoDir: string): Database.Database {
  mkdirSync(omoikaneDir(repoDir), { recursive: true });
  const db = new Database(dbPath(repoDir));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function createSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      document_id       TEXT PRIMARY KEY,
      outline_node_id   TEXT NOT NULL,
      status            TEXT NOT NULL,
      prompt_id         TEXT NOT NULL,
      prompt_generation INTEGER NOT NULL,
      adapter           TEXT NOT NULL,
      model             TEXT NOT NULL,
      date              TEXT NOT NULL,
      supersedes        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_documents_node_status
      ON documents (outline_node_id, status);

    CREATE TABLE IF NOT EXISTS claims (
      claim_id          TEXT PRIMARY KEY,
      document_id       TEXT NOT NULL,
      outline_node_id   TEXT NOT NULL,
      claim_type        TEXT NOT NULL,
      source_tier       TEXT NOT NULL,
      confidence_level  TEXT NOT NULL,
      status            TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS signal_events (
      entry_id          TEXT PRIMARY KEY,
      prompt_id         TEXT NOT NULL,
      signal_type       TEXT NOT NULL,
      signal_category   TEXT NOT NULL,
      document_id       TEXT NOT NULL,
      event_date        TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_signal_events_prompt_category
      ON signal_events (prompt_id, signal_category);

    CREATE TABLE IF NOT EXISTS checkpoints (
      checkpoint_id     TEXT PRIMARY KEY,
      checkpoint_type   TEXT NOT NULL,
      produced_by       TEXT NOT NULL,
      affected_object_id TEXT NOT NULL,
      description       TEXT NOT NULL,
      created_at        TEXT NOT NULL,
      principle_ref     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_checkpoints_type
      ON checkpoints (checkpoint_type);

    CREATE TABLE IF NOT EXISTS gap_documents (
      gap_id            TEXT PRIMARY KEY,
      nature            TEXT NOT NULL,
      status            TEXT NOT NULL,
      outline_node_id   TEXT,
      produced_by       TEXT NOT NULL,
      created_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS prompts (
      prompt_id         TEXT PRIMARY KEY,
      prompt_type       TEXT NOT NULL,
      target            TEXT,
      status            TEXT NOT NULL,
      origin            TEXT NOT NULL,
      generation        INTEGER NOT NULL,
      parent            TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_prompts_type_status
      ON prompts (prompt_type, status);
  `);
}

export function dropSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS prompts;
    DROP TABLE IF EXISTS gap_documents;
    DROP TABLE IF EXISTS checkpoints;
    DROP TABLE IF EXISTS signal_events;
    DROP TABLE IF EXISTS claims;
    DROP TABLE IF EXISTS documents;
  `);
}

// ---------------------------------------------------------------------------
// Sync helpers — called from the atomic write protocol in state_manager
// ---------------------------------------------------------------------------

/**
 * Replaces the documents and checkpoints tables with the current manifest state.
 * Must be called inside a transaction.
 */
export function syncManifestToDb(db: Database.Database, manifest: Manifest): void {
  const upsertDoc = db.prepare(`
    INSERT OR REPLACE INTO documents
      (document_id, outline_node_id, status, prompt_id, prompt_generation, adapter, model, date, supersedes)
    VALUES
      (@document_id, @outline_node_id, @status, @prompt_id, @prompt_generation, @adapter, @model, @date, @supersedes)
  `);

  const deleteDoc = db.prepare('DELETE FROM documents WHERE document_id = @document_id');
  const existingDocIds = new Set<string>(
    (db.prepare('SELECT document_id FROM documents').all() as { document_id: string }[])
      .map((r) => r.document_id),
  );
  const manifestDocIds = new Set(manifest.documents.map((d) => d.document_id));

  // Remove docs no longer in manifest (shouldn't normally happen — documents are never removed)
  for (const id of existingDocIds) {
    if (!manifestDocIds.has(id)) deleteDoc.run({ document_id: id });
  }

  // Upsert all docs from manifest
  for (const doc of manifest.documents) {
    upsertDoc.run({
      document_id: doc.document_id,
      outline_node_id: doc.outline_node_id,
      status: doc.status,
      prompt_id: doc.prompt_id,
      prompt_generation: doc.prompt_generation,
      adapter: doc.adapter,
      model: doc.model,
      date: doc.date,
      supersedes: doc.superseded_by ?? null,
    });
  }

  // Rebuild checkpoints table from manifest.open_checkpoints
  db.prepare('DELETE FROM checkpoints').run();
  const insertCp = db.prepare(`
    INSERT INTO checkpoints
      (checkpoint_id, checkpoint_type, produced_by, affected_object_id, description, created_at, principle_ref)
    VALUES
      (@checkpoint_id, @checkpoint_type, @produced_by, @affected_object_id, @description, @created_at, @principle_ref)
  `);
  for (const cp of manifest.open_checkpoints) {
    insertCp.run({
      checkpoint_id: cp.checkpoint_id,
      checkpoint_type: cp.type,
      produced_by: cp.produced_by,
      affected_object_id: cp.affected_object_id,
      description: cp.description,
      created_at: cp.created_at,
      principle_ref: cp.principle_ref ?? null,
    });
  }
}

// ---------------------------------------------------------------------------
// Bulk insert helpers — used by reindex
// ---------------------------------------------------------------------------

export function insertClaim(
  db: Database.Database,
  claim: {
    claim_id: string;
    document_id: string;
    outline_node_id: string;
    claim_type: string;
    source_tier: string;
    confidence_level: string;
    status: string;
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO claims
      (claim_id, document_id, outline_node_id, claim_type, source_tier, confidence_level, status)
    VALUES
      (@claim_id, @document_id, @outline_node_id, @claim_type, @source_tier, @confidence_level, @status)
  `).run(claim);
}

export function insertSignalEvent(
  db: Database.Database,
  event: {
    entry_id: string;
    prompt_id: string;
    signal_type: string;
    signal_category: string;
    document_id: string;
    event_date: string;
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO signal_events
      (entry_id, prompt_id, signal_type, signal_category, document_id, event_date)
    VALUES
      (@entry_id, @prompt_id, @signal_type, @signal_category, @document_id, @event_date)
  `).run(event);
}

export function insertGapDocument(
  db: Database.Database,
  gap: {
    gap_id: string;
    nature: string;
    status: string;
    outline_node_id: string | null;
    produced_by: string;
    created_at: string;
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO gap_documents
      (gap_id, nature, status, outline_node_id, produced_by, created_at)
    VALUES
      (@gap_id, @nature, @status, @outline_node_id, @produced_by, @created_at)
  `).run(gap);
}

export function insertPrompt(
  db: Database.Database,
  prompt: {
    prompt_id: string;
    prompt_type: string;
    target: string | null;
    status: string;
    origin: string;
    generation: number;
    parent: string | null;
  },
): void {
  db.prepare(`
    INSERT OR REPLACE INTO prompts
      (prompt_id, prompt_type, target, status, origin, generation, parent)
    VALUES
      (@prompt_id, @prompt_type, @target, @status, @origin, @generation, @parent)
  `).run(prompt);
}

// ---------------------------------------------------------------------------
// Query helpers — used by later tasks
// ---------------------------------------------------------------------------

export function getActiveDocumentsForNode(
  db: Database.Database,
  nodeId: string,
): { document_id: string }[] {
  return db
    .prepare("SELECT document_id FROM documents WHERE outline_node_id = ? AND status = 'active'")
    .all(nodeId) as { document_id: string }[];
}

export function getOpenCheckpoints(
  db: Database.Database,
): { checkpoint_id: string; checkpoint_type: string; affected_object_id: string }[] {
  return db
    .prepare('SELECT checkpoint_id, checkpoint_type, affected_object_id FROM checkpoints ORDER BY checkpoint_type')
    .all() as { checkpoint_id: string; checkpoint_type: string; affected_object_id: string }[];
}
