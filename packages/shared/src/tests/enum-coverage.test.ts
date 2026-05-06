// Enum coverage tests: every enum value matches the DB CHECK constraint

import { describe, it, expect } from 'vitest';
import {
  JOB_CHANNELS,
  JOB_STATUSES,
  TASK_STATUSES,
  TASK_PRIORITIES,
  AGENT_ROLES,
  ORCHESTRATOR_MODES,
  CONNECTOR_AUTH_TYPES,
  APPROVAL_STATUSES,
  APPROVAL_RULE_ACTIONS,
  MEMORY_CATEGORIES,
  MEMORY_SOURCES,
  MEMORY_LAYERS,
  SCHEDULE_TYPES,
  SCHEDULE_LAST_STATUSES,
  RUN_KEY_SOURCES,
  ENTITY_MEMBER_ROLES,
  ENTITY_INDUSTRIES,
  OPERATION_RISK_LEVELS,
  PLUGIN_TYPES,
  PLUGIN_HOOKS,
  MCP_TRANSPORTS,
  JobChannelSchema,
  JobStatusSchema,
  TaskStatusSchema,
  TaskPrioritySchema,
  AgentRoleSchema,
  OrchestratorModeSchema,
  ConnectorAuthTypeSchema,
  ApprovalStatusSchema,
  ApprovalRuleActionSchema,
  MemoryCategorySchema,
  MemorySourceSchema,
  MemoryLayerSchema,
  ScheduleTypeSchema,
  ScheduleLastStatusSchema,
  RunKeySourceSchema,
  EntityMemberRoleSchema,
  EntityIndustrySchema,
  OperationRiskLevelSchema,
  PluginTypeSchema,
  PluginHookSchema,
  McpTransportSchema,
} from '../index';

// Helper: assert every value in the array is accepted by its schema, and a random other value is not
function testEnum(
  name: string,
  values: readonly string[],
  parser: { parse: (v: unknown) => unknown },
) {
  describe(`${name} enum`, () => {
    it('accepts all known values', () => {
      for (const v of values) {
        expect(() => parser.parse(v), `expected ${name}=${v} to be valid`).not.toThrow();
      }
    });

    it('rejects an unknown value', () => {
      expect(() => parser.parse('__invalid_sentinel__')).toThrow();
    });
  });
}

testEnum('JobChannel', JOB_CHANNELS, JobChannelSchema);
testEnum('JobStatus', JOB_STATUSES, JobStatusSchema);
testEnum('TaskStatus', TASK_STATUSES, TaskStatusSchema);
testEnum('TaskPriority', TASK_PRIORITIES, TaskPrioritySchema);
testEnum('AgentRole', AGENT_ROLES, AgentRoleSchema);
testEnum('OrchestratorMode', ORCHESTRATOR_MODES, OrchestratorModeSchema);
testEnum('ConnectorAuthType', CONNECTOR_AUTH_TYPES, ConnectorAuthTypeSchema);
testEnum('ApprovalStatus', APPROVAL_STATUSES, ApprovalStatusSchema);
testEnum('ApprovalRuleAction', APPROVAL_RULE_ACTIONS, ApprovalRuleActionSchema);
testEnum('MemoryCategory', MEMORY_CATEGORIES, MemoryCategorySchema);
testEnum('MemorySource', MEMORY_SOURCES, MemorySourceSchema);
testEnum('MemoryLayer', MEMORY_LAYERS, MemoryLayerSchema);
testEnum('ScheduleType', SCHEDULE_TYPES, ScheduleTypeSchema);
testEnum('ScheduleLastStatus', SCHEDULE_LAST_STATUSES, ScheduleLastStatusSchema);
testEnum('RunKeySource', RUN_KEY_SOURCES, RunKeySourceSchema);
testEnum('EntityMemberRole', ENTITY_MEMBER_ROLES, EntityMemberRoleSchema);
testEnum('EntityIndustry', ENTITY_INDUSTRIES, EntityIndustrySchema);
testEnum('OperationRiskLevel', OPERATION_RISK_LEVELS, OperationRiskLevelSchema);
testEnum('PluginType', PLUGIN_TYPES, PluginTypeSchema);
testEnum('PluginHook', PLUGIN_HOOKS, PluginHookSchema);
testEnum('McpTransport', MCP_TRANSPORTS, McpTransportSchema);

// Specific DB constraint cross-checks — these encode the exact values from the CHECK clauses

describe('DB constraint: agent_jobs channel_check', () => {
  it('matches exactly the 8 DB channels', () => {
    const dbChannels = [
      'telegram',
      'api',
      'whatsapp',
      'internal',
      'cron',
      'task-board',
      'slack',
      'discord',
    ];
    expect([...JOB_CHANNELS].sort()).toEqual(dbChannels.sort());
  });
});

