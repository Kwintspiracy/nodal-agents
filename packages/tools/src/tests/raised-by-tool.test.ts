// raised-by-tool.test.ts — `raisedByTool` says the TOOL's own execute() threw,
// and nothing else.
//
// The runner frames an error carrying this flag as a third party's words
// (INJECT-001). A platform failure that happens AFTER a tool succeeded — the
// audit row, the constat of what it wrote, the epoch bump — is the product's
// own text: framing it as the tool's would tell the model a third party said
// it. Proven on the real seam with a real builtin that writes a file, and a
// database that fails the moment the tool has returned.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';
import type { z } from 'zod';

const registry = createToolRegistry();
registerBuiltins(registry);

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine = '';

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  racine = await mkdtemp(join(tmpdir(), 'nodal-raised-by-tool-'));
});

afterAll(async () => {
  await rm(racine, { recursive: true, force: true }).catch(() => {});
});

const opts = (toolName: string): ExecuteOptions => ({
  approvalRules: [
    {
      id: `rule-${toolName}`,
      toolName,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    } as ApprovalRule,
  ],
  onApprovalRequired: async () => {},
});

describe('raisedByTool marks an error the tool itself raised, never a platform failure after it @cap:connecter-un-service/moteur', () => {
  it('the tool succeeded, then the platform failed: the error is the product’s, not flagged', async () => {
    const ws = join(racine, 'ws');
    await mkdir(ws, { recursive: true });
    await writeFile(join(ws, 'package.json'), '{}');
    const [job] = await db
      .insert(agentJobs)
      .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'raised' })
      .returning();

    // The real file_write, untouched, except that it arms the failure once it
    // has returned: from then on every database call of the seam throws.
    const fileWrite = registry.get('file_write') as ToolDefinition<z.ZodTypeAny, unknown>;
    let armed = false;
    const tool: ToolDefinition<z.ZodTypeAny, unknown> = {
      ...fileWrite,
      execute: async (input, ctx) => {
        const out = await fileWrite.execute(input, ctx);
        armed = true;
        return out;
      },
    };
    const failing = new Proxy(db, {
      get(target, prop, receiver) {
        if (armed && (prop === 'select' || prop === 'insert' || prop === 'update')) {
          return () => {
            throw new Error('platform: database unavailable');
          };
        }
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const ctx = {
      db: failing,
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId: job!.id,
      jobChatId: null,
      workspaces: [{ label: 'shared', path: ws }],
      turn: 1,
    } as unknown as ToolContext;

    const res = await executeTool(
      tool,
      { path: 'note.txt', content: 'hello', purpose: 'Write the note.' },
      ctx,
      opts('file_write'),
    );

    expect(armed, 'the tool never ran: the test proves nothing').toBe(true);
    expect(res.outcome).toBe('error');
    if (res.outcome === 'error') expect(res.error).toContain('platform: database unavailable');
    expect(res).not.toHaveProperty('raisedByTool');
  });
});
