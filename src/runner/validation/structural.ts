import type { CommandSchema, PropertySchema } from './types.ts';

/**
 * Validates a parsed output object against a command's output_schema.
 * Returns an array of human-readable error strings (empty = valid).
 */
export function validateStructural(schema: CommandSchema, output: unknown): string[] {
  if (output === null || output === undefined || typeof output !== 'object') {
    return ['output: expected an object'];
  }
  return validateObject(output as Record<string, unknown>, schema.required_fields, schema.properties, 'output');
}

function validateObject(
  obj: Record<string, unknown>,
  requiredFields: string[],
  properties: Record<string, PropertySchema>,
  path: string,
): string[] {
  const errors: string[] = [];

  for (const field of requiredFields) {
    // A required field is only "missing" if undefined. null is present-but-null
    // and is validated via the property schema's nullable flag below.
    if (obj[field] === undefined) {
      errors.push(`${path}.${field}: required field missing`);
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    const value = obj[key];

    // Absent or null optional fields are always valid — null is treated as absent.
    if (value === undefined || (value === null && propSchema.required === false)) continue;

    // null values on required fields are passed to validateValue, which enforces nullable
    errors.push(...validateValue(value, propSchema, `${path}.${key}`));
  }

  return errors;
}

function validateValue(value: unknown, schema: PropertySchema, path: string): string[] {
  const errors: string[] = [];

  if (value === null || value === undefined) {
    if (schema.nullable) return [];
    return [`${path}: value is null/undefined but not nullable`];
  }

  if (schema.type) {
    switch (schema.type) {
      case 'string': {
        if (typeof value !== 'string') {
          errors.push(`${path}: expected string, got ${typeof value}`);
          break;
        }
        if (schema.enum && !schema.enum.includes(value)) {
          errors.push(`${path}: '${value}' is not a valid value; expected one of: ${schema.enum.join(', ')}`);
        }
        if (schema.min_length !== undefined && value.length < schema.min_length) {
          errors.push(`${path}: must have minimum length ${schema.min_length}, got ${value.length}`);
        }
        break;
      }
      case 'integer': {
        if (typeof value !== 'number' || !Number.isInteger(value)) {
          errors.push(`${path}: expected integer, got ${typeof value}`);
          break;
        }
        if (schema.min !== undefined && value < schema.min) {
          errors.push(`${path}: must be >= ${schema.min}, got ${value}`);
        }
        break;
      }
      case 'array': {
        if (!Array.isArray(value)) {
          errors.push(`${path}: expected array, got ${typeof value}`);
          break;
        }
        if (schema.min_items !== undefined && value.length < schema.min_items) {
          errors.push(`${path}: must have at least ${schema.min_items} item(s), got ${value.length}`);
        }
        if (schema.items) {
          value.forEach((item, i) => {
            errors.push(...validateValue(item, schema.items!, `${path}[${i}]`));
          });
        }
        break;
      }
      case 'object': {
        if (typeof value !== 'object' || Array.isArray(value)) {
          errors.push(`${path}: expected object, got ${Array.isArray(value) ? 'array' : typeof value}`);
          break;
        }
        errors.push(
          ...validateObject(
            value as Record<string, unknown>,
            schema.required_fields ?? [],
            schema.properties ?? {},
            path,
          ),
        );
        break;
      }
    }
  }

  return errors;
}
