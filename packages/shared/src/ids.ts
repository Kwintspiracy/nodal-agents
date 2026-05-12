// Branded UUID types — prevent accidental cross-entity ID mixing at compile time

import { z } from 'zod';

export const EntityIdSchema = z.string().guid().brand<'EntityId'>();
export type EntityId = z.infer<typeof EntityIdSchema>;

export const UserIdSchema = z.string().guid().brand<'UserId'>();
export type UserId = z.infer<typeof UserIdSchema>;

export const AgentIdSchema = z.string().guid().brand<'AgentId'>();
export type AgentId = z.infer<typeof AgentIdSchema>;

export const JobIdSchema = z.string().guid().brand<'JobId'>();
export type JobId = z.infer<typeof JobIdSchema>;

export const TaskIdSchema = z.string().guid().brand<'TaskId'>();
export type TaskId = z.infer<typeof TaskIdSchema>;

export const ConnectorIdSchema = z.string().guid().brand<'ConnectorId'>();
export type ConnectorId = z.infer<typeof ConnectorIdSchema>;

export const SkillIdSchema = z.string().guid().brand<'SkillId'>();
export type SkillId = z.infer<typeof SkillIdSchema>;

export const ToolCallIdSchema = z.string().guid().brand<'ToolCallId'>();
export type ToolCallId = z.infer<typeof ToolCallIdSchema>;

export const ApprovalRequestIdSchema = z.string().guid().brand<'ApprovalRequestId'>();
export type ApprovalRequestId = z.infer<typeof ApprovalRequestIdSchema>;

export const ApprovalRuleIdSchema = z.string().guid().brand<'ApprovalRuleId'>();
export type ApprovalRuleId = z.infer<typeof ApprovalRuleIdSchema>;

export const MemoryIdSchema = z.string().guid().brand<'MemoryId'>();
export type MemoryId = z.infer<typeof MemoryIdSchema>;

export const WebhookTriggerIdSchema = z.string().guid().brand<'WebhookTriggerId'>();
export type WebhookTriggerId = z.infer<typeof WebhookTriggerIdSchema>;

export const ScheduleIdSchema = z.string().guid().brand<'ScheduleId'>();
export type ScheduleId = z.infer<typeof ScheduleIdSchema>;

export const McpServerIdSchema = z.string().guid().brand<'McpServerId'>();
export type McpServerId = z.infer<typeof McpServerIdSchema>;

export const PluginIdSchema = z.string().guid().brand<'PluginId'>();
export type PluginId = z.infer<typeof PluginIdSchema>;

export const LlmKeyIdSchema = z.string().guid().brand<'LlmKeyId'>();
export type LlmKeyId = z.infer<typeof LlmKeyIdSchema>;

export const AgentRunIdSchema = z.string().guid().brand<'AgentRunId'>();
export type AgentRunId = z.infer<typeof AgentRunIdSchema>;
