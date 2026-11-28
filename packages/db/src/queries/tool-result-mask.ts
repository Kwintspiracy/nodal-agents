// queries/tool-result-mask.ts — the registry of one workspace's secret values, and an agent's policy.
//
// `loadToolResultMaskPolicy` is what the tool-result seam reads for each call
// (`packages/tools/src/execute.ts`, and the CLI runtimes' recorded results):
// the exact values of every secret Nodal holds for the workspace, plus the
// install's own, and the agent's `mask_secret_shapes` setting, read from the
// database (the setting shown is the setting applied).
//
// It is read AFTER the tool ran, from the rows as they are then: a token a
// connector refreshed during the call is already the stored one, so it is
// registered the moment it exists.
//
// What it reads, all scoped to the workspace (never another's):
//   - `entity_llm_keys.api_key`            the provider keys;
//   - `connectors.api_key`                 the connector keys;
//   - `credentials.payload`                the OAuth tokens and client secret
//                                          of the workspace's connectors;
//   - `mcp_servers.api_key`, `.env_vars`   the MCP servers' keys and variables
//                                          (the workspace's own, and those its
//                                          agents are given);
//   - `channel_bindings.credentials`       every value of a channel's bag;
//   - `agents.telegram_bot_token`          the legacy bot token column;
//   - `webhook_triggers.secret`            the webhook secrets.
//
// A row that does not decrypt is not a value Nodal can hold in clear: it
// cannot reach any tool, so it cannot be in a result. It is skipped and said
// by a code, never with its content.
//
// Nothing here is logged, listed or returned except inside the registry,
// which only ever answers with a masked text.

import { and, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { decrypt, isEncrypted } from '@nodal-agents/secrets';
import {
  installSecretValues,
  registeredSecrets,
  type ToolResultMaskPolicy,
} from '@nodal-agents/shared';
import type { AnyDrizzleDb } from '../client.ts';
import { agents } from '../schema/agents.ts';
import { channelBindings } from '../schema/channel-bindings.ts';
import { connectors } from '../schema/connectors.ts';
import { credentials } from '../schema/credentials.ts';
import { entityLlmKeys } from '../schema/llm_keys.ts';
import { agentMcpServers, mcpServers } from '../schema/mcp.ts';
import { webhookTriggers } from '../schema/webhooks.ts';

/** A stored secret in clear: decrypted when it is an envelope, as stored otherwise. */
function clear(raw: string | null | undefined, what: string, skipped: string[]): string | null {
  if (raw === null || raw === undefined || raw === '') return null;
  if (!isEncrypted(raw)) return raw;
  try {
    return decrypt(raw);
  } catch {
    skipped.push(what);
    return null;
  }
}

/** Every string leaf of a JSON value (a credential bag, an OAuth payload). */
function stringLeaves(value: unknown, out: string[]): void {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) stringLeaves(v, out);
  else if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) stringLeaves(v, out);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A bag that is not JSON is one value.
    return text;
  }
}

/**
 * The exact values of every secret Nodal holds for workspace `entityId`.
 * Never logged; for the registry only.
 */
