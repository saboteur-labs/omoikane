import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CustomAdapter } from '../../src/runner/adapters/custom.ts';
import { AdapterConnectionError, AdapterTimeoutError, AdapterParseError } from '../../src/runner/adapters/interface.ts';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const CONSTITUTION = 'You are a careful research assistant.';
const CONTEXT = { outline_node: { id: 'n-001' } };

type FetchFn = typeof fetch;

function makeFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): FetchFn {
  return handler as unknown as FetchFn;
}

function okResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

function makeAdapter(fetchFn: FetchFn, opts: { model?: string; timeoutMs?: number } = {}): CustomAdapter {
  return new CustomAdapter({
    url: 'http://localhost:9999/generate',
    fetchFn,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Interface & provenance
// ---------------------------------------------------------------------------

describe('CustomAdapter — interface', () => {
  test('get_adapter_id returns "custom"', () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('{}')));
    assert.equal(adapter.get_adapter_id(), 'custom');
  });

  test('get_model_id returns configured model', () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('{}')), { model: 'my-local-llm' });
    assert.equal(adapter.get_model_id(), 'my-local-llm');
  });

  test('get_model_id defaults to "custom" when no model specified', () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('{}')));
    assert.equal(adapter.get_model_id(), 'custom');
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('CustomAdapter — happy path', () => {
  test('invoke returns AgentResponse with raw_text, parsed, model_id', async () => {
    const payload = JSON.stringify({ type: 'document', outline_node_id: 'n-001' });
    const adapter = makeAdapter(makeFetch(async () => okResponse(payload)), { model: 'my-llm' });

    const result = await adapter.invoke('scribe', CONTEXT, CONSTITUTION);

    assert.equal(result.raw_text, payload);
    assert.equal((result.parsed as Record<string, unknown>).type, 'document');
    assert.equal(result.model_id, 'my-llm');
    assert.equal(result.token_usage, undefined, 'custom adapter has no token usage');
  });

  test('POSTs constitution and context as plain text to the configured URL', async () => {
    let capturedBody: string | null = null;
    let capturedUrl: string | null = null;

    const fetchFn = makeFetch(async (url, init) => {
      capturedUrl = url as string;
      capturedBody = init?.body as string;
      return okResponse('{"type":"document"}');
    });
    const adapter = makeAdapter(fetchFn);

    await adapter.invoke('scribe', CONTEXT, CONSTITUTION);

    assert.equal(capturedUrl, 'http://localhost:9999/generate');
    assert(capturedBody?.includes(CONSTITUTION), 'body must include constitution');
    assert(capturedBody?.includes('"outline_node"'), 'body must include serialised context');
  });

  test('parses JSON wrapped in a ```json code fence', async () => {
    const inner = JSON.stringify({ type: 'learning_brief' });
    const fenced = `\`\`\`json\n${inner}\n\`\`\``;
    const adapter = makeAdapter(makeFetch(async () => okResponse(fenced)));

    const result = await adapter.invoke('scribe', CONTEXT, CONSTITUTION);
    assert.equal((result.parsed as Record<string, unknown>).type, 'learning_brief');
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('CustomAdapter — error mapping', () => {
  test('throws AdapterConnectionError when endpoint is unreachable', async () => {
    const fetchFn = makeFetch(async () => {
      throw new TypeError('fetch failed');
    });
    const adapter = makeAdapter(fetchFn);

    await assert.rejects(
      () => adapter.invoke('scribe', CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterConnectionError);
        assert((err as Error).message.includes('Endpoint unreachable'));
        return true;
      },
    );
  });

  test('throws AdapterTimeoutError on AbortError (timeout)', async () => {
    const fetchFn = makeFetch(async () => {
      throw new DOMException('The operation was aborted.', 'AbortError');
    });
    const adapter = makeAdapter(fetchFn, { timeoutMs: 100 });

    await assert.rejects(
      () => adapter.invoke('scribe', CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterTimeoutError, `expected AdapterTimeoutError, got ${(err as Error)?.constructor?.name}`);
        assert((err as Error).message.includes('100ms'));
        return true;
      },
    );
  });

  test('throws AdapterConnectionError on non-2xx HTTP status', async () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('Service Unavailable', 503)));

    await assert.rejects(
      () => adapter.invoke('scribe', CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterConnectionError);
        assert((err as Error).message.includes('503'));
        return true;
      },
    );
  });

  test('throws AdapterParseError when response body is not parseable JSON', async () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('Sorry, I cannot help.')));

    await assert.rejects(
      () => adapter.invoke('scribe', CONTEXT, CONSTITUTION),
      (err: unknown) => {
        assert(err instanceof AdapterParseError);
        assert((err as Error).message.includes('Adapter could not parse model response'));
        return true;
      },
    );
  });
});

// ---------------------------------------------------------------------------
// Smoke test
// ---------------------------------------------------------------------------

describe('CustomAdapter — smoke_test', () => {
  test('connectivity test passes when endpoint returns a non-empty response', async () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('ready')));

    const result = await adapter.smoke_test('architect', {
      id: 'CUSTOM-ST1',
      type: 'connectivity',
      input: { prompt: 'Respond with the single word: ready' },
    });

    assert.equal(result.test_id, 'CUSTOM-ST1');
    assert.equal(result.passed, true);
  });

  test('connectivity test fails when endpoint is unreachable', async () => {
    const fetchFn = makeFetch(async () => { throw new TypeError('fetch failed'); });
    const adapter = makeAdapter(fetchFn);

    const result = await adapter.smoke_test('architect', {
      id: 'CUSTOM-ST1',
      type: 'connectivity',
      input: { prompt: 'ready?' },
    });

    assert.equal(result.passed, false);
    assert(result.failure_reason !== undefined && result.failure_reason.length > 0);
  });

  test('non-connectivity test types return passed:true (stubbed pending Task 10)', async () => {
    const adapter = makeAdapter(makeFetch(async () => okResponse('{}')));
    const result = await adapter.smoke_test('scribe', { id: 'SCR-ST2', type: 'structural_compliance' });
    assert.equal(result.passed, true);
  });
});
