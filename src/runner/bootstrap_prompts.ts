import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import yaml from 'js-yaml';
import { promptPath, promptsDir } from './state/paths.ts';

interface BootstrapDef {
  question: string;
  rationale: string;
}

// Phase 1 bootstrap prompts — deliberately naive (see spec/human/section4_prompt_library.md §4.8)
const PHASE_1_DEFS: Record<string, BootstrapDef> = {
  init: {
    question:
      'Ask the researcher clarifying questions to understand their research goals, prior ' +
      'knowledge, and focus areas. Then produce a structured learning brief that captures ' +
      'their intent and will guide the outline step.',
    rationale:
      'Instructs the Architect to ask before building. Minimal framing for the learning brief dialogue.',
  },
  outline: {
    question:
      'Based on the learning brief, produce a structured outline of topics to research. ' +
      'Include factual, contested, definitional, and methodological nodes as appropriate, ' +
      'plus placeholder nodes for suspected gaps in the available knowledge.',
    rationale:
      'Minimal outline prompt. Domain-specific structure preferences are learned through refinement.',
  },
  gather: {
    question:
      'Gather content for this outline node. Identify factual claims, assess their sources, ' +
      'and flag any gaps or uncertainties. Cite all external sources explicitly.',
    rationale:
      'Minimal starting prompt. Does not encode domain-specific framing — that is learned through refinement.',
  },
};

export interface BootstrapResult {
  promptIds: string[];
}

export function createBootstrapPrompts(repoDir: string): BootstrapResult {
  const dir = promptsDir(repoDir);
  mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();
  const promptIds: string[] = [];

  for (const [promptType, def] of Object.entries(PHASE_1_DEFS)) {
    const id = `p-${promptType}-1-001`;
    const entry = {
      schema_version: '1.0',
      type: 'prompt_entry',
      id,
      prompt_type: promptType,
      target: null,
      status: 'active',
      origin: 'system',
      generation: 1,
      parent: null,
      question: def.question,
      rationale: def.rationale,
      performance: {
        last_used: now,
        run_count: 0,
        produced_sources: 0,
        confidence_delta: 0,
        user_rating: 0,
      },
      created_at: now,
    };

    const finalPath = promptPath(repoDir, promptType, 1, 1);
    const tmpPath = `${finalPath}.tmp`;
    writeFileSync(tmpPath, yaml.dump(entry, { lineWidth: 120 }), 'utf8');
    renameSync(tmpPath, finalPath);
    promptIds.push(id);
  }

  return { promptIds };
}
