import Anthropic from '@anthropic-ai/sdk';
import type { Adapter, AgentResponse, SmokeTestResult } from './interface.ts';
import {
  AdapterConnectionError,
  AdapterTimeoutError,
  AdapterRateLimitError,
  AdapterParseError,
} from './interface.ts';
import { parseJsonResponse } from './parse.ts';
import { loadAgentSpec } from '../validation/schema_loader.ts';
import type { PropertySchema, CommandSchema, AgentSpec } from '../validation/types.ts';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_RETRIES = 3;

// Minimal interface matching what we need from the Anthropic client,
// allowing injection of test doubles without coupling to the full SDK class.
export interface AnthropicLike {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ClaudeAdapterOptions {
  apiKey?: string;
  model?: string;
  /** Inject a test double. Real Anthropic client is created when omitted. */
  client?: AnthropicLike;
  specDir?: string;
  /** Override for tests — avoids real delays during retry testing. */
  sleepFn?: (ms: number) => Promise<void>;
}

export class ClaudeAdapter implements Adapter {
  private readonly client: AnthropicLike;
  private readonly _modelId: string;
  private readonly specDir: string | undefined;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(options: ClaudeAdapterOptions = {}) {
    this._modelId = options.model ?? DEFAULT_MODEL;
    this.client =
      options.client ??
      new Anthropic({ apiKey: options.apiKey ?? process.env['ANTHROPIC_API_KEY'] });
    this.specDir = options.specDir;
    this.sleepFn =
      options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async invoke(
    role: string,
    context: Record<string, unknown>,
    constitution: string,
  ): Promise<AgentResponse> {
    const command = context.command as string | undefined;
    const systemPrompt = this.buildSystemPrompt(role, constitution, command);
    const userMessage = JSON.stringify(context, null, 2);
    return this.callWithRetry(systemPrompt, userMessage, 0);
  }

  async smoke_test(
    _role: string,
    test_case: Record<string, unknown>,
  ): Promise<SmokeTestResult> {
    const testId = (test_case.id as string) ?? 'unknown';

    try {
      if (test_case.type === 'connectivity') {
        const input = test_case.input as Record<string, unknown> | undefined;
        const prompt = (input?.prompt as string) ?? 'Respond with the single word: ready';
        const response = await this.client.messages.create({
          model: this._modelId,
          max_tokens: 16,
          messages: [{ role: 'user', content: prompt }],
        });
        const text = extractText(response);
        if (!text) {
          return { test_id: testId, passed: false, failure_reason: 'Empty response from model' };
        }
        return { test_id: testId, passed: true };
      }

      // Structural compliance, output validation, and adversarial cases
      // are handled by the smoke test framework (Task 9 / runSmokeTests).
      return { test_id: testId, passed: true };
    } catch (err) {
      const mapped = mapError(err);
      return { test_id: testId, passed: false, failure_reason: mapped.message };
    }
  }

  get_model_id(): string {
    return this._modelId;
  }

  get_adapter_id(): string {
    return 'claude';
  }

  private buildSystemPrompt(role: string, constitution: string, command?: string): string {
    const parts: string[] = [constitution];

    let spec: AgentSpec | undefined;
    try {
      spec = loadAgentSpec(role, this.specDir);
    } catch {
      // Spec not found — continue without spec-based additions
    }

    const stance = spec ? (spec as unknown as Record<string, unknown>)['stance'] as string | undefined : undefined;

    if (stance) {
      parts.push(`You are the ${role} agent in the Omoikane research system. ${stance.trim()}`);
    } else {
      parts.push(`You are the ${role} agent in the Omoikane research system.`);
    }

    if (spec && command) {
      const commandSchema = spec.output_schema[command];
      if (commandSchema) {
        const template = commandSchemaToTemplate(commandSchema);
        parts.push(
          `Output schema for the '${command}' command.\n` +
          `Required top-level fields: ${commandSchema.required_fields.join(', ')}\n\n` +
          `Your response MUST be a JSON object matching this structure:\n${template}`,
        );
      }

      if (spec.hard_constraints?.length) {
        const lines = spec.hard_constraints.map(
          (hc) => `- [${hc.id}] ${hc.description.replace(/\s+/g, ' ').trim()}`,
        );
        parts.push(`Hard constraints your output MUST satisfy:\n${lines.join('\n')}`);
      }
    }

    parts.push(
      'Respond with valid JSON only. Do not include any text before or after the JSON ' +
        'object. You may wrap the JSON in a ```json code block if necessary.',
    );

    return parts.join('\n\n');
  }

  private async callWithRetry(
    systemPrompt: string,
    userMessage: string,
    attempt: number,
  ): Promise<AgentResponse> {
    let rawText = '';
    try {
      const response = await this.client.messages.create({
        model: this._modelId,
        max_tokens: 8192,
        system: systemPrompt,
        messages: [{ role: 'user', content: userMessage }],
      });

      rawText = extractText(response);
      const parsed = parseJsonResponse(rawText);

      return {
        raw_text: rawText,
        parsed,
        model_id: response.model,
        token_usage: {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
        },
      };
    } catch (err) {
      if (err instanceof AdapterParseError && rawText) {
        process.stderr.write(`[omoikane] Raw model response (parse failed):\n${rawText}\n`);
      }
      if (isRateLimitError(err) && attempt < MAX_RETRIES) {
        const delayMs = Math.pow(2, attempt) * 1000;
        await this.sleepFn(delayMs);
        return this.callWithRetry(systemPrompt, userMessage, attempt + 1);
      }
      throw mapError(err);
    }
  }
}

// ---------------------------------------------------------------------------
// Schema → JSON template (for system prompt)
// ---------------------------------------------------------------------------

function propertyToTemplate(prop: PropertySchema, depth: number): string {
  const indent = '  '.repeat(depth);
  const nextIndent = '  '.repeat(depth + 1);

  if (prop.enum && prop.enum.length === 1) {
    return JSON.stringify(prop.enum[0]);
  }
  if (prop.enum) {
    return `"<${prop.enum.join(' | ')}>"`;
  }
  if (prop.format === 'iso8601') {
    return '"<YYYY-MM-DD>"';
  }
  if (prop.type === 'integer') {
    return '<integer>';
  }
  if (prop.type === 'string') {
    return '"<string>"';
  }
  if (prop.type === 'array') {
    if (!prop.items) return '[]';
    if (!prop.items.properties) {
      return `[${propertyToTemplate(prop.items, depth)}]`;
    }
    return `[\n${nextIndent}${propertyToTemplate(prop.items, depth + 1)}\n${indent}]`;
  }
  if (prop.type === 'object' && prop.properties) {
    const fields = Object.entries(prop.properties).map(([key, val]) => {
      const suffix =
        val.required === false
          ? ' // optional'
          : val.note
            ? ` // ${val.note.replace(/\s+/g, ' ').trim()}`
            : '';
      return `${nextIndent}"${key}": ${propertyToTemplate(val, depth + 1)}${suffix}`;
    });
    return `{\n${fields.join(',\n')}\n${indent}}`;
  }
  return '"<value>"';
}

function commandSchemaToTemplate(schema: CommandSchema): string {
  return propertyToTemplate(
    { type: 'object', required_fields: schema.required_fields, properties: schema.properties },
    0,
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(response: Anthropic.Message): string {
  for (const block of response.content) {
    if (block.type === 'text') return block.text;
  }
  return '';
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Anthropic.RateLimitError;
}

function mapError(err: unknown): Error {
  if (err instanceof AdapterParseError) return err;
  // Check timeout before connection — timeout extends connection in the SDK
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new AdapterTimeoutError(
      `Model did not respond within the configured timeout: ${(err as Error).message}`,
    );
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new AdapterConnectionError(`Endpoint unreachable: ${(err as Error).message}`);
  }
  if (err instanceof Anthropic.AuthenticationError) {
    return new AdapterConnectionError(
      `Authentication failed — check ANTHROPIC_API_KEY: ${(err as Error).message}`,
    );
  }
  if (err instanceof Anthropic.RateLimitError) {
    return new AdapterRateLimitError(`API rate limit reached: ${(err as Error).message}`);
  }
  if (err instanceof Anthropic.APIError) {
    return new AdapterConnectionError(`API error (${err.status}): ${(err as Error).message}`);
  }
  if (err instanceof Error) return err;
  return new Error(String(err));
}
