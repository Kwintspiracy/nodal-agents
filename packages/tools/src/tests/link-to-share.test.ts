// link-to-share.test.ts — a link in a workspace whose target is a network
// share (#614, revue de la PR #618, passe 4).
//
// Windows hands a link's target back with the `\\?\` prefix, and a share
// comes back as `\\?\UNC\server\share\…`. Dropping the prefix left
// `UNC\server\share\…`, read as a RELATIVE path under the link's folder: a
// write through the link was judged inside the workspace. It must be refused
// like any UNC path, before anything touches the share.
//
// Neither Windows nor Node lets a test create a junction to a share (EINVAL),
// so the link is faked at the one place the resolver reads it: `lstat` says
// "link", `readlink` gives the share. Everything else is the real resolver,
// the real `file_write` and the real gate against a real database.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { basename, join } from 'node:path';
import { z } from 'zod';

const FAKE_LINK = 'link-to-share';
const SHARE_TARGET = '\\\\?\\UNC\\fileserver\\public\\drop';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const isFake = (p: unknown) => typeof p === 'string' && basename(p) === FAKE_LINK;
  return {
    ...actual,
    lstat: (async (p: string, ...rest: unknown[]) =>
      isFake(p)
        ? { isSymbolicLink: () => true }
        : (actual.lstat as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.lstat,
    readlink: (async (p: string, ...rest: unknown[]) =>
      isFake(p)
        ? SHARE_TARGET
        : (actual.readlink as (...a: unknown[]) => unknown)(p, ...rest)) as typeof actual.readlink,
  };
});

const { mkdtemp, realpath, rm } = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { eq, approvalRequests } = await import('@nodal-agents/db');
const { spinUpTestDb, seedMinimal } = await import('@nodal-agents/db/test-utils');
const { DEFAULT_SHELL_POLICY } = await import('@nodal-agents/shared');
const { executeTool } = await import('../execute');
const { resolveAndCheckPath } = await import('../builtin/file-ops/workspace');
const { fileWriteTool } = await import('../builtin/file-ops/file-write');
type ToolContext = import('../types').ToolContext;
type ToolDefinition<I extends z.ZodTypeAny, O> = import('../types').ToolDefinition<I, O>;
type TestDb = import('@nodal-agents/db/test-utils').TestDb;

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let workspace: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  workspace = await realpath(await mkdtemp(join(tmpdir(), 'nodal-share-ws-')));
});

afterAll(async () => {
  await rm(workspace, { recursive: true, force: true });
});

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: workspace }],
  };
}

describe('a link to a network share is refused like the share itself (#614, review of #618) @cap:executer-une-commande/moteur', () => {
  it('the resolver refuses it as a UNC path', async () => {
    await expect(resolveAndCheckPath(ctx(), `${FAKE_LINK}/a.txt`)).rejects.toMatchObject({
      code: 'path_traversal_blocked',
      message: expect.stringContaining('UNC'),
    });
  });

  it('file_write through it is refused', async () => {
    const res = await fileWriteTool.execute(
      { path: `${FAKE_LINK}/a.txt`, content: 'x', create_dirs: true },
      ctx(),
    );
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).toContain('UNC');
  });

  it('a download through it asks, and names the place', async () => {
    const runCommand: ToolDefinition<z.ZodObject<{ command: z.ZodString }>, string> = {
      name: 'run_command',
      description: 'run a shell command',
      inputSchema: z.object({ command: z.string(), purpose: z.string() }),
      riskLevel: 'write',
      defaultApproval: 'require_approval',
      execute: async (input: { command: string }) => `ran:${input.command}`,
    };
    const command = `curl -o ${FAKE_LINK}/a.jpg https://x/a.jpg`;

    const res = await executeTool(runCommand, { command, purpose: 'Fetch it.' }, ctx(), {
      approvalRules: [
        {
          id: 'yolo',
          toolName: 'run_command',
          action: 'auto_approve',
          agentId: null,
          entityId: seed.entityId,
        },
      ],
      autonomy: 'destructive_gate',
      shellPolicy: DEFAULT_SHELL_POLICY,
      onApprovalRequired: async () => {},
    });

    expect(res.outcome).toBe('awaiting_approval');
    if (res.outcome !== 'awaiting_approval') throw new Error('unreachable');
    const [row] = await db
      .select({ gateReasons: approvalRequests.gateReasons })
      .from(approvalRequests)
      .where(eq(approvalRequests.id, res.approvalRequestId));
    expect(row?.gateReasons).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [command],
        outside: [{ command, places: [`${FAKE_LINK}/a.jpg`] }],
      },
    ]);
  });
});
