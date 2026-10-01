// mcp-tool-namespaces.test.ts — inside a job, one tool name designates ONE
// MCP server (#661).
//
// A server lends its tools as `<prefix>__<tool>`, the prefix derived from its
// slug. Measured before this fix, on this same harness:
//   - two instances of one server (same slug) attached to one agent: the call
//     ran on the LAST one attached, silently;
//   - `guide-srv` + `guide--srv` (the slug folds onto the same prefix): the
//     call ran on the first, the card was ambiguous;
//   - `a` + `a-` (`a_`, so `a___ping` also starts with `a__`): the card named
//     `a` without saying it might be wrong.
// Each is now refused, loud, naming both servers, before any server runs.
//
// What must keep working: a non-canonical server ON ITS OWN (it overlaps
// nothing), and several instances of one server in a workspace, each given
// to a different agent — each agent's call reaches its own instance, and the
// approval context names that instance.
//
// The REAL path: executeJob, a real test database, Nodal's real MCP client
// spawning real stdio servers (the SDK-built fixture), the provider request
// read at the fetch boundary.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agentMcpServers,
  agents,
  approvalRules,
  getMcpApprovalContext,
  mcpServers,
} from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import { buildApprovalCardBody } from '../../approvals/notify.ts';
import {
  jobRow,
  makeDeps,
  scriptProvider,
  seedJob,
  testEnv,
  toolResults,
  type ScriptedReply,
} from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609): routed back
// to the global fetch the harness stubs (vi.mock is hoisted per test file).
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const FIXTURE = fileURLToPath(
  new URL(
    '../../../../../packages/adapters/mcp/src/tests/fixtures/mcp-stdio-server.mjs',
    import.meta.url,
  ),
);
const MODEL = 'openai/gpt-5.6-sol';

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * A stdio server row running the fixture; `reply` is what its `ping` answers.
 * Inserted directly: these rows stand for data written before the rule.
 */
async function server(entityId: string, slug: string, name: string, reply: string) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      entityId,
      name,
      slug,
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envVars: { FIXTURE_MCP_REPLY: encrypt(reply) },
      active: true,
    })
    .returning({ id: mcpServers.id });
  if (!row) throw new Error('failed to seed the MCP server');
  return row.id;
}

async function attach(
  entityId: string,
  agentId: string,
  mcpServerId: string,
  enabledTools: string[] | null = null,
) {
  await db.insert(agentMcpServers).values({ entityId, agentId, mcpServerId, enabledTools });
}

async function autoApprove(entityId: string, toolName: string) {
  await db
    .insert(approvalRules)
    .values({ entityId, agentId: null, toolName, action: 'auto_approve' });
}

const call = (name: string): ScriptedReply[] => [
  { calls: [{ name, args: { purpose: 'Check the server.' } }] },
  { text: 'Done.' },
];

async function run(jobId: string, script: ScriptedReply[]) {
  const bodies = scriptProvider(script);
  await executeJob(jobId as JobId, makeDeps(db), testEnv);
  vi.unstubAllGlobals();
  return { bodies, row: await jobRow(db, jobId) };
}

async function secondAgent(entityId: string, keyId: string, slug: string) {
  const [agent] = await db
    .insert(agents)
    .values({
      entityId,
      name: slug,
      slug,
      personality: 'You are a test agent.',
      role: 'agent',
      llmKeyId: keyId,
      model: MODEL,
    })
    .returning({ id: agents.id });
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId,
      agentId: agent!.id,
      channel: 'api',
      task: 'Ping the server.',
      status: 'pending',
      messages: [],
      chainCount: 0,
    })
    .returning({ id: agentJobs.id });
  return { agentId: agent!.id, jobId: job!.id };
}

