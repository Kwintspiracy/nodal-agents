// Round-trip tests: serialize a valid object → parse → deep equal to original

import { describe, it, expect } from 'vitest';
import {
  EntitySchema,
  EntityMemberSchema,
  UserProfileSchema,
  AgentSchema,
  AgentJobSchema,
  AgentTaskSchema,
  CredentialSchema,
  ConnectorSchema,
  ToolCallSchema,
  ApprovalRequestSchema,
  ApprovalRuleSchema,
  AgentMemorySchema,
  WebhookTriggerSchema,
  AgentSkillSchema,
  AgentScheduleSchema,
  EntityLlmKeySchema,
} from '../index';

const now = '2026-04-26T10:00:00.000Z';
const uuid = '00000000-0000-4000-8000-000000000001';
const uuid2 = '00000000-0000-4000-8000-000000000002';
const uuid3 = '00000000-0000-4000-8000-000000000003';

describe('EntitySchema round-trip', () => {
  it('parses and re-serializes cleanly', () => {
    const raw = {
      id: uuid,
      user_id: uuid2,
      name: 'Acme Corp',
      slug: 'acme-corp',
      description: 'A test workspace',
      icon: '🏢',
      industry: 'startup',
      goal: 'Automate everything',
      mcp_token: uuid3,
      created_at: now,
      updated_at: now,
    };
    const parsed = EntitySchema.parse(raw);
    expect(parsed).toEqual(raw);
  });

  it('accepts null optional fields', () => {
    const raw = {
      id: uuid,
      user_id: uuid2,
      name: 'Minimal',
      slug: 'minimal',
      description: null,
      icon: '🏢',
      industry: null,
      goal: null,
      mcp_token: null,
      created_at: now,
      updated_at: now,
    };
    expect(() => EntitySchema.parse(raw)).not.toThrow();
  });
});

describe('EntityMemberSchema round-trip', () => {
  it('parses all roles', () => {
    for (const role of ['owner', 'admin', 'member', 'viewer'] as const) {
      const raw = { id: uuid, entity_id: uuid2, user_id: uuid3, role, created_at: now };
      expect(EntityMemberSchema.parse(raw).role).toBe(role);
    }
  });
});

describe('UserProfileSchema round-trip', () => {
  it('parses full profile', () => {
    const raw = {
      user_id: uuid,
      display_name: 'Alice',
      avatar_url: 'https://example.com/a.png',
      timezone: 'Europe/Paris',
      locale: 'fr',
      created_at: now,
      updated_at: now,
    };
    expect(UserProfileSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentSchema round-trip', () => {
  it('parses a full agent row', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      name: 'Boris',
      slug: 'boris',
      personality: 'You are Boris.',
      model: 'claude-sonnet-4-6-20260217',
      active: true,
      is_default: false,
      role: 'agent' as const,
      orchestrator_mode: null,
      telegram_bot_token: null,
      telegram_bot_username: null,
      telegram_offset: null,
      requires_approval: [],
      capabilities: [],
      task_context_template: null,
      avatar_url: null,
      system_agent: false,
      max_tokens_per_job: 0,
      created_at: now,
      updated_at: now,
    };
    expect(AgentSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentJobSchema round-trip', () => {
  it('parses a completed job', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      status: 'completed' as const,
      channel: 'telegram' as const,
      task: 'Do something',
      original_task: null,
      chat_id: '12345',
      conversation_id: null,
      system_prompt: null,
      messages: [],
      tools_used: ['notion_search'],
      turn: 3,
      result: 'Done.',
      error: null,
      chain_count: 1,
      request_id: 'req-abc',
      parent_job_id: null,
      parent_request_id: null,
      total_duration_ms: 5000,
      input_tokens: 1000,
      output_tokens: 500,
      delegation_depth: 0,
      pending_delegation: null,
      completed_at: now,
      created_at: now,
      updated_at: now,
    };
    expect(AgentJobSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentTaskSchema round-trip', () => {
  it('parses a task with dependencies', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      orchestrator_id: uuid3,
      title: 'Search Notion',
      description: 'Find all pages about project X',
      status: 'todo' as const,
      priority: 'medium' as const,
      job_id: null,
      result: null,
      created_by_agent_id: uuid3,
      assigned_agent_id: null,
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      depends_on: [uuid2],
      context: { key: 'value' },
      root_job_id: null,
      locked_at: null,
      locked_by: null,
      created_at: now,
      updated_at: now,
    };
    expect(AgentTaskSchema.parse(raw)).toEqual(raw);
  });
});

describe('CredentialSchema round-trip', () => {
  it('parses a google-oauth credential', () => {
    const raw = {
      id: uuid,
      owner_user_id: uuid2,
      name: 'Mon Google perso',
      type: 'google-oauth' as const,
      payload: 'enc:v1:abc123encrypted',
      created_at: new Date('2026-04-26T10:00:00.000Z'),
      updated_at: new Date('2026-04-26T10:00:00.000Z'),
    };
    expect(CredentialSchema.parse(raw)).toEqual(raw);
  });

  it('accepts null timestamps', () => {
    const raw = {
      id: uuid,
      owner_user_id: uuid2,
      name: 'Notion cred',
      type: 'notion-oauth' as const,
      payload: 'enc:v1:notionpayload',
      created_at: null,
      updated_at: null,
    };
    expect(() => CredentialSchema.parse(raw)).not.toThrow();
  });
});

describe('ConnectorSchema round-trip', () => {
  it('parses an OAuth2 connector with credential_id', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      name: 'Google Drive',
      slug: 'google-drive',
      base_url: null,
      api_key: null,
      active: true,
      auth_type: 'oauth2' as const,
      credential_id: uuid3,
      created_at: now,
      updated_at: now,
    };
    expect(ConnectorSchema.parse(raw)).toEqual(raw);
  });

  it('parses an api_key connector with null credential_id', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      name: 'Notion',
      slug: 'notion',
      base_url: null,
      api_key: 'encrypted-key',
      active: true,
      auth_type: 'api_key' as const,
      credential_id: null,
      created_at: now,
      updated_at: now,
    };
    expect(ConnectorSchema.parse(raw)).toEqual(raw);
  });
});