describe('DB constraint: agent_jobs status_check', () => {
  it('matches exactly the 7 DB statuses', () => {
    const dbStatuses = [
      'pending',
      'processing',
      'completed',
      'failed',
      'awaiting_approval',
      'awaiting_delegation',
      'cancelled',
    ];
    expect([...JOB_STATUSES].sort()).toEqual(dbStatuses.sort());
  });
});

describe('DB constraint: agent_tasks status_check', () => {
  it('matches exactly the 5 DB task statuses', () => {
    const dbStatuses = ['todo', 'in_progress', 'done', 'cancelled', 'blocked'];
    expect([...TASK_STATUSES].sort()).toEqual(dbStatuses.sort());
  });
});

describe('DB constraint: agent_tasks priority_check', () => {
  it('matches exactly the 3 DB priorities', () => {
    const dbPriorities = ['low', 'medium', 'high'];
    expect([...TASK_PRIORITIES].sort()).toEqual(dbPriorities.sort());
  });
});

describe('DB constraint: agents role_check', () => {
  it('matches exactly the 3 DB agent roles', () => {
    const dbRoles = ['agent', 'orchestrator', 'system'];
    expect([...AGENT_ROLES].sort()).toEqual(dbRoles.sort());
  });
});

describe('DB constraint: agents orchestrator_mode_check', () => {
  it('matches exactly the 2 DB orchestrator modes', () => {
    const dbModes = ['router', 'planner'];
    expect([...ORCHESTRATOR_MODES].sort()).toEqual(dbModes.sort());
  });
});

describe('DB constraint: connectors auth_type_check', () => {
  it('matches exactly the 5 DB auth types', () => {
    const dbAuthTypes = ['api_key', 'oauth2', 'bearer', 'basic', 'none'];
    expect([...CONNECTOR_AUTH_TYPES].sort()).toEqual(dbAuthTypes.sort());
  });
});

describe('DB constraint: approval_requests status_check', () => {
  it('matches exactly the 4 DB approval statuses', () => {
    const dbStatuses = ['pending', 'approved', 'rejected', 'expired'];
    expect([...APPROVAL_STATUSES].sort()).toEqual(dbStatuses.sort());
  });
});

describe('DB constraint: approval_rules action_check', () => {
  it('matches exactly the 3 DB actions', () => {
    const dbActions = ['auto_approve', 'require_approval', 'block'];
    expect([...APPROVAL_RULE_ACTIONS].sort()).toEqual(dbActions.sort());
  });
});

describe('DB constraint: agent_memory category_check', () => {
  it('matches exactly the 4 DB memory categories', () => {
    const dbCategories = ['preference', 'context', 'outcome', 'learned_rule'];
    expect([...MEMORY_CATEGORIES].sort()).toEqual(dbCategories.sort());
  });
});

describe('DB constraint: agent_memory source_check', () => {
  it('matches exactly the 3 DB memory sources', () => {
    const dbSources = ['agent', 'reflection', 'manual'];
    expect([...MEMORY_SOURCES].sort()).toEqual(dbSources.sort());
  });
});

describe('DB constraint: entity_members role_check', () => {
  it('matches exactly the 4 DB member roles', () => {
    const dbRoles = ['owner', 'admin', 'member', 'viewer'];
    expect([...ENTITY_MEMBER_ROLES].sort()).toEqual(dbRoles.sort());
  });
});

describe('DB constraint: agent_schedules type_check', () => {
  it('matches exactly the 2 DB schedule types', () => {
    const dbTypes = ['cron', 'heartbeat'];
    expect([...SCHEDULE_TYPES].sort()).toEqual(dbTypes.sort());
  });
});

describe('DB constraint: agent_schedules last_status_check', () => {
  it('matches exactly the 3 DB last_status values', () => {
    const dbStatuses = ['success', 'failed', 'no_action'];
    expect([...SCHEDULE_LAST_STATUSES].sort()).toEqual(dbStatuses.sort());
  });
});

describe('DB constraint: agent_plugins plugin_type_check', () => {
  it('matches exactly the 3 DB plugin types', () => {
    const dbTypes = ['webhook', 'transform', 'schedule'];
    expect([...PLUGIN_TYPES].sort()).toEqual(dbTypes.sort());
  });
});

describe('DB constraint: agent_plugins hook_check', () => {
  it('matches exactly the 5 DB hook values', () => {
    const dbHooks = ['pre_task', 'post_task', 'pre_tool', 'post_tool', 'on_memory_save'];
    expect([...PLUGIN_HOOKS].sort()).toEqual(dbHooks.sort());
  });
});

describe('DB constraint: mcp_servers transport_check', () => {
  it('matches exactly the 2 DB transport values', () => {
    const dbTransports = ['http', 'stdio'];
    expect([...MCP_TRANSPORTS].sort()).toEqual(dbTransports.sort());
  });
});

describe('DB constraint: agent_runs key_source_check', () => {
  it('matches exactly the 2 DB key sources', () => {
    const dbSources = ['entity', 'operator'];
    expect([...RUN_KEY_SOURCES].sort()).toEqual(dbSources.sort());
  });
});
