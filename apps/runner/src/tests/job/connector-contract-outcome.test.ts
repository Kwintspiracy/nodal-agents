// connector-contract-outcome.test.ts — a connector call's outcome, as the
// tool seam records it, under the connector contract (#1237) and the typed
// outcome (#1233) together.
//
// The contract layer ends a call the provider does not answer within its
// bound. A WRITE whose request left may have been carried out: the layer says
// so with `mayHaveDelivered`, which `executeTool` reads to write the call's
// outcome `unknown` (nothing is confirmed, nothing tells the model to call
// again). A READ that timed out did nothing: `failed`. Proved on the real
// registry's tools of two providers, through the real seam and its row.

import { describe, it, expect, beforeAll } from 'vitest';
import type { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, eq, toolCalls } from '@nodal-agents/db';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { executeTool } from '@nodal-agents/tools';
import type { ApprovalRule, ToolContext, ToolDefinition } from '@nodal-agents/tools';

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
});

/** A provider that answers reads with `{}` and never answers anything else. */
function writeHangs(): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as string, init);
    if (req.method === 'GET') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
  }) as typeof fetch;
}

/** A provider that never answers. */
const silent = (() => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

function toolOf(slug: string, op: string, fetchImpl: typeof fetch): AnyTool {
  const tool = ADAPTER_REGISTRY[slug]!.toolFactory('proof-token', {
    fetch: fetchImpl,
    boundMs: 200,
  }).find((t) => t.name === op);
  if (!tool) throw new Error(`no tool ${op}`);
  return tool as AnyTool;
}

async function run(tool: AnyTool, input: Record<string, unknown>) {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'contract' })
    .returning();
  const ctx = {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: job!.id,
    jobChatId: null,
    turn: 1,
  } as unknown as ToolContext;
  const rules = [
    {
      id: `rule-${tool.name}`,
      toolName: tool.name,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    } as ApprovalRule,
  ];
  const res = await executeTool(tool, input, ctx, {
    approvalRules: rules,
    onApprovalRequired: async () => {},
  });
  const [row] = await db.select().from(toolCalls).where(eq(toolCalls.jobId, job!.id));
  return { res, row: row! };
}

describe('a connector call cut at its bound: the row says what is known of it @cap:connecter-un-service/moteur', () => {
  it.each([
    ['google-drive', 'drive_create_folder', { name: 'Reports' }],
    ['notion', 'notion_create_page', { parent_page_id: 'p1', title: 'T' }],
  ] as const)(
    '%s/%s, a write whose request left: outcome unknown, and the model is told not to call again',
    async (slug, op, input) => {
      const { res, row } = await run(toolOf(slug, op, writeHangs()), { ...input });
      expect(res.outcome).toBe('error');
      expect(row.outcome).toBe('unknown');
      expect((res as { error: string }).error).toContain('OUTCOME UNKNOWN');
    },
  );

  it('a read that timed out did nothing: outcome failed', async () => {
    const { res, row } = await run(toolOf('google-drive', 'drive_get_file_info', silent), {
      file_id: 'f1',
    });
    expect(res.outcome).toBe('error');
    expect(row.outcome).toBe('failed');
  });
});
