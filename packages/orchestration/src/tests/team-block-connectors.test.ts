// team-block-connectors.test.ts — each Connectors entry of a roster line says
// what the teammate can DO with it (#611).
//
// Job 465446e7 (2026-09-29): asked to print a recipe, the root never delegated
// to the only teammate holding the printing MCP server — its roster line read
// "Connectors: …, hp-connector", a bare slug. The entry now carries the
// capability, from the data alone and in one form for every connector and MCP
// server: one name per operation or tool the teammate actually holds.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
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
    // One name per instance: the workspace may hold several of one connector.
    .values({ entityId: t.entityId, slug, name: uniq(slug), active: true })
    .returning();
  await db.insert(agentConnectorAssignments).values({
    agentId: t.childId,
    connectorId: conn!.id,
    entityId: t.entityId,
    enabledOperations,
  });
}

/** The adapter's own name for one of its operations. */
function opName(connector: string, op: string): string {
  const found = ADAPTER_REGISTRY[connector]!.operations.find((o) => o.slug === op);
  expect(found).toBeDefined();
  return found!.name;
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

  it('every tool held is named, however many: a print request 12th of its server is visible', async () => {
    const t = await seedTeam();
    // The server's own order, as the orchestrator read it: the print request
    // comes 12th. A "+N more" after 8 names hid it (review of #653, pass 2).
    const names = [
      'list_printers',
      'get_status',
      'get_capabilities',
      'get_queue',
      'preview_print_job',
      'cancel_job',
      'identify_printer',
      'scan_document',
      'get_print_preview',
      'get_print_request',
      'confirm_print',
      'request_print',
      'reject_print',
      'update_print',
      'change_print_options',
      'cancel_print_request',
      'read_web_page',
      'get_page_images',
      'search_images',
    ];
    expect(names.indexOf('request_print')).toBe(11);
    await attachMcp(t, 'hp-connector', names, null);

    const line = await connectorsLine(t.orchId);
    expect(line).toBe(`hp-connector (${names.join(', ')})`);
    expect(line).not.toContain('more');
  });

  it('a connector held in full names every operation by its adapter name: Send email, 21st of Gmail, is visible', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'gmail', null);

    const ops = ADAPTER_REGISTRY['gmail']!.operations;
    expect(ops.findIndex((o) => o.slug === 'gmail_send_email')).toBe(20);
    const line = await connectorsLine(t.orchId);
    expect(line).toBe(`gmail (${ops.map((o) => o.name).join(', ')})`);
    expect(line).toContain(opName('gmail', 'gmail_send_email'));
  });

  it('a connector held in part lists only the operations it holds', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'gmail', ['gmail_list_messages', 'gmail_get_message']);

    const line = await connectorsLine(t.orchId);
    expect(line).toBe(
      `gmail (${opName('gmail', 'gmail_list_messages')}, ${opName('gmail', 'gmail_get_message')})`,
    );
    expect(line.toLowerCase()).not.toContain('send');
  });

  it('two instances of one connector give the union of their operations, in the adapter order', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'gmail', ['gmail_send_email']);
    await attachConnector(t, 'gmail', ['gmail_list_messages']);

    expect(await connectorsLine(t.orchId)).toBe(
      `gmail (${opName('gmail', 'gmail_list_messages')}, ${opName('gmail', 'gmail_send_email')})`,
    );
  });

  it('a connector operation is never named by its tool id: the reader does not hold that tool (#559)', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'tavily', null);
    await attachConnector(t, 'cloudflare', null);

    const line = await connectorsLine(t.orchId);
    for (const slug of ['tavily', 'cloudflare']) {
      for (const op of ADAPTER_REGISTRY[slug]!.operations) {
        expect(line).not.toContain(op.slug);
      }
    }
  });

  it('several entries on one line, separated so a tool list never reads as another entry', async () => {
    const t = await seedTeam();
    await attachConnector(t, 'tavily', null);
    await attachMcp(t, 'hp-connector', ['list_printers', 'request_print'], null);

    const tavily = ADAPTER_REGISTRY['tavily']!.operations.map((o) => o.name);
    expect(await connectorsLine(t.orchId)).toBe(
      `tavily (${tavily.join(', ')}); hp-connector (list_printers, request_print)`,
    );
  });

  it('two instances of one server merge into one entry with the union of what they give', async () => {
    const t = await seedTeam();
    await attachMcp(t, 'cortex', ['get_feed', 'create_post'], ['get_feed']);
    await attachMcp(t, 'cortex', ['get_feed', 'create_post'], ['create_post']);

    expect(await connectorsLine(t.orchId)).toBe('cortex (get_feed, create_post)');
  });

  it('every name shown comes from the data: generated names, random subsets, nothing else on the line (invariant #1)', async () => {
    const t = await seedTeam();
    const rnd = () => `n_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const pick = <T>(xs: readonly T[]): T[] => xs.filter(() => Math.random() < 0.5);

    // Two MCP servers with generated slugs and tool names; each teammate holds
    // a random part of the second one.
    const slugA = `srv-${rnd()}`;
    const toolsA = Array.from({ length: 5 }, rnd);
    await attachMcp(t, slugA, toolsA, null);
    const slugB = `srv-${rnd()}`;
    const toolsB = Array.from({ length: 14 }, rnd);
    const enabledB = [...pick(toolsB), toolsB[0]!];
    await attachMcp(t, slugB, toolsB, enabledB);
    // A catalogue connector held in a random part: its names are its adapter's.
    const gmailOps = ADAPTER_REGISTRY['gmail']!.operations;
    const gmailHeld = [...pick(gmailOps.map((o) => o.slug)), 'gmail_send_email'];
    await attachConnector(t, 'gmail', gmailHeld);

    const expected = new Map<string, string[]>([
      ['gmail', gmailOps.filter((o) => gmailHeld.includes(o.slug)).map((o) => o.name)],
      [slugA, toolsA],
      [slugB, toolsB.filter((n) => enabledB.includes(n))],
    ]);

    const line = await connectorsLine(t.orchId);
    const parsed = new Map<string, string[]>();
    for (const entry of line.split('; ')) {
      const m = /^(\S+) \((.*)\)$/.exec(entry);
      expect(m, `entry "${entry}" is not "<slug> (<names>)"`).not.toBeNull();
      parsed.set(m![1]!, m![2]!.split(', '));
    }
    // Exactly the data, entry by entry: a label or a word written in code
    // would be a name that is in none of them.
    expect(parsed).toEqual(expected);
  });

  it('the roster code does not read the connector labels written in code (Codex review of #653, pass 1)', () => {
    const source = readFileSync(join(__dirname, '..', 'team-block.ts'), 'utf8').toLowerCase();
    for (const word of ['connector_capability', 'connectorcapability', 'agent-baseline']) {
      expect(source).not.toContain(word);
    }
  });
});
