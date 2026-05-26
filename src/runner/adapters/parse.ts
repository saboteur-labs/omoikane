import { AdapterParseError } from './interface.ts';

/**
 * Extracts a JSON object from a model response string.
 * Handles raw JSON, ```json code fences, and JSON preceded by prose text.
 * Throws AdapterParseError if no valid JSON object can be extracted.
 */
export function parseJsonResponse(text: string): Record<string, unknown> {
  const trimmed = text.trim();

  // 1. Try raw JSON
  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    // fall through
  }

  // 2. Strip markdown code fence
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch?.[1]) {
    try {
      return JSON.parse(fenceMatch[1].trim()) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  // 3. Extract outermost { ... } as a last resort
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>;
    } catch {
      // fall through
    }
  }

  throw new AdapterParseError(
    'Adapter could not parse model response into expected structure. ' +
      'Raw response logged. Check model or prompt configuration.',
  );
}
