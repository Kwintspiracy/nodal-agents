// autonomy-rows.test.ts — every agent holds one autonomy row per tool it has (#917).
//
// Owner's decision, 2026-11-01: "as soon as an agent exists and a tool is
// available, the value of its autonomy must exist in the database, always".
// These cases read the rows back from the database, written by the one writer
// (`autonomy-rows.ts`), for the tools the whitelist's own code gives the agent.

import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull } from '@nodal-agents/db';
import {
  agents,
  agentConnectorAssignments,
  agentMcpServers,
  approvalRules,
  connectors,
  entities,
  mcpServers,
  users,
} from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { DEFAULT_ROOT_GRANTS, REPLACE_SHARED_FILE_SETTING } from '@nodal-agents/shared';
import type { AutonomyLevel } from '@nodal-agents/shared';
import {
  applyAutonomyLevelToAll,
  autonomyRowNames,
  syncAgentAutonomyRows,
  writeAutonomyRowsAtBoot,
} from '../autonomy-rows';
import { resolveAgentTools, WIDEST_PLACEMENT } from '../router/resolve-agent-tools';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

/** A workspace on `level`; `written` says whether its first write is done. */
async function workspace(level: AutonomyLevel, written: boolean): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniq('ar')}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({
      userId: user!.id,
      name: 'W',
      slug: uniq('w'),
      rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: level },
      // A workspace created after 0155 is born written; one from before is NULL.
      autonomyRowsWrittenAt: written ? new Date() : null,
    })
    .returning();
  return entity!.id;
}

async function anAgent(entityId: string): Promise<string> {
  const [a] = await db
    .insert(agents)
    .values({ entityId, name: 'A', slug: uniq('a'), personality: 'p', active: true })
    .returning();
  return a!.id;
}

async function attachMcp(
  entityId: string,
  agentId: string,
  slug: string,
  tools: Array<{ name: string; destructive?: boolean }>,
): Promise<string> {
  const [server] = await db
    .insert(mcpServers)
    .values({
      entityId,
      name: slug,
      slug,
      transport: 'http',
      url: 'https://mcp.example.test',
      availableTools: tools.map((t) => ({
        name: t.name,
        description: `does ${t.name}`,
        inputSchema: { type: 'object', properties: {} },
        ...(t.destructive ? { annotations: { destructiveHint: true } } : {}),
      })),
      active: true,
    })
    .returning();
  await db
    .insert(agentMcpServers)
    .values({ entityId, agentId, mcpServerId: server!.id, enabledTools: null });
  return server!.id;
}

/** The agent's rows valid everywhere, as `tool → action`. */
async function rowsOf(agentId: string): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.agentId, agentId), eq(approvalRules.conditionFolder, '')));
  return new Map(rows.map((r) => [r.toolName, r.action]));
}

