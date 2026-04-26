// Branded UUID types — prevent accidental cross-entity ID mixing at compile time

import { z } from 'zod';

export const EntityIdSchema = z.string().uuid().brand<'EntityId'>();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const UserIdSchema = z.string().uuid().brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

export const AgentIdSchema = z.string().uuid().brand<'AgentId'>();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const JobIdSchema = z.string().uuid().brand<'JobId'>();
export type JobId = z.infer<typeof JobIdSchema>;

export const TaskIdSchema = z.string().uuid().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const ConnectorIdSchema = z.string().uuid().brand<'ConnectorId'>();
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

export const SkillIdSchema = z.string().uuid().brand<'SkillId'>();
export type SkillId = z.infer<typeof SkillIdSchema>;

export const ToolCallIdSchema = z.string().uuid().brand<'ToolCallId'>();
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const ApprovalRequestIdSchema = z.string().uuid().brand<'ApprovalRequestId'>();
export type ApprovalRequestId = z.infer<typeof ApprovalRequestIdSchema>;

export const ApprovalRuleIdSchema = z.string().uuid().brand<'ApprovalRuleId'>();
export type ApprovalRuleId = z.infer<typeof ApprovalRuleIdSchema>;

export const MemoryIdSchema = z.string().uuid().brand<'MemoryId'>();
export type MemoryId = z.infer<typeof MemoryIdSchema>;

export const WebhookTriggerIdSchema = z.string().uuid().brand<'WebhookTriggerId'>();
export type WebhookTriggerId = z.infer<typeof WebhookTriggerIdSchema>;

export const ScheduleIdSchema = z.string().uuid().brand<'ScheduleId'>();
export type ScheduleId = z.infer<typeof ScheduleIdSchema>;

export const McpServerIdSchema = z.string().uuid().brand<'McpServerId'>();
export type McpServerId = z.infer<typeof McpServerIdSchema>;

export const PluginIdSchema = z.string().uuid().brand<'PluginId'>();
export type PluginId = z.infer<typeof PluginIdSchema>;

export const LlmKeyIdSchema = z.string().uuid().brand<'LlmKeyId'>();
export type LlmKeyId = z.infer<typeof LlmKeyIdSchema>;

export const AgentRunIdSchema = z.string().uuid().brand<'AgentRunId'>();
export type AgentRunId = z.infer<typeof AgentRunIdSchema>;
