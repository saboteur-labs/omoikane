export interface AgentResponse {
  raw_text: string;
  parsed: Record<string, unknown>;
  model_id: string;
  token_usage?: { input_tokens: number; output_tokens: number };
}

export interface SmokeTestResult {
  test_id: string;
  passed: boolean;
  failure_reason?: string;
  failure_detail?: Record<string, unknown>;
}

export interface Adapter {
  invoke(role: string, context: Record<string, unknown>, constitution: string): Promise<AgentResponse>;
  smoke_test(role: string, test_case: Record<string, unknown>): Promise<SmokeTestResult>;
  get_model_id(): string;
  get_adapter_id(): string;
}

export class AdapterConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterConnectionError';
  }
}

export class AdapterTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterTimeoutError';
  }
}

export class AdapterRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterRateLimitError';
  }
}

export class AdapterParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterParseError';
  }
}