describe('one tool name, one MCP server, inside a job @cap:connecter-un-service/moteur', () => {
  // Each case: the servers the agent holds (slug, name, reply, enabledTools),
  // the tool the model calls. Every pair overlaps; none may run.
  const refused: Array<{
    label: string;
    servers: Array<[string, string, string, string[] | null]>;
    tool: string;
  }> = [
    {
      label: 'two instances of one server (same slug)',
      servers: [
        ['guide-srv', 'Guide one', 'A', null],
        ['guide-srv', 'Guide two', 'B', null],
      ],
      tool: 'guide_srv__ping',
    },
    {
      label: 'slugs folding onto one prefix (guide-srv / guide--srv)',
      servers: [
        ['guide-srv', 'Guide', 'A', null],
        ['guide--srv', 'Guide bis', 'B', []],
      ],
      tool: 'guide_srv__ping',
    },
    {
      label: 'one namespace extending the other (a / a-)',
      servers: [
        ['a', 'Server a', 'A', []],
        ['a-', 'Server a-dash', 'B', null],
      ],
      tool: 'a___ping',
    },
  ];

  for (const c of refused) {
    it(`refuses the job, naming both servers: ${c.label}`, async () => {
      const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
      for (const [slug, name, reply, enabled] of c.servers) {
        await attach(entityId, agentId, await server(entityId, slug, name, reply), enabled);
      }
      await autoApprove(entityId, c.tool);

      const { bodies, row } = await run(jobId, call(c.tool));

      expect(row.status).toBe('failed');
      const error = String(row.error ?? '');
      for (const [slug, name] of c.servers) expect(error).toContain(`"${name}" (${slug})`);
      expect(error).toContain('detach one');
      // Refused before the model was asked anything: no server answered.
      expect(bodies).toHaveLength(0);
    }, 60_000);
  }

  it('a non-canonical server on its own overlaps nothing: its call runs, its approval names it', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
    await attach(entityId, agentId, await server(entityId, 'a-', 'Server a-dash', 'B'));
    // Another server of the workspace, NOT held by this agent: no overlap counts.
    await server(entityId, 'a', 'Server a', 'A');
    await autoApprove(entityId, 'a___ping');

    const { bodies, row } = await run(jobId, call('a___ping'));

    expect(row.status).toBe('completed');
    expect(toolResults(bodies[1]!).join('\n')).toContain('B');
    const ctx = await getMcpApprovalContext(db as never, entityId, agentId, 'a___ping');
    expect(ctx).toMatchObject({ slug: 'a-', name: 'Server a-dash', ambiguous: false });
    expect(ctx?.rulePattern).toBe('a___*');
  }, 60_000);

  it('two instances of one server, each given to a different agent: each call reaches its own', async () => {
    const first = await seedJob(db, { model: MODEL, role: 'agent' });
    const { entityId } = first;
    const perso = await server(entityId, 'cogni-cortex', 'Cortex perso', 'PERSO');
    const boulot = await server(entityId, 'cogni-cortex', 'Cortex boulot', 'BOULOT');
    await attach(entityId, first.agentId, perso);
    const second = await secondAgent(entityId, first.keyId, 'second-agent');
    await attach(entityId, second.agentId, boulot);
    await autoApprove(entityId, 'cogni_cortex__ping');

    const a = await run(first.jobId, call('cogni_cortex__ping'));
    const b = await run(second.jobId, call('cogni_cortex__ping'));

    expect(a.row.status).toBe('completed');
    expect(b.row.status).toBe('completed');
    expect(toolResults(a.bodies[1]!).join('\n')).toContain('PERSO');
    expect(toolResults(b.bodies[1]!).join('\n')).toContain('BOULOT');

    // The approval context reads the requesting agent's own attachment.
    const ctxA = await getMcpApprovalContext(
      db as never,
      entityId,
      first.agentId,
      'cogni_cortex__ping',
    );
    const ctxB = await getMcpApprovalContext(
      db as never,
      entityId,
      second.agentId,
      'cogni_cortex__ping',
    );
    expect(ctxA).toMatchObject({ name: 'Cortex perso', ambiguous: false });
    expect(ctxB).toMatchObject({ name: 'Cortex boulot', ambiguous: false });

    // The channel card, built from the request's agent, says the same.
    const card = (agentId: string) =>
      buildApprovalCardBody(db as never, {
        entityId,
        agentId,
        toolName: 'cogni_cortex__ping',
        toolInput: { purpose: 'Check the server.' },
        who: 'An agent',
      });
    const cardA = await card(first.agentId);
    const cardB = await card(second.agentId);
    expect(cardA).toContain('Cortex perso');
    expect(cardA).not.toContain('Cortex boulot');
    expect(cardB).toContain('Cortex boulot');
    expect(cardB).not.toContain('Cortex perso');
  }, 90_000);
});
