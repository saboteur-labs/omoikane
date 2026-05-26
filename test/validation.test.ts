import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/runner/validation/validator.ts';

// ---------------------------------------------------------------------------
// Fixtures — minimal valid objects matching the spec schemas
// ---------------------------------------------------------------------------

const validScribeGather = {
  type: 'document',
  outline_node_id: 'node-001',
  prompt_id: 'p-bootstrap-001',
  prompt_generation: 1,
  date: '2026-05-25',
  claims: [
    {
      id: 'claim-001',
      type: 'factual',
      content: 'The speed of light in a vacuum is 299,792,458 m/s.',
      source: { tier: 'tier_3', fidelity: 'direct' },
      confidence: { level: 'high', basis: 'Well-established physical constant.' },
      status: 'active',
    },
  ],
  self_critique: {
    what_was_hard: 'Distinguishing the exact defined value from approximations.',
    confidence_floor: 'High — this is a defined constant.',
    unresolved_questions: ['What are the implications for quantum gravity theories?'],
  },
};

const validArchitectInit = {
  type: 'learning_brief',
  subject: 'Roman Aqueducts',
  goal: 'Understand the engineering principles and historical impact.',
  prior_knowledge: 'Basic knowledge of Roman history.',
  priority_angles: ['Engineering techniques', 'Water distribution'],
  definition_of_done: 'Coverage of major aqueduct systems with engineering details.',
  questions_asked: [
    { question: 'What is your prior knowledge of the subject?', answer: 'Basic Roman history.' },
  ],
};

const validArchitectOutline = {
  type: 'outline',
  version: 1,
  nodes: [
    {
      id: 'n-001',
      type: 'factual',
      title: 'Engineering Overview',
      description: 'Core engineering principles used in Roman aqueducts.',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'n-002',
      type: 'contested',
      title: 'Labour practices',
      description: 'The extent of slave versus free labour in construction.',
      parent_id: null,
      status: 'draft',
    },
    {
      id: 'n-003',
      type: 'gap_placeholder',
      title: 'Unknown aspects',
      description: 'Areas where the historical record is sparse.',
      parent_id: null,
      status: 'draft',
    },
  ],
  contested_or_edge_case_node_count: 1,
};

// ---------------------------------------------------------------------------
// Scribe — valid output
// ---------------------------------------------------------------------------

