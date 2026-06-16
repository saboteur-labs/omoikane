import type { OVRule } from './types.ts';

/**
 * Evaluates a single output validation rule against an output object.
 * Returns the violation_message string if the rule fires, null if it passes.
 *
 * Rule logic is implemented as typed functions keyed by rule ID. The YAML
 * `check` field is human-readable documentation of the intent, not evaluated
 * directly. New rules require a new case here.
 */
export function evaluateRule(rule: OVRule, output: unknown): string | null {
  const evaluator = RULE_EVALUATORS[rule.id];
  if (!evaluator) return null; // unknown rule: pass-through (fail-open for forward compat)
  const fired = evaluator(output);
  return fired ? rule.violation_message.trim() : null;
}

type RuleEvaluator = (output: unknown) => boolean;

const RULE_EVALUATORS: Record<string, RuleEvaluator> = {
  // --- Scribe rules ---

  // SCR-OV1: self_critique.unresolved_questions must be non-empty
  'SCR-OV1': (output) => {
    const doc = output as Record<string, unknown>;
    const sc = doc?.self_critique as Record<string, unknown> | undefined;
    const questions = sc?.unresolved_questions;
    return !Array.isArray(questions) || questions.length === 0;
  },

  // SCR-OV2: tier_1 and tier_2 claims must have a non-empty citation
  'SCR-OV2': (output) => {
    const doc = output as Record<string, unknown>;
    const claims = (doc?.claims as unknown[]) ?? [];
    return claims.some((claim) => {
      const c = claim as Record<string, unknown>;
      const source = c?.source as Record<string, unknown> | undefined;
      const tier = source?.tier;
      if (tier !== 'tier_1' && tier !== 'tier_2') return false;
      const citation = source?.citation;
      return !citation || (typeof citation === 'string' && citation.length === 0);
    });
  },

  // SCR-OV3: self_critique.what_was_hard and confidence_floor must be non-empty
  'SCR-OV3': (output) => {
    const doc = output as Record<string, unknown>;
    const sc = doc?.self_critique as Record<string, unknown> | undefined;
    const hard = sc?.what_was_hard;
    const floor = sc?.confidence_floor;
    return (
      !hard || (typeof hard === 'string' && hard.length === 0) ||
      !floor || (typeof floor === 'string' && floor.length === 0)
    );
  },

  // SCR-OV4: all claim ids within a document must be unique
  'SCR-OV4': (output) => {
    const doc = output as Record<string, unknown>;
    const claims = (doc?.claims as unknown[]) ?? [];
    const ids = claims
      .map((c) => (c as Record<string, unknown>)?.id)
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids).size !== ids.length;
  },

  // --- Architect rules ---

  // ARC-OV1 (command: init): questions_asked must be non-empty
  'ARC-OV1': (output) => {
    const lb = output as Record<string, unknown>;
    const questions = lb?.questions_asked;
    return !Array.isArray(questions) || questions.length === 0;
  },

  // ARC-OV2 (command: outline): justification required when contested_count is 0
  'ARC-OV2': (output) => {
    const outline = output as Record<string, unknown>;
    if (outline?.contested_or_edge_case_node_count !== 0) return false;
    const justification = outline?.justification_if_no_contested_nodes;
    return !justification || (typeof justification === 'string' && justification.length === 0);
  },

  // ARC-OV3 (command: outline): declared contested count must match actual node count
  'ARC-OV3': (output) => {
    const outline = output as Record<string, unknown>;
    const declared = outline?.contested_or_edge_case_node_count;
    if (typeof declared !== 'number') return false;
    const nodes = (outline?.nodes as unknown[]) ?? [];
    const actual = nodes.filter((n) => {
      const node = n as Record<string, unknown>;
      return node?.type === 'contested' || node?.type === 'edge_case';
    }).length;
    return declared !== actual;
  },

  // ARC-OV4 (command: outline): all node ids must be unique
  'ARC-OV4': (output) => {
    const outline = output as Record<string, unknown>;
    const nodes = (outline?.nodes as unknown[]) ?? [];
    const ids = nodes
      .map((n) => (n as Record<string, unknown>)?.id)
      .filter((id): id is string => typeof id === 'string');
    return new Set(ids).size !== ids.length;
  },

  // ARC-OV5 (command: outline, on_failure: checkpoint_review): gap_placeholder required
  'ARC-OV5': (output) => {
    const outline = output as Record<string, unknown>;
    const nodes = (outline?.nodes as unknown[]) ?? [];
    return !nodes.some((n) => (n as Record<string, unknown>)?.type === 'gap_placeholder');
  },
};
