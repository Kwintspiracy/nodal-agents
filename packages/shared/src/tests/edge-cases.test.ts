// Edge-case tests: invalid inputs rejected, boundary values, optional vs required

import { describe, it, expect } from 'vitest';
import {
  AgentJobSchema,
  AgentJobInsertSchema,
  AgentTaskSchema,
  AgentMemorySchema,
  AgentSchema,
  EntitySchema,
  EntityMemberSchema,
  CredentialSchema,
  ConnectorSchema,
  ApprovalRequestSchema,
  WebhookTriggerSchema,
  JobChannelSchema,
  JobStatusSchema,
} from '../index';

const now = '2026-04-26T10:00:00.000Z';
const uuid = '00000000-0000-4000-8000-000000000001';
const uuid2 = '00000000-0000-4000-8000-000000000002';
const uuid3 = '00000000-0000-4000-8000-000000000003';

// ─── AgentJob invariants ───────────────────────────────────────────────────────

describe('AgentJob: chain_count cannot be negative', () => {
  it('rejects negative chain_count', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      status: 'pending' as const,
      channel: 'api' as const,
      task: 'Do something',
      original_task: null,
      chat_id: null,
      conversation_id: null,
      system_prompt: null,
      messages: [],
      tools_used: [],
      turn: 0,
      result: null,
      error: null,
      chain_count: -1,
      request_id: null,
      parent_job_id: null,
      parent_request_id: null,
      total_duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      delegation_depth: 0,
      pending_delegation: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentJobSchema.parse(base)).toThrow();
  });

  it('accepts chain_count of 0', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      status: 'pending' as const,
      channel: 'api' as const,
      task: 'Do something',
      original_task: null,
      chat_id: null,
      conversation_id: null,
      system_prompt: null,
      messages: [],
      tools_used: [],
      turn: 0,
      result: null,
      error: null,
      chain_count: 0,
      request_id: null,
      parent_job_id: null,
      parent_request_id: null,
      total_duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      delegation_depth: 0,
      pending_delegation: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentJobSchema.parse(base)).not.toThrow();
  });
});

describe('AgentJob: delegation_depth cannot be negative', () => {
  it('rejects negative delegation_depth', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      status: 'pending' as const,
      channel: 'api' as const,
      task: 'Do something',
      original_task: null,
      chat_id: null,
      conversation_id: null,
      system_prompt: null,
      messages: [],
      tools_used: [],
      turn: 0,
      result: null,
      error: null,
      chain_count: 0,
      request_id: null,
      parent_job_id: null,
      parent_request_id: null,
      total_duration_ms: 0,
      input_tokens: 0,
      output_tokens: 0,
      delegation_depth: -1,
      pending_delegation: null,
      completed_at: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentJobSchema.parse(base)).toThrow();
  });
});

describe('AgentJob: channel must be a known value', () => {
  it('rejects unknown channel', () => {
    expect(() => JobChannelSchema.parse('fax')).toThrow();
  });

  it('accepts all known channels', () => {
    const channels = [
      'telegram',
      'api',
      'whatsapp',
      'internal',
      'cron',
      'task-board',
      'slack',
      'discord',
    ];
    for (const ch of channels) {
      expect(() => JobChannelSchema.parse(ch)).not.toThrow();
    }
  });
});

describe('AgentJob: status must be a known value', () => {
  it('rejects unknown status', () => {
    expect(() => JobStatusSchema.parse('running')).toThrow();
  });
});

describe('AgentJob: insert defaults status to pending', () => {
  it('defaults status to pending', () => {
    const insert = {
      entity_id: uuid2,
      agent_id: uuid3,
      channel: 'api' as const,
      task: 'Do something',
    };
    const result = AgentJobInsertSchema.parse(insert);
    expect(result.status).toBe('pending');
  });
});

// ─── AgentTask invariants ──────────────────────────────────────────────────────

describe('AgentTask: title max 200 chars', () => {
  it('rejects titles over 200 chars', () => {
    const longTitle = 'a'.repeat(201);
    const base = {
      id: uuid,
      entity_id: uuid2,
      orchestrator_id: uuid3,
      title: longTitle,
      description: null,
      status: 'todo' as const,
      priority: 'medium' as const,
      job_id: null,
      result: null,
      created_by_agent_id: null,
      assigned_agent_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      depends_on: [],
      context: {},
      root_job_id: null,
      locked_at: null,
      locked_by: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentTaskSchema.parse(base)).toThrow();
  });
});