export async function loadWorkspaceSecretValues(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<string[]> {
  const values: string[] = [];
  const skipped: string[] = [];

  const llmKeys = await db
    .select({ id: entityLlmKeys.id, apiKey: entityLlmKeys.apiKey })
    .from(entityLlmKeys)
    .where(eq(entityLlmKeys.entityId, entityId));
  for (const r of llmKeys) {
    const v = clear(r.apiKey, `entity_llm_keys ${r.id}`, skipped);
    if (v) values.push(v);
  }

  const connectorRows = await db
    .select({
      id: connectors.id,
      apiKey: connectors.apiKey,
      credentialId: connectors.credentialId,
    })
    .from(connectors)
    .where(eq(connectors.entityId, entityId));
  for (const r of connectorRows) {
    const v = clear(r.apiKey, `connectors ${r.id}`, skipped);
    if (v) values.push(v);
  }
  const credentialIds = connectorRows
    .map((r) => r.credentialId)
    .filter((id): id is string => id !== null);
  if (credentialIds.length > 0) {
    const creds = await db
      .select({ id: credentials.id, payload: credentials.payload })
      .from(credentials)
      .where(inArray(credentials.id, credentialIds));
    for (const r of creds) {
      const json = clear(r.payload, `credentials ${r.id}`, skipped);
      if (json) stringLeaves(parseJson(json), values);
    }
  }

  const given = db
    .select({ id: agentMcpServers.mcpServerId })
    .from(agentMcpServers)
    .where(eq(agentMcpServers.entityId, entityId));
  const servers = await db
    .select({ id: mcpServers.id, apiKey: mcpServers.apiKey, envVars: mcpServers.envVars })
    .from(mcpServers)
    .where(or(eq(mcpServers.entityId, entityId), inArray(mcpServers.id, given)));
  for (const r of servers) {
    const v = clear(r.apiKey, `mcp_servers ${r.id}`, skipped);
    if (v) values.push(v);
    if (r.envVars !== null && typeof r.envVars === 'object' && !Array.isArray(r.envVars)) {
      for (const [k, raw] of Object.entries(r.envVars as Record<string, unknown>)) {
        if (typeof raw !== 'string') continue;
        const ev = clear(raw, `mcp_servers ${r.id} env ${k}`, skipped);
        if (ev) values.push(ev);
      }
    }
  }

  const bindings = await db
    .select({ id: channelBindings.id, credentials: channelBindings.credentials })
    .from(channelBindings)
    .where(eq(channelBindings.entityId, entityId));
  for (const r of bindings) {
    const json = clear(r.credentials, `channel_bindings ${r.id}`, skipped);
    if (json) stringLeaves(parseJson(json), values);
  }

  const bots = await db
    .select({ id: agents.id, token: agents.telegramBotToken })
    .from(agents)
    .where(and(eq(agents.entityId, entityId), isNotNull(agents.telegramBotToken)));
  for (const r of bots) {
    const v = clear(r.token, `agents ${r.id} telegram_bot_token`, skipped);
    if (v) values.push(v);
  }

  const hooks = await db
    .select({ id: webhookTriggers.id, secret: webhookTriggers.secret })
    .from(webhookTriggers)
    .where(and(eq(webhookTriggers.entityId, entityId), isNotNull(webhookTriggers.secret)));
  for (const r of hooks) {
    const v = clear(r.secret, `webhook_triggers ${r.id}`, skipped);
    if (v) values.push(v);
  }

  if (skipped.length > 0) {
    // The rows, never their content: what does not decrypt is not held in clear.
    console.warn(
      `[tool-result-mask] SECRET_ROW_UNDECRYPTABLE entity=${entityId} rows=${skipped.join(',')}`,
    );
  }
  return values;
}

/**
 * The policy of agent `agentId` for its tool results: the registry of ITS
 * workspace (the workspace's values and the install's) and its
 * `mask_secret_shapes`. The workspace is the agent's own: a job that names
 * none (`entityId: ''`, an internal caller) is scanned with its agent's, and a
 * job that names another is refused. Throws when the agent is not a row: a
 * result is never handed on without a policy (invariant #4).
 */
export async function loadToolResultMaskPolicy(
  db: AnyDrizzleDb,
  scope: { entityId: string; agentId: string },
): Promise<ToolResultMaskPolicy> {
  const [agent] = await db
    .select({ maskSecretShapes: agents.maskSecretShapes, entityId: agents.entityId })
    .from(agents)
    .where(eq(agents.id, scope.agentId))
    .limit(1);
  if (!agent) {
    throw new Error(
      `tool_result_mask_agent_missing: agent ${scope.agentId} is not an agent of this install, ` +
        'so its tool result has no masking policy and is not handed on.',
    );
  }
  const workspace = agent.entityId ?? scope.entityId;
  if (scope.entityId !== '' && workspace !== scope.entityId) {
    throw new Error(
      `tool_result_mask_agent_missing: agent ${scope.agentId} is not an agent of workspace ` +
        `${scope.entityId}, so its tool result has no masking policy and is not handed on.`,
    );
  }
  const values = workspace === '' ? [] : await loadWorkspaceSecretValues(db, workspace);
  return {
    registry: registeredSecrets([...installSecretValues(), ...values]),
    shapes: agent.maskSecretShapes,
  };
}
