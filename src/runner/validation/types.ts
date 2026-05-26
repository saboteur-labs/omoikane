export interface PropertySchema {
  type?: 'string' | 'integer' | 'array' | 'object';
  required?: boolean;
  required_fields?: string[];
  properties?: Record<string, PropertySchema>;
  items?: PropertySchema;
  enum?: string[];
  min_length?: number;
  min_items?: number;
  min?: number;
  nullable?: boolean;
  format?: string;
  note?: string;
}

export interface CommandSchema {
  root_type: string;
  required_fields: string[];
  properties: Record<string, PropertySchema>;
}

export interface OVRule {
  id: string;
  rule: string;
  command?: string;
  description: string;
  check: string;
  violation_message: string;
  on_failure?: 'checkpoint_review';
}

export interface HardConstraint {
  id: string;
  label: string;
  description: string;
  enforcement: string;
  principle_ref: string;
}

export interface AgentSpec {
  role: string;
  output_schema: Record<string, CommandSchema>;
  output_validation: OVRule[];
  hard_constraints: HardConstraint[];
}

export interface Violation {
  ruleId: string;
  message: string;
}

export interface CheckpointReview {
  ruleId: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  violations: Violation[];
  checkpoints: CheckpointReview[];
}
