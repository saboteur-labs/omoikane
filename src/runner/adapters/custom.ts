/**
 * Custom-endpoint adapter for Omoikane.
 *
 * POSTs the assembled prompt (constitution + serialised context) as plain text
 * to a researcher-configured HTTP endpoint and returns the text response.
 *
 * PROMPT FORMATTING NOTE: This adapter sends the raw assembled prompt and
 * expects the endpoint to return a JSON object matching the agent's output
 * schema. Prompt construction, model configuration, and output formatting are
 * entirely the researcher's responsibility. The adapter does not add
 * model-specific instructions — it is a pass-through transport layer.
 *
 * Configure via .omoikane/config.yaml:
 *   agents:
 *     scribe:
 *       adapter: custom
 *       model: my-local-model       # recorded in provenance only
 *       url: http://localhost:8080/generate
 *       timeout_ms: 60000           # optional, default 30000
 */

import type { Adapter, AgentResponse, SmokeTestResult } from './interface.ts';
import { AdapterConnectionError, AdapterTimeoutError } from './interface.ts';
import { parseJsonResponse } from './parse.ts';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface CustomAdapterOptions {
  url: string;
  model?: string;
  timeoutMs?: number;
  /** Inject a fetch replacement for tests. Defaults to globalThis.fetch. */
  fetchFn?: typeof fetch;
}

export class CustomAdapter implements Adapter {
  private readonly url: string;
  private readonly _modelId: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: CustomAdapterOptions) {
    this.url = options.url;
    this._modelId = options.model ?? 'custom';
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchFn = options.fetchFn ?? globalThis.fetch;
  }

  async invoke(
    _role: string,
    context: Record<string, unknown>,
    constitution: string,
  ): Promise<AgentResponse> {
    const prompt = [constitution, JSON.stringify(context, null, 2)].join('\n\n');
    const rawText = await this.post(prompt);
    const parsed = parseJsonResponse(rawText);
    return { raw_text: rawText, parsed, model_id: this._modelId };
  }

  async smoke_test(
    _role: string,
    test_case: Record<string, unknown>,
  ): Promise<SmokeTestResult> {
    const testId = (test_case.id as string) ?? 'unknown';

    if (test_case.type === 'connectivity') {
      const input = test_case.input as Record<string, unknown> | undefined;
      const prompt = (input?.prompt as string) ?? 'Respond with the single word: ready';
      try {
        const text = await this.post(prompt);
        if (!text) return { test_id: testId, passed: false, failure_reason: 'Empty response' };
        return { test_id: testId, passed: true };
      } catch (err) {
        return { test_id: testId, passed: false, failure_reason: (err as Error).message };
      }
    }

    return { test_id: testId, passed: true };
  }

  get_model_id(): string {
    return this._modelId;
  }

  get_adapter_id(): string {
    return 'custom';
  }

  private async post(body: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchFn(this.url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') {
          throw new AdapterTimeoutError(
            `Custom endpoint did not respond within ${this.timeoutMs}ms`,
          );
        }
        throw new AdapterConnectionError(
          `Endpoint unreachable: ${(err as Error).message}`,
        );
      }

      if (!response.ok) {
        throw new AdapterConnectionError(
          `Endpoint returned HTTP ${response.status}: ${response.statusText}`,
        );
      }

      return response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}