describe('Scribe gather — valid output', () => {
  test('valid document passes with no violations', () => {
    const result = validate('scribe', 'gather', validScribeGather);
    assert.equal(result.valid, true, `Expected valid but got violations: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
    assert.equal(result.checkpoints.length, 0);
  });

  test('valid document with tier_1 source and citation passes', () => {
    const output = {
      ...validScribeGather,
      claims: [
        {
          ...validScribeGather.claims[0],
          source: { tier: 'tier_1', fidelity: 'direct', citation: 'NIST SP 330 (2019)' },
        },
      ],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, true);
  });

  test('valid document with optional gap_documents passes', () => {
    const output = {
      ...validScribeGather,
      gap_documents: [
        {
          id: 'gap-001',
          nature: 'knowledge_ceiling',
          description: 'Exact protein interaction count is not retrievable.',
          status: 'open',
        },
      ],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, true);
  });
});

// ---------------------------------------------------------------------------
// Scribe — SCR-OV1: unresolved_questions must be non-empty
// ---------------------------------------------------------------------------

describe('SCR-OV1 — unresolved_questions non-empty', () => {
  test('empty unresolved_questions fires SCR-OV1', () => {
    const output = {
      ...validScribeGather,
      self_critique: { ...validScribeGather.self_critique, unresolved_questions: [] },
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    const ov1 = result.violations.find((v) => v.ruleId === 'SCR-OV1');
    assert.ok(ov1, 'SCR-OV1 violation should be present');
    assert.match(ov1.message, /unresolved_questions/);
  });

  test('SCR-OV1 message matches violation_message from YAML', () => {
    const output = {
      ...validScribeGather,
      self_critique: { ...validScribeGather.self_critique, unresolved_questions: [] },
    };
    const result = validate('scribe', 'gather', output);
    const ov1 = result.violations.find((v) => v.ruleId === 'SCR-OV1');
    assert.ok(ov1);
    // The spec violation_message starts with "Scribe gather output rejected:"
    assert.match(ov1.message, /Scribe gather output rejected/);
  });
});

// ---------------------------------------------------------------------------
// Scribe — SCR-OV2: citation required for tier_1 and tier_2 sources
// ---------------------------------------------------------------------------

describe('SCR-OV2 — citation required for tier_1/tier_2', () => {
  test('tier_1 claim with no citation fires SCR-OV2', () => {
    const output = {
      ...validScribeGather,
      claims: [{ ...validScribeGather.claims[0], source: { tier: 'tier_1', fidelity: 'direct' } }],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    const ov2 = result.violations.find((v) => v.ruleId === 'SCR-OV2');
    assert.ok(ov2, 'SCR-OV2 violation should be present');
    assert.match(ov2.message, /citation/i);
  });

  test('tier_2 claim with no citation fires SCR-OV2', () => {
    const output = {
      ...validScribeGather,
      claims: [{ ...validScribeGather.claims[0], source: { tier: 'tier_2', fidelity: 'paraphrase' } }],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    assert.ok(result.violations.find((v) => v.ruleId === 'SCR-OV2'));
  });

  test('tier_3 claim with no citation passes SCR-OV2', () => {
    const result = validate('scribe', 'gather', validScribeGather);
    assert.ok(!result.violations.find((v) => v.ruleId === 'SCR-OV2'));
  });

  test('tier_1 claim with empty string citation fires SCR-OV2', () => {
    const output = {
      ...validScribeGather,
      claims: [{ ...validScribeGather.claims[0], source: { tier: 'tier_1', fidelity: 'direct', citation: '' } }],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    assert.ok(result.violations.find((v) => v.ruleId === 'SCR-OV2'));
  });
});

// ---------------------------------------------------------------------------
// Scribe — SCR-OV3: self_critique fields must be non-empty
// ---------------------------------------------------------------------------

describe('SCR-OV3 — self_critique fields non-empty', () => {
  test('empty what_was_hard fires SCR-OV3', () => {
    const output = {
      ...validScribeGather,
      self_critique: { ...validScribeGather.self_critique, what_was_hard: '' },
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    const ov3 = result.violations.find((v) => v.ruleId === 'SCR-OV3');
    assert.ok(ov3, 'SCR-OV3 violation should be present');
    assert.match(ov3.message, /Scribe gather output rejected/);
  });

  test('empty confidence_floor fires SCR-OV3', () => {
    const output = {
      ...validScribeGather,
      self_critique: { ...validScribeGather.self_critique, confidence_floor: '' },
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    assert.ok(result.violations.find((v) => v.ruleId === 'SCR-OV3'));
  });
});

// ---------------------------------------------------------------------------
// Scribe — SCR-OV4: claim ids must be unique
// ---------------------------------------------------------------------------

describe('SCR-OV4 — claim ids unique', () => {
  test('duplicate claim ids fire SCR-OV4', () => {
    const output = {
      ...validScribeGather,
      claims: [
        validScribeGather.claims[0],
        { ...validScribeGather.claims[0], id: 'claim-001' }, // duplicate
      ],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    const ov4 = result.violations.find((v) => v.ruleId === 'SCR-OV4');
    assert.ok(ov4, 'SCR-OV4 violation should be present');
    assert.match(ov4.message, /duplicate claim id/i);
  });

  test('unique claim ids pass SCR-OV4', () => {
    const output = {
      ...validScribeGather,
      claims: [
        validScribeGather.claims[0],
        { ...validScribeGather.claims[0], id: 'claim-002' },
      ],
    };
    const result = validate('scribe', 'gather', output);
    assert.ok(!result.violations.find((v) => v.ruleId === 'SCR-OV4'));
  });
});

// ---------------------------------------------------------------------------
// Architect init — valid output
// ---------------------------------------------------------------------------

describe('Architect init — valid output', () => {
  test('valid learning_brief passes with no violations', () => {
    const result = validate('architect', 'init', validArchitectInit);
    assert.equal(result.valid, true, `Expected valid but got: ${JSON.stringify(result.violations)}`);
    assert.equal(result.violations.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Architect — ARC-OV1: questions_asked must be non-empty
// ---------------------------------------------------------------------------

describe('ARC-OV1 — questions_asked non-empty', () => {
  test('empty questions_asked fires ARC-OV1', () => {
    const output = { ...validArchitectInit, questions_asked: [] };
    const result = validate('architect', 'init', output);
    assert.equal(result.valid, false);
    const ov1 = result.violations.find((v) => v.ruleId === 'ARC-OV1');
    assert.ok(ov1, 'ARC-OV1 violation should be present');
    assert.match(ov1.message, /questions_asked/);
  });

  test('ARC-OV1 only fires on init, not on outline', () => {
    // ARC-OV1 has command: init — should not fire on outline command
    const result = validate('architect', 'outline', validArchitectOutline);
    assert.ok(!result.violations.find((v) => v.ruleId === 'ARC-OV1'));
  });
});

// ---------------------------------------------------------------------------
// Architect — ARC-OV2: justification required when no contested nodes
// ---------------------------------------------------------------------------

describe('ARC-OV2 — justification required when contested_count is 0', () => {
  test('count 0 with no justification fires ARC-OV2', () => {
    const output = {
      ...validArchitectOutline,
      nodes: validArchitectOutline.nodes.filter((n) => n.type !== 'contested' && n.type !== 'edge_case'),
      contested_or_edge_case_node_count: 0,
    };
    const result = validate('architect', 'outline', output);
    assert.equal(result.valid, false);
    const ov2 = result.violations.find((v) => v.ruleId === 'ARC-OV2');
    assert.ok(ov2, 'ARC-OV2 violation should be present');
    assert.match(ov2.message, /Architect outline output rejected/);
  });

  test('count 0 with justification passes ARC-OV2', () => {
    const output = {
      ...validArchitectOutline,
      nodes: validArchitectOutline.nodes.filter((n) => n.type !== 'contested' && n.type !== 'edge_case'),
      contested_or_edge_case_node_count: 0,
      justification_if_no_contested_nodes: 'Subject is a single verifiable historical fact.',
    };
    const result = validate('architect', 'outline', output);
    assert.ok(!result.violations.find((v) => v.ruleId === 'ARC-OV2'));
  });
});

// ---------------------------------------------------------------------------
// Architect — ARC-OV3: contested count must match actual node count
// ---------------------------------------------------------------------------

describe('ARC-OV3 — contested_count matches actual nodes', () => {
  test('declared count wrong fires ARC-OV3', () => {
    const output = { ...validArchitectOutline, contested_or_edge_case_node_count: 5 };
    const result = validate('architect', 'outline', output);
    assert.equal(result.valid, false);
    const ov3 = result.violations.find((v) => v.ruleId === 'ARC-OV3');
    assert.ok(ov3, 'ARC-OV3 violation should be present');
    assert.match(ov3.message, /contested_or_edge_case_node_count/);
  });

  test('declared count correct passes ARC-OV3', () => {
    const result = validate('architect', 'outline', validArchitectOutline);
    assert.ok(!result.violations.find((v) => v.ruleId === 'ARC-OV3'));
  });
});

// ---------------------------------------------------------------------------
// Architect — ARC-OV4: node ids must be unique
// ---------------------------------------------------------------------------

describe('ARC-OV4 — node ids unique', () => {
  test('duplicate node ids fire ARC-OV4', () => {
    const output = {
      ...validArchitectOutline,
      nodes: [
        validArchitectOutline.nodes[0],
        { ...validArchitectOutline.nodes[1], id: 'n-001' }, // duplicate
        validArchitectOutline.nodes[2],
      ],
    };
    const result = validate('architect', 'outline', output);
    assert.equal(result.valid, false);
    const ov4 = result.violations.find((v) => v.ruleId === 'ARC-OV4');
    assert.ok(ov4, 'ARC-OV4 violation should be present');
    assert.match(ov4.message, /duplicate node id/i);
  });
});

// ---------------------------------------------------------------------------
// Architect — ARC-OV5: gap_placeholder check → review checkpoint, not rejection
// ---------------------------------------------------------------------------

describe('ARC-OV5 — gap_placeholder check produces checkpoint, not rejection', () => {
  test('no gap_placeholder nodes does not fail validation', () => {
    const output = {
      ...validArchitectOutline,
      nodes: validArchitectOutline.nodes.filter((n) => n.type !== 'gap_placeholder'),
      contested_or_edge_case_node_count: 1,
    };
    const result = validate('architect', 'outline', output);
    assert.equal(result.valid, true, 'ARC-OV5 must not make valid=false');
  });

  test('no gap_placeholder nodes produces a review checkpoint', () => {
    const output = {
      ...validArchitectOutline,
      nodes: validArchitectOutline.nodes.filter((n) => n.type !== 'gap_placeholder'),
      contested_or_edge_case_node_count: 1,
    };
    const result = validate('architect', 'outline', output);
    const cp = result.checkpoints.find((c) => c.ruleId === 'ARC-OV5');
    assert.ok(cp, 'ARC-OV5 review checkpoint should be present');
    assert.match(cp.message, /gap_placeholder/i);
  });
});

// ---------------------------------------------------------------------------
// Structural validation errors (schema-level, not OV rules)
// ---------------------------------------------------------------------------

describe('structural validation', () => {
  test('missing required field on scribe output returns error', () => {
    const { claims: _, ...withoutClaims } = validScribeGather;
    const result = validate('scribe', 'gather', withoutClaims);
    assert.equal(result.valid, false);
    const hasClaimsError = result.violations.some((v) => v.message.includes('claims'));
    assert.ok(hasClaimsError, 'Should report missing claims field');
  });

  test('wrong enum value on claim type returns error', () => {
    const output = {
      ...validScribeGather,
      claims: [{ ...validScribeGather.claims[0], type: 'invalid_type' }],
    };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
    const hasEnumError = result.violations.some((v) => v.message.includes('invalid_type'));
    assert.ok(hasEnumError);
  });

  test('non-integer prompt_generation returns error', () => {
    const output = { ...validScribeGather, prompt_generation: 'one' };
    const result = validate('scribe', 'gather', output);
    assert.equal(result.valid, false);
  });

  test('missing required field on architect init returns error', () => {
    const { subject: _, ...withoutSubject } = validArchitectInit;
    const result = validate('architect', 'init', withoutSubject);
    assert.equal(result.valid, false);
    assert.ok(result.violations.some((v) => v.message.includes('subject')));
  });
});