describe('ToolCallSchema round-trip', () => {
  it('parses a tool call with input and output', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      job_id: uuid3,
      tool_name: 'notion_search',
      tool_input: { query: 'test' },
      tool_output: 'Results: ...',
      duration_ms: 230,
      turn: 1,
      created_at: now,
    };
    expect(ToolCallSchema.parse(raw)).toEqual(raw);
  });
});

describe('ApprovalRequestSchema round-trip', () => {
  it('parses pending approval', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      job_id: uuid3,
      agent_id: uuid2,
      tool_name: 'gmail_send',
      tool_input: { to: 'user@example.com', subject: 'Test' },
      status: 'pending' as const,
      requested_at: now,
      resolved_at: null,
      resolved_by: null,
      expires_at: now,
      notes: null,
    };
    expect(ApprovalRequestSchema.parse(raw)).toEqual(raw);
  });
});

describe('ApprovalRuleSchema round-trip', () => {
  it('parses an auto-approve rule', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      tool_name: 'notion_search',
      action: 'auto_approve' as const,
      condition_json: {},
      created_at: now,
      updated_at: now,
    };
    expect(ApprovalRuleSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentMemorySchema round-trip', () => {
  it('parses a full memory row', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'User prefers formal language',
      category: 'preference' as const,
      importance: 4,
      source: 'manual' as const,
      skill_tags: ['notion', 'writing'],
      memory_layer: 'L1' as const,
      valid_from: now,
      valid_to: null,
      fact_hash: 'abc123',
      archived: false,
      importance_locked: false,
      last_accessed_at: now,
      access_count: 5,
      created_at: now,
      updated_at: now,
    };
    expect(AgentMemorySchema.parse(raw)).toEqual(raw);
  });

  it('defaults importance_locked to false when omitted', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'User prefers formal language',
      category: 'preference' as const,
      importance: 4,
      source: 'manual' as const,
      skill_tags: ['notion', 'writing'],
      memory_layer: 'L1' as const,
      valid_from: now,
      valid_to: null,
      fact_hash: 'abc123',
      archived: false,
      last_accessed_at: now,
      access_count: 5,
      created_at: now,
      updated_at: now,
    };
    expect(AgentMemorySchema.parse(raw)).toEqual({ ...raw, importance_locked: false });
  });

  it('accepts an explicit importance_locked=true (user pin)', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: null,
      fact: 'User prefers formal language',
      category: 'preference' as const,
      importance: 5,
      source: 'manual' as const,
      skill_tags: [],
      memory_layer: null,
      valid_from: now,
      valid_to: null,
      fact_hash: 'abc123',
      archived: false,
      importance_locked: true,
      last_accessed_at: now,
      access_count: 5,
      created_at: now,
      updated_at: now,
    };
    expect(AgentMemorySchema.parse(raw)).toEqual(raw);
  });
});

describe('WebhookTriggerSchema round-trip', () => {
  it('parses an active trigger', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      name: 'Stripe Webhook',
      slug: 'stripe-webhook',
      task_template: 'Process payment event: {{body}}',
      active: true,
      secret: 'whsec_abc123',
      last_triggered_at: null,
      trigger_count: 0,
      created_at: now,
      updated_at: now,
    };
    expect(WebhookTriggerSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentSkillSchema round-trip', () => {
  it('parses a skill with operations', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      name: 'Google Drive',
      slug: 'google-drive',
      content: '# Google Drive skill',
      active: true,
      description: 'Full Drive access',
      default_content: null,
      content_overridden: false,
      required_config: [
        {
          label: 'Drive connector',
          description: 'OAuth connector',
          type: 'connector_slug' as const,
          critical: true,
        },
      ],
      operations: [
        {
          name: 'List files',
          slug: 'drive-list-files',
          risk: 'read' as const,
          requires_approval: false,
        },
      ],
      required_builtins: [],
      created_at: now,
      updated_at: now,
    };
    expect(AgentSkillSchema.parse(raw)).toEqual(raw);
  });
});

describe('AgentScheduleSchema round-trip', () => {
  it('parses a cron schedule', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      agent_id: uuid3,
      type: 'cron' as const,
      name: 'Daily digest',
      cron_expr: '0 8 * * *',
      task: 'Summarize Notion updates',
      objectives: null,
      active: true,
      last_run: null,
      next_run: now,
      last_status: null,
      chat_id: '12345',
      created_at: now,
      updated_at: now,
    };
    expect(AgentScheduleSchema.parse(raw)).toEqual(raw);
  });
});

describe('EntityLlmKeySchema round-trip', () => {
  it('parses an active LLM key', () => {
    const raw = {
      id: uuid,
      entity_id: uuid2,
      provider: 'anthropic',
      api_key: 'sk-ant-...',
      base_url: null,
      nickname: 'Main Anthropic key',
      is_active: true,
      created_at: now,
      updated_at: now,
    };
    expect(EntityLlmKeySchema.parse(raw)).toEqual(raw);
  });
});
