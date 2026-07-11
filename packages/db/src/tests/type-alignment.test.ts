// Type alignment test — compile-time only (no runtime assertions needed beyond import).
//
// Drizzle's $inferSelect uses camelCase field names (userId, mcpToken) because
// that's how the table columns are defined. @nodal-agents/shared uses snake_case.
//
// What we verify:
// 1. Every DB table row type has the expected camelCase field names from Drizzle
// 2. Key fields that the shared type exposes exist in the DB row (just with camelCase)
//
// This file will fail tsc --noEmit if the table definitions are missing critical columns.

import type {
  EntityRow,
  EntityMemberRow,
  AgentRow,
  AgentJobRow,
  AgentTaskRow,
  AgentMemoryRow,
  CredentialRow,
  ConnectorRow,
  ToolCallRow,
  ApprovalRequestRow,
  ApprovalRuleRow,
  AgentSkillRow,
  AgentSkillAssignmentRow,
  AgentScheduleRow,
  EntityLlmKeyRow,
  WebhookTriggerRow,
  UserProfileRow,
  UserRow,
  AgentConnectorAssignmentRow,
  ChannelBindingRow,
  ChannelAllowedConversationRow,
} from '../schema/index.ts';

import { describe, it, expect } from 'vitest';

// ── Helper: assert a type has a given set of camelCase keys ───────────────────
type HasKeys<T, Keys extends (keyof T)[]> = Keys extends Array<keyof T> ? true : false;

// ── users ─────────────────────────────────────────────────────────────────────
type UserKeysOk = HasKeys<UserRow, ['id', 'email', 'passwordHash', 'createdAt', 'updatedAt']>;
const _userKeysOk: UserKeysOk = true;
void _userKeysOk;

// ── user_profiles ─────────────────────────────────────────────────────────────
type UserProfileKeysOk = HasKeys<
  UserProfileRow,
  ['userId', 'displayName', 'avatarUrl', 'timezone', 'locale', 'createdAt', 'updatedAt']
>;
const _userProfileKeysOk: UserProfileKeysOk = true;
void _userProfileKeysOk;

// ── entities ──────────────────────────────────────────────────────────────────
type EntityKeysOk = HasKeys<
  EntityRow,
  [
    'id',
    'userId',
    'name',
    'slug',
    'description',
    'icon',
    'industry',
    'goal',
    'mcpToken',
    'createdAt',
    'updatedAt',
  ]
>;
const _entityKeysOk: EntityKeysOk = true;
void _entityKeysOk;

// ── entity_members ────────────────────────────────────────────────────────────
type EntityMemberKeysOk = HasKeys<
  EntityMemberRow,
  ['id', 'entityId', 'userId', 'role', 'createdAt']
>;
const _entityMemberKeysOk: EntityMemberKeysOk = true;
void _entityMemberKeysOk;

