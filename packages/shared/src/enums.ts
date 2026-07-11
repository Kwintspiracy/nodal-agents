// All platform enums — single source of truth derived from DB CHECK constraints

import { z } from 'zod';

// agent_jobs.channel CHECK constraint
export const JOB_CHANNELS = [
  'telegram',
  'api',
  'whatsapp',
  'internal',
  'cron',
  'task-board',
  'slack',
  'discord',
  'dashboard',
  'webhook',
] as const;
export const JobChannelSchema = z.enum(JOB_CHANNELS);
export type JobChannel = z.infer<typeof JobChannelSchema>;

// agent_jobs.status CHECK constraint
export const JOB_STATUSES = [
  'pending',
  'processing',
  'completed',
  'failed',
  'awaiting_approval',
  'awaiting_delegation',
  'cancelled',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

// agent_tasks.status CHECK constraint
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled', 'blocked'] as const;
export const TaskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

// agent_tasks.priority CHECK constraint
export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export const TaskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriority = z.infer<typeof TaskPrioritySchema>;

// agents.role CHECK constraint
export const AGENT_ROLES = ['agent', 'orchestrator', 'system'] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

// agents.orchestrator_mode CHECK constraint (nullable — NULL = legacy inference)
export const ORCHESTRATOR_MODES = ['router', 'planner'] as const;
export const OrchestratorModeSchema = z.enum(ORCHESTRATOR_MODES);
export type OrchestratorMode = z.infer<typeof OrchestratorModeSchema>;

// connectors.auth_type CHECK constraint
export const CONNECTOR_AUTH_TYPES = ['api_key', 'oauth2', 'bearer', 'basic', 'none'] as const;
export const ConnectorAuthTypeSchema = z.enum(CONNECTOR_AUTH_TYPES);
export type ConnectorAuthType = z.infer<typeof ConnectorAuthTypeSchema>;

// approval_requests.status CHECK constraint
export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const;
export const ApprovalStatusSchema = z.enum(APPROVAL_STATUSES);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

// approval_rules.action CHECK constraint
export const APPROVAL_RULE_ACTIONS = ['auto_approve', 'require_approval', 'block'] as const;
export const ApprovalRuleActionSchema = z.enum(APPROVAL_RULE_ACTIONS);
export type ApprovalRuleAction = z.infer<typeof ApprovalRuleActionSchema>;

// agent_memory.category CHECK constraint
export const MEMORY_CATEGORIES = ['preference', 'context', 'outcome', 'learned_rule'] as const;
export const MemoryCategorySchema = z.enum(MEMORY_CATEGORIES);
export type MemoryCategory = z.infer<typeof MemoryCategorySchema>;

// agent_memory.source CHECK constraint
export const MEMORY_SOURCES = ['agent', 'reflection', 'manual'] as const;
export const MemorySourceSchema = z.enum(MEMORY_SOURCES);
export type MemorySource = z.infer<typeof MemorySourceSchema>;

// agent_memory.memory_layer (no CHECK — treat as open enum, but L1/L2/L3 are canonical)
export const MEMORY_LAYERS = ['L1', 'L2', 'L3'] as const;
export const MemoryLayerSchema = z.enum(MEMORY_LAYERS);
export type MemoryLayer = z.infer<typeof MemoryLayerSchema>;

// agent_schedules.type CHECK constraint
export const SCHEDULE_TYPES = ['cron', 'heartbeat'] as const;
export const ScheduleTypeSchema = z.enum(SCHEDULE_TYPES);
export type ScheduleType = z.infer<typeof ScheduleTypeSchema>;

// agent_schedules.last_status CHECK constraint (nullable)
export const SCHEDULE_LAST_STATUSES = ['success', 'failed', 'no_action'] as const;
export const ScheduleLastStatusSchema = z.enum(SCHEDULE_LAST_STATUSES);
export type ScheduleLastStatus = z.infer<typeof ScheduleLastStatusSchema>;

// entity_members.role CHECK constraint
export const ENTITY_MEMBER_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export const EntityMemberRoleSchema = z.enum(ENTITY_MEMBER_ROLES);
export type EntityMemberRole = z.infer<typeof EntityMemberRoleSchema>;

// entities.industry (from CreateEntitySchema in dashboard)
export const ENTITY_INDUSTRIES = [
  'agency',
  'startup',
  'personal',
  'studio',
  'enterprise',
  'other',
] as const;
export const EntityIndustrySchema = z.enum(ENTITY_INDUSTRIES);
export type EntityIndustry = z.infer<typeof EntityIndustrySchema>;

// skill operations risk level (from skill-templates.ts / CreateSkillSchema)
export const OPERATION_RISK_LEVELS = ['read', 'write', 'destructive'] as const;
export const OperationRiskLevelSchema = z.enum(OPERATION_RISK_LEVELS);
export type OperationRiskLevel = z.infer<typeof OperationRiskLevelSchema>;

// agent_plugins.plugin_type CHECK constraint
export const PLUGIN_TYPES = ['webhook', 'transform', 'schedule'] as const;
export const PluginTypeSchema = z.enum(PLUGIN_TYPES);
export type PluginType = z.infer<typeof PluginTypeSchema>;

// agent_plugins.hook CHECK constraint
export const PLUGIN_HOOKS = [
  'pre_task',
  'post_task',
  'pre_tool',
  'post_tool',
  'on_memory_save',
] as const;
export const PluginHookSchema = z.enum(PLUGIN_HOOKS);
export type PluginHook = z.infer<typeof PluginHookSchema>;

// mcp_servers.transport CHECK constraint
export const MCP_TRANSPORTS = ['http', 'stdio'] as const;
export const McpTransportSchema = z.enum(MCP_TRANSPORTS);
export type McpTransport = z.infer<typeof McpTransportSchema>;