describe('AgentTask: description max 2000 chars', () => {
  it('rejects descriptions over 2000 chars', () => {
    const longDesc = 'a'.repeat(2001);
    const base = {
      id: uuid,
      entity_id: uuid2,
      orchestrator_id: uuid3,
      title: 'Short title',
      description: longDesc,
      status: 'todo' as const,
      priority: 'medium' as const,
      job_id: null,
      result: null,
      created_by_agent_id: null,
      assigned_agent_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      depends_on: [],
      context: {},
      root_job_id: null,
      locked_at: null,
      locked_by: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentTaskSchema.parse(base)).toThrow();
  });

  it('accepts exactly 2000 chars', () => {
    const desc = 'a'.repeat(2000);
    const base = {
      id: uuid,
      entity_id: uuid2,
      orchestrator_id: uuid3,
      title: 'Short title',
      description: desc,
      status: 'todo' as const,
      priority: 'medium' as const,
      job_id: null,
      result: null,
      created_by_agent_id: null,
      assigned_agent_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      depends_on: [],
      context: {},
      root_job_id: null,
      locked_at: null,
      locked_by: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentTaskSchema.parse(base)).not.toThrow();
  });
});

describe('AgentTask: status must be known', () => {
  it('rejects unknown task status', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      orchestrator_id: uuid3,
      title: 'Test',
      description: null,
      status: 'queued',
      priority: 'medium' as const,
      job_id: null,
      result: null,
      created_by_agent_id: null,
      assigned_agent_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      depends_on: [],
      context: {},
      root_job_id: null,
      locked_at: null,
      locked_by: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentTaskSchema.parse(base)).toThrow();
  });
});

// ─── AgentMemory invariants ────────────────────────────────────────────────────

describe('AgentMemory: importance is 1-5 (DB constraint)', () => {
  it('rejects importance 0', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'Test fact',
      category: 'context' as const,
      importance: 0,
      source: 'manual' as const,
      skill_tags: [],
      memory_layer: null,
      valid_from: null,
      valid_to: null,
      fact_hash: null,
      archived: false,
      last_accessed_at: null,
      access_count: 0,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentMemorySchema.parse(base)).toThrow();
  });

  it('rejects importance 6', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'Test fact',
      category: 'context' as const,
      importance: 6,
      source: 'manual' as const,
      skill_tags: [],
      memory_layer: null,
      valid_from: null,
      valid_to: null,
      fact_hash: null,
      archived: false,
      last_accessed_at: null,
      access_count: 0,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentMemorySchema.parse(base)).toThrow();
  });

  it('accepts boundary values 1 and 5', () => {
    for (const importance of [1, 5]) {
      const base = {
        id: uuid,
        entity_id: uuid2,
        agent_id: null,
        fact: 'Test fact',
        category: 'context' as const,
        importance,
        source: 'manual' as const,
        skill_tags: [],
        memory_layer: null,
        valid_from: null,
        valid_to: null,
        fact_hash: null,
        archived: false,
        last_accessed_at: null,
        access_count: 0,
        created_at: now,
        updated_at: now,
      };
      expect(() => AgentMemorySchema.parse(base)).not.toThrow();
    }
  });
});

describe('AgentMemory: category must be known', () => {
  it('rejects unknown category', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'Test fact',
      category: 'habit',
      importance: 3,
      source: 'manual' as const,
      skill_tags: [],
      memory_layer: null,
      valid_from: null,
      valid_to: null,
      fact_hash: null,
      archived: false,
      last_accessed_at: null,
      access_count: 0,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentMemorySchema.parse(base)).toThrow();
  });
});

// ─── Entity slug rules ─────────────────────────────────────────────────────────

describe('EntitySchema: slug must be lowercase alphanumeric with hyphens', () => {
  it('rejects slug with uppercase', () => {
    const base = {
      id: uuid,
      user_id: uuid2,
      name: 'Acme',
      slug: 'Acme-Corp',
      description: null,
      icon: '🏢',
      industry: null,
      goal: null,
      mcp_token: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => EntitySchema.parse(base)).toThrow();
  });

  it('rejects slug with spaces', () => {
    const base = {
      id: uuid,
      user_id: uuid2,
      name: 'Acme',
      slug: 'acme corp',
      description: null,
      icon: '🏢',
      industry: null,
      goal: null,
      mcp_token: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => EntitySchema.parse(base)).toThrow();
  });

  it('accepts valid slug', () => {
    const base = {
      id: uuid,
      user_id: uuid2,
      name: 'Acme',
      slug: 'acme-corp-123',
      description: null,
      icon: '🏢',
      industry: null,
      goal: null,
      mcp_token: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => EntitySchema.parse(base)).not.toThrow();
  });
});

