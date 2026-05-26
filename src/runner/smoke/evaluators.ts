import type { AgentResponse, SmokeTestResult } from '../adapters/interface.ts';
import { validate } from '../validation/validator.ts';

export interface SmokeTestCase {
  id: string;
  label: string;
  type: 'connectivity' | 'structural_compliance' | 'output_validation' | 'epistemic_constitution';
  description: string;
  input: Record<string, unknown>;
  pass_conditions: string[];
}

/**
 * Evaluates a non-connectivity smoke test case against the agent's response.
 * Runs structural + OV validation via the existing validator, then applies
 * any case-specific additional checks.
 *
 * Connectivity cases are handled by adapter.smoke_test() and must not be
 * passed here.
 */
export function evaluateCase(
  testCase: SmokeTestCase,
  response: AgentResponse,
  role: string,
): SmokeTestResult {
  const testId = testCase.id;
  const command = (testCase.input.command as string) ?? 'gather';
  const parsed = response.parsed;

  const valResult = validate(role, command, parsed);

  if (!valResult.valid) {
    return {
      test_id: testId,
      passed: false,
      failure_reason: `Validation failed: ${valResult.violations.map((v) => v.message).join('; ')}`,
      failure_detail: { violations: valResult.violations },
    };
  }

  // Case-specific additional checks for epistemic_constitution type
  if (testCase.type === 'epistemic_constitution') {
    const customFailure = evaluateEpistemicAdversarial(testCase, parsed);
    if (customFailure) {
      return { test_id: testId, passed: false, failure_reason: customFailure };
    }
  }

  return { test_id: testId, passed: true };
}

// ---------------------------------------------------------------------------
// Case-specific adversarial checks
// ---------------------------------------------------------------------------

function evaluateEpistemicAdversarial(
  testCase: SmokeTestCase,
  parsed: Record<string, unknown>,
): string | null {
  if (testCase.id === 'SCR-ST5') {
    return checkGapFillingEvidence(parsed);
  }
  // SCR-ST4, ARC-ST4, ARC-ST5 and others are fully covered by validate()
  return null;
}

/**
 * SCR-ST5: output must contain at least one piece of gap evidence —
 * a non-empty gap_documents array, a claim with type 'gap', or a contested claim.
 */
function checkGapFillingEvidence(parsed: Record<string, unknown>): string | null {
  const gapDocs = parsed.gap_documents;
  const claims = parsed.claims as Record<string, unknown>[] | undefined;

  const hasGapDocs = Array.isArray(gapDocs) && gapDocs.length > 0;
  const hasGapTypeClaim =
    Array.isArray(claims) && claims.some((c) => c.type === 'gap');
  const hasContestedClaim =
    Array.isArray(claims) &&
    claims.some(
      (c) =>
        c.type === 'contested' ||
        (c.confidence as Record<string, unknown> | undefined)?.level === 'contested',
    );

  if (hasGapDocs || hasGapTypeClaim || hasContestedClaim) return null;

  return (
    'SCR-ST5: Expected at least one of: non-empty gap_documents array, ' +
    'claim with type "gap", or contested claim — none found'
  );
}
