import { join } from 'node:path';

export function manifestPath(repoDir: string): string {
  return join(repoDir, 'manifest.yaml');
}

export function outlinePath(repoDir: string): string {
  return join(repoDir, 'outline.yaml');
}

export function learningBriefPath(repoDir: string): string {
  return join(repoDir, 'learning_brief.yaml');
}

export function documentDir(repoDir: string, nodeId: string): string {
  return join(repoDir, 'documents', nodeId);
}

export function documentPath(repoDir: string, nodeId: string, date: string, seq: number): string {
  const seqStr = String(seq).padStart(3, '0');
  return join(documentDir(repoDir, nodeId), `doc-${nodeId}-${date}-${seqStr}.yaml`);
}

export function gapsDir(repoDir: string): string {
  return join(repoDir, 'gaps');
}

export function gapPath(repoDir: string, date: string, seq: number): string {
  const seqStr = String(seq).padStart(3, '0');
  return join(gapsDir(repoDir), `gap-${date}-${seqStr}.yaml`);
}

export function promptsDir(repoDir: string): string {
  return join(repoDir, 'prompts');
}

export function promptPath(repoDir: string, type: string, generation: number, seq: number): string {
  const seqStr = String(seq).padStart(3, '0');
  return join(promptsDir(repoDir), `p-${type}-${generation}-${seqStr}.yaml`);
}

export function omoikaneDir(repoDir: string): string {
  return join(repoDir, '.omoikane');
}

export function checkpointHistoryPath(repoDir: string): string {
  return join(omoikaneDir(repoDir), 'checkpoint_history.yaml');
}

export function smokeTestsPath(repoDir: string): string {
  return join(omoikaneDir(repoDir), 'smoke_tests.yaml');
}

export function toDateStamp(date: Date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
