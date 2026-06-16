import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { ClaudeAdapter } from '../../src/runner/adapters/claude.ts';
import type { AnthropicLike } from '../../src/runner/adapters/claude.ts';
import {
  AdapterConnectionError,
  AdapterTimeoutError,
  AdapterRateLimitError,
  AdapterParseError,
} from '../../src/runner/adapters/interface.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeMessage(text: string): Anthropic.Message {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 20 },
  } as unknown as Anthropic.Message;
}

function makeMockClient(responses: Array<() => Promise<Anthropic.Message>>): AnthropicLike & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    messages: {
      create: async (_params: Anthropic.MessageCreateParamsNonStreaming) => {
        const fn = responses[callCount++];
        if (!fn) throw new Error(`Unexpected call #${callCount} — only ${responses.length} responses configured`);
        return fn();
      },
    },
  };
}

function noSleep(_ms: number): Promise<void> {
  return Promise.resolve();
}

const CONSTITUTION = 'You are a careful research assistant.';
const SCRIBE_CONTEXT = { outline_node: { id: 'n-001' }, learning_brief: { subject: 'Test' }, assigned_prompt: 'p-001' };

// ---------------------------------------------------------------------------
// Interface & provenance
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — interface', () => {
  test('get_adapter_id returns "claude"', () => {
    const adapter = new ClaudeAdapter({ client: makeMockClient([]), sleepFn: noSleep });
    assert.equal(adapter.get_adapter_id(), 'claude');
  });

  test('get_model_id returns configured model', () => {
    const adapter = new ClaudeAdapter({ model: 'claude-custom-1', client: makeMockClient([]), sleepFn: noSleep });
    assert.equal(adapter.get_model_id(), 'claude-custom-1');
  });

  test('get_model_id defaults to claude-sonnet-4-6', () => {
    const adapter = new ClaudeAdapter({ client: makeMockClient([]), sleepFn: noSleep });
    assert.equal(adapter.get_model_id(), 'claude-sonnet-4-6');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — happy path', () => {
  test('invoke returns AgentResponse with raw_text, parsed, model_id, token_usage', async () => {
    const payload = JSON.stringify({ type: 'document', outline_node_id: 'n-001' });
    const client = makeMockClient([() => Promise.resolve(makeMessage(payload))]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION);

    assert.equal(result.raw_text, payload);
    assert.equal((result.parsed as Record<string, unknown>).type, 'document');
    assert.equal(result.model_id, 'claude-sonnet-4-6');
    assert(result.token_usage !== undefined);
    assert.equal(result.token_usage!.input_tokens, 10);
    assert.equal(result.token_usage!.output_tokens, 20);
  });

  test('parses JSON wrapped in a ```json code fence', async () => {
    const inner = JSON.stringify({ type: 'learning_brief', subject: 'Rome' });
    const wrapped = `\`\`\`json\n${inner}\n\`\`\``;
    const client = makeMockClient([() => Promise.resolve(makeMessage(wrapped))]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.invoke('architect', {}, CONSTITUTION);
    assert.equal((result.parsed as Record<string, unknown>).type, 'learning_brief');
  });

  test('parses JSON preceded by prose text via outermost-object extraction', async () => {
    const text = 'Here is my response:\n{"type":"document","outline_node_id":"n-001"}\nEnd.';
    const client = makeMockClient([() => Promise.resolve(makeMessage(text))]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION);
    assert.equal((result.parsed as Record<string, unknown>).type, 'document');
  });
});

// ---------------------------------------------------------------------------
// Parse error
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — parse error', () => {
  test('throws AdapterParseError when response is not parseable JSON', async () => {
    const client = makeMockClient([() => Promise.resolve(makeMessage('Sorry, I cannot do that.'))]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(
      () => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterParseError, `expected AdapterParseError, got ${(err as Error)?.constructor?.name}`);
        assert(
          (err as Error).message.includes('Adapter could not parse model response'),
          'message should match spec wording',
        );
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Rate-limit retry
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — rate-limit retry', () => {
  test('retries up to 3 times on RateLimitError then throws AdapterRateLimitError', async () => {
    const rateLimitErr = new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
    const client = makeMockClient([
      () => Promise.reject(rateLimitErr),
      () => Promise.reject(rateLimitErr),
      () => Promise.reject(rateLimitErr),
      () => Promise.reject(rateLimitErr),
    ]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(
      () => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterRateLimitError, `expected AdapterRateLimitError, got ${(err as Error)?.constructor?.name}`);
        return true;
      },
    );

    assert.equal(client.callCount, 4, 'should have called: 1 initial + 3 retries = 4 total');
  });

  test('succeeds if rate limit clears before retries are exhausted', async () => {
    const rateLimitErr = new Anthropic.RateLimitError(429, {}, 'rate limited', new Headers());
    const payload = JSON.stringify({ type: 'document', outline_node_id: 'n-001' });
    const client = makeMockClient([
      () => Promise.reject(rateLimitErr),
      () => Promise.reject(rateLimitErr),
      () => Promise.resolve(makeMessage(payload)),
    ]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION);
    assert.equal((result.parsed as Record<string, unknown>).type, 'document');
    assert.equal(client.callCount, 3);
  });
});

// ---------------------------------------------------------------------------
// Connection / auth / timeout errors
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — error mapping', () => {
  test('throws AdapterConnectionError on AuthenticationError (missing/invalid key)', async () => {
    const authErr = new Anthropic.AuthenticationError(401, {}, 'invalid key', new Headers());
    const client = makeMockClient([() => Promise.reject(authErr)]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(
      () => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterConnectionError);
        assert((err as Error).message.includes('Authentication failed'));
        return true;
      },
    );
  });

  test('throws AdapterConnectionError on APIConnectionError', async () => {
    const connErr = new Anthropic.APIConnectionError({ message: 'connection refused' });
    const client = makeMockClient([() => Promise.reject(connErr)]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(
      () => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION),
      AdapterConnectionError,
    );
  });

  test('throws AdapterTimeoutError on APIConnectionTimeoutError', async () => {
    const timeoutErr = new Anthropic.APIConnectionTimeoutError({ message: 'timed out' });
    const client = makeMockClient([() => Promise.reject(timeoutErr)]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(
      () => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterTimeoutError, `expected AdapterTimeoutError, got ${(err as Error)?.constructor?.name}`);
        return true;
      },
    );
  });

  test('does NOT retry on AuthenticationError (not a rate limit)', async () => {
    const authErr = new Anthropic.AuthenticationError(401, {}, 'invalid key', new Headers());
    const client = makeMockClient([
      () => Promise.reject(authErr),
      () => Promise.resolve(makeMessage('{"type":"document"}')),
    ]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    await assert.rejects(() => adapter.invoke('scribe', SCRIBE_CONTEXT, CONSTITUTION));
    assert.equal(client.callCount, 1, 'auth error must not trigger retry');
  });
});

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe('ClaudeAdapter — smoke_test', () => {
  test('connectivity test passes when model returns non-empty response', async () => {
    const client = makeMockClient([() => Promise.resolve(makeMessage('ready'))]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.smoke_test('architect', {
      id: 'ARC-ST1',
      type: 'connectivity',
      input: { prompt: 'Respond with the single word: ready' },
    });

    assert.equal(result.test_id, 'ARC-ST1');
    assert.equal(result.passed, true);
  });

  test('connectivity test fails when connection error is thrown', async () => {
    const connErr = new Anthropic.APIConnectionError({ message: 'connection refused' });
    const client = makeMockClient([() => Promise.reject(connErr)]);
    const adapter = new ClaudeAdapter({ client, sleepFn: noSleep });

    const result = await adapter.smoke_test('architect', {
      id: 'ARC-ST1',
      type: 'connectivity',
      input: { prompt: 'Respond with the single word: ready' },
    });

    assert.equal(result.passed, false);
    assert(result.failure_reason !== undefined && result.failure_reason.length > 0);
  });

  test('non-connectivity test types return passed:true (stubbed pending Task 10)', async () => {
    const adapter = new ClaudeAdapter({ client: makeMockClient([]), sleepFn: noSleep });
    const result = await adapter.smoke_test('architect', { id: 'ARC-ST2', type: 'structural_compliance' });
    assert.equal(result.passed, true);
  });
});