// ── agents ────────────────────────────────────────────────────────────────────
type AgentKeysOk = HasKeys<
  AgentRow,
  [
    'id',
    'entityId',
    'name',
    'slug',
    'personality',
    'model',
    'active',
    'isDefault',
    'role',
    'orchestratorMode',
    'telegramBotToken',
    'telegramBotUsername',
    'requiresApproval',
    'capabilities',
    'taskContextTemplate',
    'avatarUrl',
    'systemAgent',
    'maxTokensPerJob',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentKeysOk: AgentKeysOk = true;
void _agentKeysOk;

// ── agent_connector_assignments ───────────────────────────────────────────────
type AgentConnectorAssignmentKeysOk = HasKeys<
  AgentConnectorAssignmentRow,
  ['id', 'agentId', 'connectorId', 'entityId', 'enabledOperations', 'createdAt', 'updatedAt']
>;
const _agentConnectorAssignmentKeysOk: AgentConnectorAssignmentKeysOk = true;
void _agentConnectorAssignmentKeysOk;

// ── agent_jobs ────────────────────────────────────────────────────────────────
type AgentJobKeysOk = HasKeys<
  AgentJobRow,
  [
    'id',
    'entityId',
    'agentId',
    'status',
    'channel',
    'task',
    'originalTask',
    'chatId',
    'systemPrompt',
    'messages',
    'toolsUsed',
    'turn',
    'result',
    'error',
    'chainCount',
    'requestId',
    'parentJobId',
    'parentRequestId',
    'totalDurationMs',
    'inputTokens',
    'outputTokens',
    'delegationDepth',
    'pendingDelegation',
    'completedAt',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentJobKeysOk: AgentJobKeysOk = true;
void _agentJobKeysOk;

// ── agent_tasks ───────────────────────────────────────────────────────────────
type AgentTaskKeysOk = HasKeys<
  AgentTaskRow,
  [
    'id',
    'entityId',
    'orchestratorId',
    'title',
    'description',
    'status',
    'priority',
    'jobId',
    'result',
    'createdByAgentId',
    'assignedAgentId',
    'inputTokens',
    'outputTokens',
    'costUsd',
    'dependsOn',
    'context',
    'rootJobId',
    'lockedAt',
    'lockedBy',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentTaskKeysOk: AgentTaskKeysOk = true;
void _agentTaskKeysOk;

// ── agent_memory ──────────────────────────────────────────────────────────────
// Note: embedding excluded from shared type by design (pgvector not surfaced to JS callers)
type AgentMemoryKeysOk = HasKeys<
  AgentMemoryRow,
  [
    'id',
    'entityId',
    'agentId',
    'fact',
    'category',
    'importance',
    'source',
    'skillTags',
    'memoryLayer',
    'embedding',
    'validFrom',
    'validTo',
    'factHash',
    'archived',
    'lastAccessedAt',
    'accessCount',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentMemoryKeysOk: AgentMemoryKeysOk = true;
void _agentMemoryKeysOk;

// ── credentials ───────────────────────────────────────────────────────────────
type CredentialKeysOk = HasKeys<
  CredentialRow,
  ['id', 'ownerUserId', 'name', 'type', 'payload', 'createdAt', 'updatedAt']
>;
const _credentialKeysOk: CredentialKeysOk = true;
void _credentialKeysOk;

// ── connectors ────────────────────────────────────────────────────────────────
type ConnectorKeysOk = HasKeys<
  ConnectorRow,
  [
    'id',
    'entityId',
    'name',
    'slug',
    'baseUrl',
    'apiKey',
    'active',
    'authType',
    'credentialId',
    'createdAt',
    'updatedAt',
  ]
>;
const _connectorKeysOk: ConnectorKeysOk = true;
void _connectorKeysOk;

// ── tool_calls ────────────────────────────────────────────────────────────────
type ToolCallKeysOk = HasKeys<
  ToolCallRow,
  [
    'id',
    'entityId',
    'jobId',
    'toolName',
    'toolInput',
    'toolOutput',
    'durationMs',
    'turn',
    'createdAt',
  ]
>;
const _toolCallKeysOk: ToolCallKeysOk = true;
void _toolCallKeysOk;

// ── approval_requests ─────────────────────────────────────────────────────────
type ApprovalRequestKeysOk = HasKeys<
  ApprovalRequestRow,
  [
    'id',
    'entityId',
    'jobId',
    'agentId',
    'toolName',
    'toolInput',
    'status',
    'requestedAt',
    'resolvedAt',
    'resolvedBy',
    'expiresAt',
    'notes',
  ]
>;
const _approvalRequestKeysOk: ApprovalRequestKeysOk = true;
void _approvalRequestKeysOk;

// ── approval_rules ────────────────────────────────────────────────────────────
type ApprovalRuleKeysOk = HasKeys<
  ApprovalRuleRow,
  ['id', 'entityId', 'agentId', 'toolName', 'action', 'conditionJson', 'createdAt', 'updatedAt']
>;
const _approvalRuleKeysOk: ApprovalRuleKeysOk = true;
void _approvalRuleKeysOk;

// ── agent_skills ──────────────────────────────────────────────────────────────
type AgentSkillKeysOk = HasKeys<
  AgentSkillRow,
  [
    'id',
    'entityId',
    'name',
    'slug',
    'content',
    'active',
    'description',
    'defaultContent',
    'contentOverridden',
    'requiredConfig',
    'operations',
    'requiredBuiltins',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentSkillKeysOk: AgentSkillKeysOk = true;
void _agentSkillKeysOk;

// ── agent_skill_assignments ───────────────────────────────────────────────────
type AgentSkillAssignmentKeysOk = HasKeys<
  AgentSkillAssignmentRow,
  [
    'id',
    'entityId',
    'agentId',
    'skillId',
    'approvalOverrides',
    'useCustomInstructions',
    'enabledOperations',
    'createdAt',
  ]
>;
const _agentSkillAssignmentKeysOk: AgentSkillAssignmentKeysOk = true;
void _agentSkillAssignmentKeysOk;

// ── agent_schedules ───────────────────────────────────────────────────────────
type AgentScheduleKeysOk = HasKeys<
  AgentScheduleRow,
  [
    'id',
    'entityId',
    'agentId',
    'type',
    'name',
    'cronExpr',
    'task',
    'objectives',
    'active',
    'lastRun',
    'nextRun',
    'lastStatus',
    'chatId',
    'createdAt',
    'updatedAt',
  ]
>;
const _agentScheduleKeysOk: AgentScheduleKeysOk = true;
void _agentScheduleKeysOk;

// ── entity_llm_keys ───────────────────────────────────────────────────────────
type EntityLlmKeyKeysOk = HasKeys<
  EntityLlmKeyRow,
  [
    'id',
    'entityId',
    'provider',
    'apiKey',
    'baseUrl',
    'nickname',
    'isActive',
    'createdAt',
    'updatedAt',
  ]
>;
const _entityLlmKeyKeysOk: EntityLlmKeyKeysOk = true;
void _entityLlmKeyKeysOk;

// ── webhook_triggers ──────────────────────────────────────────────────────────
type WebhookTriggerKeysOk = HasKeys<
  WebhookTriggerRow,
  [
    'id',
    'entityId',
    'agentId',
    'name',
    'slug',
    'taskTemplate',
    'active',
    'secret',
    'lastTriggeredAt',
    'triggerCount',
    'createdAt',
    'updatedAt',
  ]
>;
const _webhookTriggerKeysOk: WebhookTriggerKeysOk = true;
void _webhookTriggerKeysOk;

// ── channel_bindings (S2, migration 0064) ────────────────────────────────────
type ChannelBindingKeysOk = HasKeys<
  ChannelBindingRow,
  [
    'id',
    'entityId',
    'agentId',
    'channel',
    'credentials',
    'botIdentity',
    'cursor',
    'enabled',
    'createdAt',
    'updatedAt',
  ]
>;
const _channelBindingKeysOk: ChannelBindingKeysOk = true;
void _channelBindingKeysOk;

// ── channel_allowed_conversations (S2, migration 0064) ───────────────────────
type ChannelAllowedConversationKeysOk = HasKeys<
  ChannelAllowedConversationRow,
  [
    'id',
    'entityId',
    'agentId',
    'channel',
    'conversationId',
    'kind',
    'role',
    'status',
    'requesterName',
    'createdAt',
    'updatedAt',
  ]
>;
const _channelAllowedConversationKeysOk: ChannelAllowedConversationKeysOk = true;
void _channelAllowedConversationKeysOk;

// Runtime placeholder — vitest requires at least one test
describe('type alignment', () => {
  it('DB row types have all expected camelCase fields (compile-time verified, runtime is a placeholder)', () => {
    expect(true).toBe(true);
  });
});