// ─── Agent max_tokens_per_job ──────────────────────────────────────────────────

describe('AgentSchema: max_tokens_per_job must be non-negative', () => {
  it('rejects negative token limit', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      name: 'Boris',
      slug: 'boris',
      personality: 'You are Boris.',
      model: 'claude-sonnet-4-6',
      active: true,
      is_default: false,
      role: 'agent' as const,
      orchestrator_mode: null,
      telegram_bot_token: null,
      telegram_bot_username: null,
      telegram_offset: null,
      capabilities: [],
      task_context_template: null,
      avatar_url: null,
      system_agent: false,
      max_tokens_per_job: -1,
      created_at: now,
      updated_at: now,
    };
    expect(() => AgentSchema.parse(base)).toThrow();
  });
});

// ─── EntityMember role ─────────────────────────────────────────────────────────

describe('EntityMemberSchema: role must be known', () => {
  it('rejects unknown role', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      user_id: uuid3,
      role: 'superadmin',
      created_at: now,
    };
    expect(() => EntityMemberSchema.parse(base)).toThrow();
  });
});

// ─── Strict schema: no extra fields ───────────────────────────────────────────

describe('Strict schemas reject unknown fields', () => {
  it('rejects unknown fields on ConnectorSchema', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      name: 'Test',
      slug: 'test',
      base_url: null,
      api_key: null,
      active: true,
      auth_type: 'api_key' as const,
      credential_id: null,
      created_at: now,
      updated_at: now,
      mystery_field: 'should be rejected',
    };
    expect(() => ConnectorSchema.parse(base)).toThrow();
  });
});

// ─── CredentialSchema invariants ───────────────────────────────────────────────

describe('CredentialSchema: type must be a known value', () => {
  it('rejects unknown credential type', () => {
    expect(() =>
      CredentialSchema.parse({
        id: uuid,
        owner_user_id: uuid2,
        name: 'Test',
        type: 'github-oauth',
        payload: 'enc:v1:xyz',
        created_at: null,
        updated_at: null,
      }),
    ).toThrow();
  });

  it('accepts all known credential types', () => {
    for (const type of ['google-oauth', 'notion-oauth', 'airtable-oauth'] as const) {
      expect(() =>
        CredentialSchema.parse({
          id: uuid,
          owner_user_id: uuid2,
          name: 'Test',
          type,
          payload: 'enc:v1:xyz',
          created_at: null,
          updated_at: null,
        }),
      ).not.toThrow();
    }
  });
});

// ─── ApprovalRequest: all statuses valid ──────────────────────────────────────

describe('ApprovalRequestSchema: approval status boundaries', () => {
  const makeBase = (status: string) => ({
    id: uuid,
    entity_id: uuid2,
    job_id: uuid3,
    agent_id: null,
    tool_name: 'test_tool',
    tool_input: {},
    status,
    requested_at: now,
    resolved_at: null,
    resolved_by: null,
    expires_at: null,
    notes: null,
  });

  it('accepts all valid statuses', () => {
    for (const s of ['pending', 'approved', 'rejected', 'expired']) {
      expect(() => ApprovalRequestSchema.parse(makeBase(s))).not.toThrow();
    }
  });

  it('rejects unknown status', () => {
    expect(() => ApprovalRequestSchema.parse(makeBase('denied'))).toThrow();
  });
});

// ─── WebhookTrigger: slug validation ──────────────────────────────────────────

describe('WebhookTriggerSchema: slug validation', () => {
  it('rejects invalid slug characters', () => {
    const base = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      name: 'Test',
      slug: 'My Webhook!',
      task_template: 'Do {{thing}}',
      active: true,
      secret: null,
      last_triggered_at: null,
      trigger_count: 0,
      created_at: now,
      updated_at: now,
    };
    expect(() => WebhookTriggerSchema.parse(base)).toThrow();
  });
});
