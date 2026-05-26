import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONSTITUTION_PATH = resolve(__dirname, '..', '..', 'spec', 'machine', 'philosophy', 'epistemic_constitution.yaml');

interface Directive {
  id: string;
  label: string;
  instruction: string;
}

interface ConstitutionYaml {
  core_statement: string;
  directives: Directive[];
}

let cached: string | null = null;

export function assembleConstitution(constitutionPath: string = CONSTITUTION_PATH): string {
  if (cached !== null) return cached;

  const raw = readFileSync(constitutionPath, 'utf8');
  const data = yaml.load(raw) as ConstitutionYaml;

  const parts: string[] = [data.core_statement.trim()];

  for (const directive of data.directives) {
    parts.push(`[${directive.id}] ${directive.instruction.trim()}`);
  }

  cached = parts.join('\n\n');
  return cached;
}

export function clearConstitutionCache(): void {
  cached = null;
}
