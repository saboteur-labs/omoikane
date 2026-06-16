import type { Adapter, AgentResponse, SmokeTestResult } from './interface.ts';

export class FakeAdapter implements Adapter {
  private readonly _adapterId: string;
  private readonly _modelId: string;
  public lastInvokedRole: string | null = null;
  public lastConstitution: string | null = null;
  public lastContext: Record<string, unknown> | null = null;

  constructor(adapterId = 'fake', modelId = 'fake-model-1') {
    this._adapterId = adapterId;
    this._modelId = modelId;
  }

  async invoke(
    role: string,
    context: Record<string, unknown>,
    constitution: string,
  ): Promise<AgentResponse> {
    this.lastInvokedRole = role;
    this.lastContext = context;
    this.lastConstitution = constitution;

    return {
      raw_text: '{}',
      parsed: {},
      model_id: this._modelId,
    };
  }

  async smoke_test(_role: string, test_case: Record<string, unknown>): Promise<SmokeTestResult> {
    return {
      test_id: (test_case.id as string) ?? 'unknown',
      passed: true,
    };
  }

  get_model_id(): string {
    return this._modelId;
  }

  get_adapter_id(): string {
    return this._adapterId;
  }
}
