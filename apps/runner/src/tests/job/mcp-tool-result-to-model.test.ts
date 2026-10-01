// mcp-tool-result-to-model.test.ts — what the model is sent after an MCP tool
// call: the text the server wrote for it, every block in order; what the row
// keeps: the whole result, structuredContent included.
//
// Measured 2026-10-01 (job ad38e1f3): a print server answered with a sentence
// ("Confirmation not possible … nothing was printed"), a preview picture and a
// structuredContent. The model received the structuredContent JSON alone, read
// `status: pending`, and asked again. Nothing here is specific to that server:
// the mechanism is proven on the SDK-built fixture
// (packages/adapters/mcp/src/tests/fixtures/mcp-result-server.mjs), on two
// servers at once — one answering text + image + structuredContent, one
// answering structuredContent alone — and on both runner paths where a
// success becomes a tool result: the call run inline, and the call run on
// resume after a human approved it.
//
// The REAL path: executeJob, a real test database, Nodal's real MCP client
// spawning real stdio servers, the real LLM client, and the provider request
// read at the fetch boundary — what the model is actually sent.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { _setMasterKeyForTests, encrypt } from '@nodal-agents/secrets';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agentMcpServers,
  approvalRequests,
  approvalRules,
  eq,
  mcpServers,
  toolCalls,
} from '@nodal-agents/db';
import type { JobId } from '@nodal-agents/orchestration';
import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';
import { executeJob } from '../../job/execute.ts';
import {
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
    '../../../../../packages/adapters/mcp/src/tests/fixtures/mcp-result-server.mjs',
    import.meta.url,
  ),
);
const MODEL = 'openai/gpt-5.6-sol';

/** What the `mixed` fixture server gives the model: its text blocks, the image said. */
const MIXED_FOR_MODEL =
  'Request pr-7 for 2 pages. Confirmation not possible: nobody answered in time, nothing was printed.\n' +
  '[Image returned by the tool (image/jpeg, 3 KB): not passed to you. ' +
  "Nodal does not give a tool's image to the model.]\n" +
  'Ask the user before calling request_print again.\n' +
  // …and the machine form: its id is what the next call needs.
  '{"id":"pr-7","status":"pending","preview":{"pages":2}}';
const MIXED_STRUCTURED = { id: 'pr-7', status: 'pending', preview: { pages: 2 } };
const RECORDS = { records: [{ id: 'rec1', fields: { Name: 'Alpha' } }] };

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/** A stdio server row running the fixture, answering with `shape`. */
async function seedServer(entityId: string, agentId: string, slug: string, shape: string) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      entityId,
      name: slug,
      slug,
      transport: 'stdio',
      command: process.execPath,
      args: [FIXTURE],
      envVars: { FIXTURE_RESULT: encrypt(shape) },
      active: true,
    })
    .returning({ id: mcpServers.id });
  if (!row) throw new Error('failed to seed the MCP server');
  await db
    .insert(agentMcpServers)
    .values({ entityId, agentId, mcpServerId: row.id, enabledTools: null });
}

async function run(jobId: string, script: ScriptedReply[]) {
  const bodies = scriptProvider(script);
  const result = await executeJob(jobId as JobId, makeDeps(db), testEnv);
  vi.unstubAllGlobals();
  return { bodies, result };
}

/** The output the tool_calls row of a call that RAN keeps (stored serialized). */
async function recordedOutput(jobId: string, toolName: string): Promise<unknown> {
  const rows = await db
    .select({ toolName: toolCalls.toolName, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, jobId));
  const outputs = rows
    .filter((r) => r.toolName === toolName && typeof r.toolOutput === 'string')
    .map((r) => JSON.parse(r.toolOutput as string) as Record<string, unknown>)
    // The gate's own row (`awaiting_approval`) is not the call's result.
    .filter((o) => !('outcome' in o));
  if (outputs.length !== 1) {
    throw new Error(`expected one result row for ${toolName}, got ${JSON.stringify(outputs)}`);
  }
  return outputs[0];
}

