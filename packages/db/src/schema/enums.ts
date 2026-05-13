// DB-level enum helpers — these are NOT pgEnum() because the legacy schema
// uses TEXT + CHECK constraints (not ENUM types). We expose them as typed
// string literals that match @nodal-agents/shared enums exactly.
//
// For columns that use these values we rely on Drizzle's .check() and
// $type<>() pattern — see individual table files.

export {
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
} from '@nodal-agents/shared';
