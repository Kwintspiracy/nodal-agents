// team-block-connectors.test.ts — each Connectors entry of a roster line says
// what the teammate can DO with it (#611).
//
// Job 465446e7 (2026-09-29): asked to print a recipe, the root never delegated
// to the only teammate holding the printing MCP server — its roster line read
// "Connectors: …, hp-connector", a bare slug. The entry now carries the
// capability, from the data alone: the catalogue label of a connector held in
// full, otherwise the names of the tools the teammate actually holds.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentAssignments,
  agentConnectorAssignments,
  agentMcpServers,
  connectors,
  entities,
  mcpServers,
  users,
} from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { buildTeamBlock } from '../team-block';
import type { AgentId } from '../types';
import type { TestDb } from '@nodal-agents/db/test-utils';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

let seq = 0;
const uniq = (p: string) => `${p}-${Date.now()}-${++seq}`;

async function seedTeam(): Promise<{ entityId: string; orchId: string; childId: string }> {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniq('tbc')}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: uniq('e-tbc') })
    .returning();
  const [orch] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Root',
      slug: uniq('root'),
      personality: 'p',
      role: 'orchestrator',
      active: true,
    })
    .returning();
  const [child] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Mate',
      slug: uniq('mate'),
      personality: 'p',
      role: 'agent',
      active: true,
    })
    .returning();
  await db.insert(agentAssignments).values({
    orchestratorId: orch!.id,
    subAgentId: child!.id,
    entityId: entity!.id,
  });
  return { entityId: entity!.id, orchId: orch!.id, childId: child!.id };
}

async function attachMcp(
  t: { entityId: string; childId: string },
  slug: string,
  toolNames: string[],
  enabledTools: string[] | null,
): Promise<void> {
  const [server] = await db
    .insert(mcpServers)
    .values({
      entityId: t.entityId,
      name: slug,
      slug,
      transport: 'http',
      url: 'https://mcp.example.test',
      availableTools: toolNames.map((name) => ({ name, description: `does ${name}` })),
      active: true,
    })
    .returning();
  await db.insert(agentMcpServers).values({
    entityId: t.entityId,
    agentId: t.childId,
    mcpServerId: server!.id,
    enabledTools,
  });
}

async function attachConnector(
  t: { entityId: string; childId: string },
  slug: string,
  enabledOperations: string[] | null,
): Promise<void> {
  const [conn] = await db
    .insert(connectors)
    .values({ entityId: t.entityId, slug, name: slug, active: true })
    .returning();
  await db.insert(agentConnectorAssignments).values({
    agentId: t.childId,
    connectorId: conn!.id,
    entityId: t.entityId,
    enabledOperations,
  });
}

/** The single Connectors line of a one-teammate roster, without its label. */
async function connectorsLine(orchId: string): Promise<string> {
  const block = await buildTeamBlock(orchId as AgentId, db);
  const lines = block.split('\n').filter((l) => l.trimStart().startsWith('Connectors:'));
  expect(lines).toHaveLength(1);
  return lines[0]!.trimStart().slice('Connectors: '.length);
}

describe('buildTeamBlock — a Connectors entry says what the teammate can do (#611) @cap:organiser-equipe/moteur', () => {
  it('an MCP server is followed by the tools the teammate holds, so a printing server reads as one', async () => {
    const t = await seedTeam();
    await attachMcp(
      t,
      'hp-connector',
      ['list_printers', 'request_print', 'preview_print_job'],
      null,
    );

    expect(await connectorsLine(t.orchId)).toBe(
      'hp-connector (list_printers, request_print, preview_print_job)',
    );
  });

  it('a restricted enabled_tools shows only the tools the teammate holds: enabled ∩ available', async () => {
    const t = await seedTeam();
    // `ghost_tool` is enabled but the server no longer offers it: the teammate
    // cannot call it, so it is not announced either.
    await attachMcp(
      t,
      'files-srv',
      ['read_file', 'write_file', 'delete_file', 'list_dir'],
      ['read_file', 'list_dir', 'ghost_tool'],
    );

    const line = await connectorsLine(t.orchId);
    expect(line).toBe('files-srv (read_file, list_dir)');
    expect(line).not.toContain('write_file');
    expect(line).not.toContain('delete_file');
    expect(line).not.toContain('ghost_tool');
  });

  it('names at most 8 tools, then says how many more the server holds', async () => {
    const t = await seedTeam();
    const names = Array.from({ length: 12 }, (_, i) => `op_${String(i + 1).padStart(2, '0')}`);
    await attachMcp(t, 'big-srv', names, null);

    expect(await connectorsLine(t.orchId)).toBe(
      'big-srv (op_01, op_02, op_03, op_04, op_05, op_06, op_07, op_08, +4 more)',
    );
  });

  it('exactly 8 tools are all named, with no "+N"', async () => {
    const t = await seedTeam();
    const names = Array.from({ length: 8 }, (_, i) => `t${i + 1}`);
    await attachMcp(t, 'eight', names, null);

    expect(await connectorsLine(t.orchId)).toBe('eight (t1, t2, t3, t4, t5, t6, t7, t8)');
  });

  it('a catalogue connector held in full reads as its capability label', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'tavily', null);

    expect(await connectorsLine(t.orchId)).toBe('tavily (Web search & page extraction)');
  });

  it('a connector held in part lists its held operations: the label speaks for the whole connector', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'gmail', ['gmail_list_messages', 'gmail_get_message']);

    const line = await connectorsLine(t.orchId);
    expect(line).toBe('gmail (gmail_list_messages, gmail_get_message)');
    // "Read and send email" would promise a send this teammate cannot do.
    expect(line).not.toContain('send');
  });

  it('a connector with no catalogue label lists its operations, like an MCP server', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'cloudflare', null);

    const ops = ADAPTER_REGISTRY['cloudflare']!.operations.map((o) => o.slug);
    expect(ops.length).toBeGreaterThan(0);
    expect(await connectorsLine(t.orchId)).toBe(`cloudflare (${ops.join(', ')})`);
  });

  it('several entries on one line, separated so a tool list never reads as another entry', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'tavily', null);
    await attachMcp(t, 'hp-connector', ['list_printers', 'request_print'], null);

    expect(await connectorsLine(t.orchId)).toBe(
      'tavily (Web search & page extraction); hp-connector (list_printers, request_print)',
    );
  });

  it('two instances of one server merge into one entry with the union of what they give', async () => {
    const t = await seedTeam();
    await attachMcp(t, 'cortex', ['get_feed', 'create_post'], ['get_feed']);
    await attachMcp(t, 'cortex', ['get_feed', 'create_post'], ['create_post']);

    expect(await connectorsLine(t.orchId)).toBe('cortex (get_feed, create_post)');
  });

  it('the capability comes from the data: arbitrary tool names come out exactly as stored', async () => {
    const t = await seedTeam();
    const names = [uniq('zq_alpha'), uniq('zq_beta'), uniq('zq_gamma')];
    await attachMcp(t, 'opaque-srv', names, null);

    expect(await connectorsLine(t.orchId)).toBe(`opaque-srv (${names.join(', ')})`);
  });

  it('the roster code carries no text of its own about any MCP server (invariant #1)', () => {
    const source = readFileSync(join(__dirname, '..', 'team-block.ts'), 'utf8');
    // The server and tools of the incident, and of the other servers of the
    // team the ticket was measured on: none may be spelled in the roster code.
    for (const word of [
      'hp-connector',
      'hp_connector',
      'request_print',
      'list_printers',
      'playwright',
      'browser_',
      'cogni',
    ]) {
      expect(source.toLowerCase()).not.toContain(word);
    }
  });
});
