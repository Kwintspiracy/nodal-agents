// tool-call-reads-send.test.ts — ce qu'un ENVOI a lu (tool_call_reads), sur le
// vrai `executeTool` et une vraie base.
//
// send_file, send_image et send_video (send-media) lisent le fichier local
// qu'ils expédient : les octets lus sont rangés comme ceux de toute lecture
// d'un outil (règle #11 : aucun lecteur à part). Seul l'adaptateur de canal
// est remplacé, à la frontière : ce test ne parle à aucun service.
// Fichier à part de tool-call-reads.test.ts parce que le faux adaptateur se
// pose sur tout le module `@nodal-agents/delivery`.

import { createHash } from 'node:crypto';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, asc, eq, toolCallReads, toolCalls } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createSendFileTool, createSendImageTool, createSendVideoTool } from '../communication';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext, ToolDefinition } from '../types';
import type { z } from 'zod';

const { sendMediaMock } = vi.hoisted(() => ({ sendMediaMock: vi.fn() }));

vi.mock('@nodal-agents/delivery', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/delivery')>();
  return { ...actual, getAdapter: () => ({ sendMedia: sendMediaMock }) };
});

type AnyTool = ToolDefinition<z.ZodTypeAny, unknown>;

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let ws = '';

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  await db.update(agents).set({ telegramBotToken: '123:test' }).where(eq(agents.id, seed.agentId));
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'nodal-tool-call-reads-send-'));
  sendMediaMock.mockReset();
  sendMediaMock.mockResolvedValue({ messageId: '1' });
});

afterEach(async () => {
  await rm(ws, { recursive: true, force: true });
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', task: 'send' })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: '42',
    jobChatChannel: 'telegram',
    jobChannel: 'telegram',
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

function autoApprove(tool: AnyTool): ExecuteOptions {
  const rule = {
    id: `rule-${tool.name}`,
    toolName: tool.name,
    action: 'auto_approve',
    agentId: seed.agentId,
    entityId: seed.entityId,
  } as ApprovalRule;
  return { approvalRules: [rule], onApprovalRequired: async () => {} };
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

async function lectures(jobId: string) {
  return db
    .select({ tool: toolCalls.toolName, path: toolCallReads.path, sha256: toolCallReads.sha256 })
    .from(toolCallReads)
    .innerJoin(toolCalls, eq(toolCalls.id, toolCallReads.toolCallId))
    .where(eq(toolCallReads.jobId, jobId))
    .orderBy(asc(toolCalls.seq));
}

// Un PNG minimal (signature + IHDR) : send_image ne juge pas l'image, il l'expédie.
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489',
  'hex',
);

describe('tool_call_reads: what a send read @cap:travailler-sur-des-fichiers/moteur', () => {
  it.each([
    ['send_file', () => createSendFileTool(), 'rapport.md', Buffer.from('# Rapport\n')],
    ['send_image', () => createSendImageTool(), 'photo.png', PNG],
    ['send_video', () => createSendVideoTool(), 'clip.mp4', Buffer.from('not really a video')],
  ])(
    '%s of a local file: the row names the real file and the bytes that were sent',
    async (nom, make, fichier, bytes) => {
      const tool = make() as unknown as AnyTool;
      expect(tool.name).toBe(nom);
      const jobId = await jobNeuf();
      await writeFile(join(ws, fichier), bytes);
      const res = await executeTool(
        tool,
        { source: join(ws, fichier) },
        ctx(jobId),
        autoApprove(tool),
      );
      expect(res).toMatchObject({ outcome: 'success' });
      // Les octets envoyés SONT ceux qui ont été lus et rangés.
      const sent = (sendMediaMock.mock.calls[0]?.[2] as { bytes: Uint8Array }).bytes;
      expect(sha(Buffer.from(sent))).toBe(sha(bytes));
      expect(await lectures(jobId)).toEqual([
        { tool: nom, path: normalizePath(await realpath(join(ws, fichier))), sha256: sha(bytes) },
      ]);
    },
  );

  it('a send from a URL reads no local file: no row', async () => {
    const tool = createSendFileTool() as unknown as AnyTool;
    const jobId = await jobNeuf();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('distant', { status: 200 }));
    const res = await executeTool(
      tool,
      { source: 'https://example.invalid/doc.txt' },
      ctx(jobId),
      autoApprove(tool),
    );
    expect(res).toMatchObject({ outcome: 'success' });
    expect(await lectures(jobId)).toEqual([]);
    vi.restoreAllMocks();
  });
});