describe('an MCP tool result reaches the model as the server wrote it @cap:connecter-un-service/moteur', () => {
  it('inline: text blocks in order with the image said for one server, structuredContent for the other; the rows keep everything', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
    await seedServer(entityId, agentId, 'printer-like', 'mixed');
    await seedServer(entityId, agentId, 'records', 'structured');
    for (const toolName of ['printer_like__report', 'records__report']) {
      await db
        .insert(approvalRules)
        .values({ entityId, agentId: null, toolName, action: 'auto_approve' });
    }

    const { bodies } = await run(jobId, [
      {
        calls: [
          { name: 'printer_like__report', args: { purpose: 'Print the page.' } },
          { name: 'records__report', args: { purpose: 'Read the records.' } },
        ],
      },
      { text: 'Done.' },
    ]);

    // The request that follows the calls: what the model reads of each result.
    const next = bodies[1];
    expect(next, 'the model was never called after the tools ran').toBeDefined();
    const [printer, records] = toolResults(next!);
    expect(printer).toContain(MIXED_FOR_MODEL);
    // Framed as third-party data, like every MCP result (INJECT-001).
    expect(printer).toContain('<untrusted_tool_result>');
    // A server that wrote no text block: the model reads its structuredContent.
    expect(records).toContain(JSON.stringify(RECORDS));

    // The rows keep the whole result: every block, and structuredContent.
    expect(await recordedOutput(jobId, 'printer_like__report')).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [
        {
          type: 'text',
          text: 'Request pr-7 for 2 pages. Confirmation not possible: nobody answered in time, nothing was printed.',
        },
        { type: 'image', mimeType: 'image/jpeg', bytes: 3072 },
        { type: 'text', text: 'Ask the user before calling request_print again.' },
      ],
      structuredContent: MIXED_STRUCTURED,
    });
    expect(await recordedOutput(jobId, 'records__report')).toEqual({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      structuredContent: RECORDS,
    });
  }, 60_000);

  it('on resume after approval: the approved call gives the model the same text', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
    await seedServer(entityId, agentId, 'printer-gated', 'mixed');

    // No rule: the MCP tool asks for approval (its default), the job suspends.
    const first = await run(jobId, [
      { calls: [{ name: 'printer_gated__report', args: { purpose: 'Print the page.' } }] },
    ]);
    expect(first.result.status).toBe('awaiting_approval');
    const [request] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId));
    if (!request) throw new Error('no approval request was written');

    // A human approves; the job is re-queued (what the approve route does).
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, request.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId));

    const resumed = await run(jobId, [{ text: 'Done.' }]);

    const results = toolResults(resumed.bodies[0]!);
    const printer = results.find((r) => r.includes('Request pr-7'));
    expect(printer, `no result of the approved call in ${JSON.stringify(results)}`).toBeDefined();
    expect(printer).toContain(MIXED_FOR_MODEL);
    expect(await recordedOutput(jobId, 'printer_gated__report')).toMatchObject({
      structuredContent: MIXED_STRUCTURED,
    });
  }, 60_000);
});

describe('a third-party tool error is framed like its success; the gate own errors are not @cap:connecter-un-service/moteur', () => {
  const FRAME = '<untrusted_tool_result>';
  const SERVER_ERROR = 'Printer offline: the request was not queued.';

  it('inline: the server isError text reaches the model framed; an invalid call refused by the gate stays bare', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
    await seedServer(entityId, agentId, 'failing', 'error');
    await db
      .insert(approvalRules)
      .values({ entityId, agentId: null, toolName: 'failing__report', action: 'auto_approve' });

    const { bodies } = await run(jobId, [
      {
        calls: [
          { name: 'failing__report', args: { purpose: 'Print the page.' } },
          // Finishing in the same turn as the failure, and nothing else
          // failing: the framed failure alone must still be SEEN as one by the
          // turn's own guard, which defers this.
          { name: 'return_result', args: { status: 'success' } },
        ],
      },
      // No `purpose`: refused by the gate's input validation, never run.
      { calls: [{ name: 'failing__report', args: {} }] },
      { text: 'Done.' },
    ]);

    expect(bodies[1], 'the turn finished over a failed call').toBeDefined();
    const [raised, finish] = toolResults(bodies[1]!);
    expect(raised).toContain(FRAME);
    expect(raised).toContain(SERVER_ERROR);
    expect(raised).toContain('[Source: failing__report.');
    expect(finish).toContain('deferred: sibling tool error must be addressed first');

    expect(bodies[2], 'the second turn never reached the model').toBeDefined();
    const refused = toolResults(bodies[2]!).at(-1);
    expect(refused).toContain('invalid_input');
    expect(refused).not.toContain(FRAME);
  }, 60_000);

  it('on resume after approval: the approved call that fails reaches the model framed', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: MODEL, role: 'agent' });
    await seedServer(entityId, agentId, 'failing-gated', 'error');

    const first = await run(jobId, [
      { calls: [{ name: 'failing_gated__report', args: { purpose: 'Print the page.' } }] },
    ]);
    expect(first.result.status).toBe('awaiting_approval');
    const [request] = await db
      .select({ id: approvalRequests.id })
      .from(approvalRequests)
      .where(eq(approvalRequests.jobId, jobId));
    if (!request) throw new Error('no approval request was written');
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.id, request.id));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId));

    const resumed = await run(jobId, [{ text: 'Done.' }]);

    const results = toolResults(resumed.bodies[0]!);
    const failed = results.find((r) => r.includes(SERVER_ERROR));
    expect(failed, `no result of the approved call in ${JSON.stringify(results)}`).toBeDefined();
    expect(failed).toContain(FRAME);
  }, 60_000);
});
