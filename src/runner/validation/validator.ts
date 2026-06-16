import { loadAgentSpec } from './schema_loader.ts';
import { validateStructural } from './structural.ts';
import { evaluateRule } from './rules.ts';
import type { ValidationResult, Violation, CheckpointReview } from './types.ts';

/**
 * Validates an agent's output against its output_schema (structural) and
 * output_validation rules (business logic).
 *
 * Structural errors and OV rule violations are returned together. Rules with
 * on_failure: checkpoint_review produce entries in result.checkpoints and do
 * not set valid=false.
 */
export function validate(role: string, command: string, output: unknown): ValidationResult {
  const spec = loadAgentSpec(role);
  const commandSchema = spec.output_schema?.[command];

  const violations: Violation[] = [];
  const checkpoints: CheckpointReview[] = [];

  // 1. Structural validation against output_schema
  if (commandSchema) {
    const structuralErrors = validateStructural(commandSchema, output);
    for (const message of structuralErrors) {
      violations.push({ ruleId: 'structural', message });
    }
  }

  // 2. Business rule validation against output_validation
  for (const rule of spec.output_validation ?? []) {
    // Rules with a command filter only apply to that command
    if (rule.command && rule.command !== command) continue;

    const violationMessage = evaluateRule(rule, output);
    if (violationMessage === null) continue;

    if (rule.on_failure === 'checkpoint_review') {
      checkpoints.push({ ruleId: rule.id, message: violationMessage });
    } else {
      violations.push({ ruleId: rule.id, message: violationMessage });
    }
  }

  return {
    valid: violations.length === 0,
    violations,
    checkpoints,
  };
}
