// team-tools.test.ts — ce que l'équipe de l'espace sait faire, lu comme le produit le lit.
//
// Le 12/10, le garde « aucun connecteur ne sait envoyer un e-mail » a laissé
// partir sept e-mails depuis le Gmail du propriétaire (#711) : il ne lisait que
// `mcp_servers.available_tools`, alors que Gmail est un connecteur ADAPTATEUR
// (`connectors` + `agent_connector_assignments`), invisible à cette lecture.
// Le banc lit désormais les outils de chaque agent actif par la règle du
// produit (`computeAgentToolNames`, @nodal-agents/orchestration) : connecteurs
// adaptateurs, serveurs MCP, avec leurs listes blanches.
//
// Joué sur PGlite avec le schéma des tests de @nodal-agents/db.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { seedMinimal, spinUpTestDb } from '@nodal-agents/db/test-utils';
import { readTeamTools } from '../stack';

let pg: Awaited<ReturnType<typeof spinUpTestDb>>['pg'];
let db: AnyDrizzleDb;
let entityId: string;
let agentId: string;

beforeAll(async () => {
  const t = await spinUpTestDb();
  pg = t.pg;
  db = t.db as unknown as AnyDrizzleDb;
  const seed = await seedMinimal(t.db);
  entityId = seed.entityId;
  agentId = seed.agentId;
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(
    'delete from agent_connector_assignments; delete from connectors; delete from agent_mcp_servers; delete from mcp_servers;',
  );
  await pg.query(`update agents set active = true`);
});

async function connector(slug: string, opts: { agent?: string; ops?: string[] | null } = {}) {
  const c = await pg.query<{ id: string }>(
    `insert into connectors (entity_id, name, slug) values ($1, $2, $3) returning id::text`,
    [entityId, `${slug} test`, slug],
  );
  await pg.query(
    `insert into agent_connector_assignments (agent_id, connector_id, entity_id, enabled_operations)
     values ($1, $2, $3, $4)`,
    [opts.agent ?? agentId, c.rows[0]!.id, entityId, opts.ops ?? null],
  );
}

async function mcpServer(slug: string, tools: string[], opts: { assigned?: boolean } = {}) {
  const s = await pg.query<{ id: string }>(
    `insert into mcp_servers (entity_id, name, slug, transport, command, available_tools)
     values ($1, $2, $3, 'stdio', 'x', $4::jsonb) returning id::text`,
    [entityId, slug, slug, JSON.stringify(tools.map((name) => ({ name })))],
  );
  if (opts.assigned !== false) {
    await pg.query(
      `insert into agent_mcp_servers (entity_id, agent_id, mcp_server_id) values ($1, $2, $3)`,
      [entityId, agentId, s.rows[0]!.id],
    );
  }
}

describe('readTeamTools: what the agents of the workspace can call', () => {
  it('an ADAPTER connector assigned to an agent is seen (the Gmail of #711)', async () => {
    await connector('gmail');
    const tools = await readTeamTools(db, entityId);
    expect(tools).toContain('gmail_send_email');
    expect(tools).toContain('gmail_reply_message');
  });

  it("the agent's operation whitelist is applied: a read-only Gmail cannot send", async () => {
    await connector('gmail', { ops: ['gmail_list_messages', 'gmail_get_message'] });
    const tools = await readTeamTools(db, entityId);
    expect(tools).toContain('gmail_list_messages');
    expect(tools).not.toContain('gmail_send_email');
  });

  it('an MCP server assigned to an agent is seen under the name the product gives its tools', async () => {
    await mcpServer('office-printer', ['request_print', 'get_print_request']);
    const tools = await readTeamTools(db, entityId);
    expect(tools).toContain('office_printer__request_print');
  });

  it('an MCP server that no agent has is not a tool of the team', async () => {
    await mcpServer('lonely', ['request_print'], { assigned: false });
    const tools = await readTeamTools(db, entityId);
    expect(tools.some((t) => t.endsWith('request_print'))).toBe(false);
  });

  it('the connector of an inactive agent is not a tool of the team', async () => {
    await connector('outlook-mail');
    await pg.query(`update agents set active = false where id = $1`, [agentId]);
    const tools = await readTeamTools(db, entityId);
    expect(tools).not.toContain('outlook_send_email');
  });
});