describe('the writer: one row per agent and tool, in the database @cap:regler-autonomie/moteur', () => {
  it('a new agent gets a row for every tool it holds, and the shared-file setting', async () => {
    const e = await workspace('propose_confirm', true);
    const a = await anAgent(e);
    expect((await rowsOf(a)).size).toBe(0);

    const result = await syncAgentAutonomyRows(db, a);

    const held = await rowsOf(a);
    const expected = autonomyRowNames(await resolveAgentTools(db, a, WIDEST_PLACEMENT));
    expect([...held.keys()].sort()).toEqual([...expected].sort());
    expect(result.written.map((w) => w.toolName).sort()).toEqual([...expected].sort());
    // What the level gives each: an ordinary tool runs, the shared-file
    // setting asks under propose_confirm.
    expect(held.get('file_read')).toBe('auto_approve');
    expect(held.get('file_move')).toBe('auto_approve');
    expect(held.get(REPLACE_SHARED_FILE_SETTING)).toBe('require_approval');
    // A second sync writes nothing and changes nothing.
    expect((await syncAgentAutonomyRows(db, a)).written).toEqual([]);
  });

  it('attaching an MCP server writes a row per tool; a tool the server adds later inherits its setting', async () => {
    const e = await workspace('destructive_gate', true);
    const a = await anAgent(e);
    await syncAgentAutonomyRows(db, a);
    const serverId = await attachMcp(e, a, 'notes-srv', [
      { name: 'read_note' },
      { name: 'purge_notes', destructive: true },
    ]);

    await syncAgentAutonomyRows(db, a);
    let held = await rowsOf(a);
    // destructive_gate: an ordinary tool runs, a destructive one asks.
    expect(held.get('notes_srv__read_note')).toBe('auto_approve');
    expect(held.get('notes_srv__purge_notes')).toBe('require_approval');

    // The owner sets the server to Block; the server then adds a tool.
    await db.insert(approvalRules).values({
      entityId: e,
      agentId: a,
      toolName: 'notes_srv__*',
      action: 'block',
    });
    await db
      .update(mcpServers)
      .set({
        availableTools: ['read_note', 'purge_notes', 'share_note'].map((name) => ({
          name,
          description: name,
          inputSchema: { type: 'object', properties: {} },
        })),
      })
      .where(eq(mcpServers.id, serverId));
    await syncAgentAutonomyRows(db, a);
    held = await rowsOf(a);
    expect(held.get('notes_srv__share_note')).toBe('block');
    // The rows that existed are not touched by a later sync.
    expect(held.get('notes_srv__read_note')).toBe('auto_approve');
  });

  it('the workspace level changes no existing row: only rows written after the change follow it', async () => {
    const e = await workspace('propose_confirm', true);
    const a = await anAgent(e);
    await syncAgentAutonomyRows(db, a);
    const before = await rowsOf(a);
    await db
      .update(entities)
      .set({ rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'fully_autonomous' } })
      .where(eq(entities.id, e));
    await syncAgentAutonomyRows(db, a);
    expect(await rowsOf(a)).toEqual(before);
    expect(before.get(REPLACE_SHARED_FILE_SETTING)).toBe('require_approval');
  });
});

describe('the first write after the upgrade keeps what the screen showed (#917) @cap:regler-autonomie/moteur', () => {
  it('per tool: the screen value where the screen showed one, never wider than what the gate applied', async () => {
    const e = await workspace('destructive_gate', false);
    const a = await anAgent(e);
    await attachMcp(e, a, 'trusted-srv', [{ name: 'get' }]);
    await attachMcp(e, a, 'plain-srv', [{ name: 'get' }]);
    const [gmail] = await db
      .insert(connectors)
      .values({ entityId: e, slug: 'gmail', name: uniq('gmail'), active: true })
      .returning();
    await db.insert(agentConnectorAssignments).values({
      agentId: a,
      connectorId: gmail!.id,
      entityId: e,
      enabledOperations: null,
    });
    // What the owner had set before #917.
    await db.insert(approvalRules).values([
      // The agent trusted one server.
      { entityId: e, agentId: a, toolName: 'trusted_srv__*', action: 'auto_approve' },
      // A rule for every agent, naming one tool.
      { entityId: e, agentId: null, toolName: 'web_search', action: 'block' },
      // The agent's own row on one tool: it IS the row, kept.
      { entityId: e, agentId: a, toolName: 'file_read', action: 'require_approval' },
      // Approved for one folder only.
      {
        entityId: e,
        agentId: a,
        toolName: 'file_write',
        action: 'auto_approve',
        conditionJson: { workspacePath: 'D:/ws/dev' },
      },
    ]);

    const result = await syncAgentAutonomyRows(db, a);
    const held = await rowsOf(a);

    // An MCP tool showed its server's row, or Ask first without one — though
    // destructive_gate let it run. The screen wins: nothing moves, nothing widens.
    expect(held.get('trusted_srv__get')).toBe('auto_approve');
    expect(held.get('plain_srv__get')).toBe('require_approval');
    // A connector operation marked as asking showed Ask first.
    expect(held.get('gmail_send_email')).toBe('require_approval');
    // The rule for every agent applied at run time: the row says it now.
    expect(held.get('web_search')).toBe('block');
    // An existing row is the owner's.
    expect(held.get('file_read')).toBe('require_approval');
    // The folder row keeps its meaning; outside it, what applied (the tool runs).
    expect(held.get('file_write')).toBe('auto_approve');
    const folderRows = await db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.agentId, a), eq(approvalRules.toolName, 'file_write')));
    expect(folderRows.map((r) => `${r.action}@${r.conditionFolder}`).sort()).toEqual([
      'auto_approve@',
      'auto_approve@D:/ws/dev',
    ]);
    // file_write was ruled only in one folder: the four tools no longer agreed,
    // so the setting starts on Ask first, and the agent is reported.
    expect(held.get(REPLACE_SHARED_FILE_SETTING)).toBe('require_approval');
    expect(result.sharedFileDiffered).toBe(true);
  });

  it('the shared-file setting: what applied under the level when the four tools agreed', async () => {
    const full = await workspace('fully_autonomous', false);
    const a = await anAgent(full);
    await syncAgentAutonomyRows(db, a);
    expect((await rowsOf(a)).get(REPLACE_SHARED_FILE_SETTING)).toBe('auto_approve');

    const gated = await workspace('destructive_gate', false);
    const b = await anAgent(gated);
    const r = await syncAgentAutonomyRows(db, b);
    expect((await rowsOf(b)).get(REPLACE_SHARED_FILE_SETTING)).toBe('require_approval');
    expect(r.sharedFileDiffered).toBe(false);
  });

  it('at boot: every agent gets its rows, the workspace is marked done, and a later built-in follows the level', async () => {
    const e = await workspace('propose_confirm', false);
    const a = await anAgent(e);
    const lines: string[] = [];
    await writeAutonomyRowsAtBoot(db, (l) => lines.push(l));

    const held = await rowsOf(a);
    expect(held.size).toBeGreaterThan(0);
    const [ent] = await db.select().from(entities).where(eq(entities.id, e));
    expect(ent?.autonomyRowsWrittenAt).not.toBeNull();

    // A new version adds a built-in: simulated by a row this agent lacks.
    // The owner's choice on another row survives the next boot.
    await db
      .delete(approvalRules)
      .where(and(eq(approvalRules.agentId, a), eq(approvalRules.toolName, 'file_move')));
    await db
      .update(approvalRules)
      .set({ action: 'block' })
      .where(and(eq(approvalRules.agentId, a), eq(approvalRules.toolName, 'file_read')));
    await writeAutonomyRowsAtBoot(db, () => undefined);
    const after = await rowsOf(a);
    expect(after.get('file_move')).toBe('auto_approve');
    expect(after.get('file_read')).toBe('block');
  });
});

describe('"Apply to all agents" (#917) @cap:regler-autonomie/moteur', () => {
  it('rewrites every agent row from the level, removes the template rules, keeps folder rows', async () => {
    const e = await workspace('propose_confirm', true);
    const a = await anAgent(e);
    const b = await anAgent(e);
    await attachMcp(e, a, 'tpl-srv', [{ name: 'get' }]);
    await syncAgentAutonomyRows(db, a);
    await syncAgentAutonomyRows(db, b);
    await db
      .update(approvalRules)
      .set({ action: 'block' })
      .where(and(eq(approvalRules.agentId, b), eq(approvalRules.toolName, 'file_read')));
    await db.insert(approvalRules).values([
      { entityId: e, agentId: a, toolName: 'tpl_srv__*', action: 'block' },
      { entityId: e, agentId: null, toolName: 'web_search', action: 'block' },
      {
        entityId: e,
        agentId: a,
        toolName: 'file_write',
        action: 'block',
        conditionJson: { workspacePath: 'D:/keep' },
      },
    ]);
    await db
      .update(entities)
      .set({ rootGrants: { ...DEFAULT_ROOT_GRANTS, autonomy: 'fully_autonomous' } })
      .where(eq(entities.id, e));

    const { changed } = await applyAutonomyLevelToAll(db, e);
    expect(changed).toBeGreaterThan(0);

    const ofA = await rowsOf(a);
    const ofB = await rowsOf(b);
    expect(ofB.get('file_read')).toBe('auto_approve');
    expect(ofA.get('tpl_srv__get')).toBe('auto_approve');
    expect(ofA.get(REPLACE_SHARED_FILE_SETTING)).toBe('auto_approve');
    expect(ofA.has('tpl_srv__*')).toBe(false);
    const everyone = await db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.entityId, e), isNull(approvalRules.agentId)));
    expect(everyone).toEqual([]);
    const kept = await db
      .select()
      .from(approvalRules)
      .where(and(eq(approvalRules.agentId, a), eq(approvalRules.conditionFolder, 'D:/keep')));
    expect(kept.map((r) => r.action)).toEqual(['block']);
  });

  it('a rule for an unknown agent id is never written', async () => {
    await expect(syncAgentAutonomyRows(db, randomUUID())).rejects.toThrow(/not found/);
  });
});
