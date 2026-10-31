// tool-result-pdf.test.ts — what the model is SENT when file_read comes back
// with a PDF (#903): the document itself, to a model that takes PDFs, in the
// form its provider takes (a `file` part in a user message after the tool
// message); a refusal that says why, to a model that does not — never the
// bytes as text. And what the job KEEPS: the saved file's path, never its
// bytes, so that a job resumed after an approval sends the document again,
// once.
//
// The need (2026-10-31): the owner's agent, on anthropic/claude-haiku-5.5
// through OpenRouter, must know what a printer scan is to file it. Nothing
// here is only that case: a text page and a scanned page, a model that takes
// PDFs and one that sees images but takes no PDF, a resume, and a model
// change while the job waited.
//
// The REAL path: executeJob, a real test database, the real file_read, the
// real LLM client (OpenRouter's builder), and the provider request read at the
// fetch boundary.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  agentWorkspaces,
  approvalRequests,
  approvalRules,
  eq,
} from '@nodal-agents/db';
import { buildTestPdf } from '@nodal-agents/test-kit';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import {
  makeDeps,
  scriptProvider,
  seedJob,
  testEnv,
  type Body,
  type ScriptedReply,
} from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609): routed back
// to the global fetch the harness stubs.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

// The owner's model: "file" in OpenRouter's input_modalities (PDF_MODEL_IDS).
const READS_PDFS = 'anthropic/claude-haiku-5.5';
// Sees images, takes no PDF: OpenRouter reports ["text","image","video"].
const NO_PDFS = 'z-ai/glm-5.3-flash';

const PDF = buildTestPdf([{ text: 'Invoice 4217 from ACME' }, { scanned: 'INVOICE 4217 ACME' }]);
const PDF_B64 = PDF.toString('base64');
const DATA_URL = `data:application/pdf;base64,${PDF_B64}`;

let db: TestDb;
let dir: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-tool-pdf-')));
  // No extension: the bytes say what it is.
  await writeFile(join(dir, 'scan-0042'), PDF);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

async function giveFolder(agentId: string, entityId: string): Promise<void> {
  await db
    .insert(agentWorkspaces)
    .values({ agentId, entityId, label: 'ws', path: dir, position: 0 });
}

async function run(jobId: string, script: ScriptedReply[]): Promise<Body[]> {
  const bodies = scriptProvider(script);
  await executeJob(jobId as JobId, makeDeps(db), testEnv);
  vi.unstubAllGlobals();
  return bodies;
}

type Part = { type?: string; text?: string; file?: { filename?: string; file_data?: string } };

/** Every file part of the request, as OpenRouter receives it. */
function fileParts(b: Body): Array<{ filename?: string; file_data?: string }> {
  return b.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Part[]).filter((p) => p.type === 'file').map((p) => p.file ?? {})
      : [],
  );
}

/** The text of the tool messages of the request. */
function toolText(b: Body): string {
  return b.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

async function storedMessages(jobId: string): Promise<string> {
  const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
  return JSON.stringify(row?.messages ?? null);
}

/** The paths of the tool files a stored transcript names (`file:` URLs). */
function savedPaths(stored: string): string[] {
  return [...stored.matchAll(/"url":"(file:[^"]+)"/g)].map((m) => fileURLToPath(m[1] ?? ''));
}

const readScan = (): ScriptedReply => ({
  calls: [{ name: 'file_read', args: { path: join(dir, 'scan-0042') } }],
});

describe('a PDF file_read returns reaches a model that takes PDFs @cap:travailler-sur-des-fichiers/moteur', () => {
  it('the document, bytes intact, as a file part after the tool result; the row keeps its path', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: READS_PDFS, role: 'agent' });
    await giveFolder(agentId, entityId);
    const bodies = await run(jobId, [readScan()]);

    const after = bodies[1];
    if (!after) throw new Error('expected a second request');
    const files = fileParts(after);
    expect(files).toHaveLength(1);
    expect(files[0]?.file_data).toBe(DATA_URL);
    expect(files[0]?.filename).toMatch(/-1\.pdf$/);
    // The tool result says what was read, never the bytes.
    const tools = toolText(after);
    expect(tools).toContain(
      `"document":{"media_type":"application/pdf","bytes":${PDF.length},"pages":2,"attached_pages":"1-2"}`,
    );
    expect(tools).not.toContain(PDF_B64);
    // The document follows the tool message, introduced by its call.
    const roles = after.messages.map((m) => m.role);
    const docMsg = after.messages[roles.lastIndexOf('tool') + 1];
    expect(docMsg?.role).toBe('user');
    expect((docMsg?.content as Part[])[0]?.text).toMatch(
      /^\[The document below was returned by your tool call \S+ \(file_read\)\./,
    );

    // The row keeps the PATH of a saved copy, in the shared folder, never a byte.
    const stored = await storedMessages(jobId);
    expect(stored).not.toContain(PDF_B64);
    const saved = savedPaths(stored);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(join('shared', 'tools', jobId));
    expect(saved[0]).toMatch(/\.pdf$/);
    expect(await readFile(saved[0] ?? '')).toEqual(PDF);
  });

  it('a model that sees images but takes no PDF: the call says why, and no byte leaves', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: NO_PDFS, role: 'agent' });
    await giveFolder(agentId, entityId);
    const bodies = await run(jobId, [readScan()]);

    const after = bodies[1];
    if (!after) throw new Error('expected a second request');
    expect(fileParts(after)).toEqual([]);
    const all = JSON.stringify(after);
    expect(all).not.toContain(PDF_B64);
    expect(all).not.toContain('%PDF');
    const tools = toolText(after);
    expect(tools).toContain('is a PDF document (2 page(s)');
    expect(tools).toContain(
      `the model this agent runs (${NO_PDFS}) does not take PDF documents as input`,
    );
  });
});

describe('a transcript that carries a PDF, resumed @cap:travailler-sur-des-fichiers/moteur', () => {
  /** Read the scan, then wait for a person on file_list: the job suspends with the PDF in its transcript. */
  async function suspendedWithPdf(): Promise<{ jobId: string; agentId: string; saved: string }> {
    const { jobId, entityId, agentId } = await seedJob(db, {
      model: READS_PDFS,
      role: 'agent',
      root: true,
      autonomy: 'propose_confirm',
    });
    await giveFolder(agentId, entityId);
    await db
      .insert(approvalRules)
      .values({ entityId, agentId: null, toolName: 'file_list', action: 'require_approval' });
    await run(jobId, [
      readScan(),
      { calls: [{ name: 'file_list', args: { path: dir, purpose: 'List the folder.' } }] },
    ]);
    const [suspended] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(suspended?.status).toBe('awaiting_approval');
    expect(JSON.stringify(suspended?.messages)).not.toContain(PDF_B64);
    const [saved] = savedPaths(JSON.stringify(suspended?.messages));
    if (!saved) throw new Error('the suspended transcript names no saved PDF');
    return { jobId, agentId, saved };
  }

  async function approveAndResume(jobId: string): Promise<Body[]> {
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.jobId, jobId));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId));
    return run(jobId, [{ text: 'Done.' }]);
  }

  it('the resumed request sends the document again, once: neither lost nor doubled', async () => {
    const { jobId } = await suspendedWithPdf();
    const resumed = await approveAndResume(jobId);
    const first = resumed[0];
    if (!first) throw new Error('the resumed job never called the model');
    expect(fileParts(first).map((f) => f.file_data)).toEqual([DATA_URL]);
    expect(JSON.stringify(first).split(PDF_B64).length - 1).toBe(1);
  });

  it('the agent moved to a model that takes no PDF while it waited: the PDF is said, never sent', async () => {
    const { jobId, agentId, saved } = await suspendedWithPdf();
    await db.update(agents).set({ model: NO_PDFS }).where(eq(agents.id, agentId));
    const resumed = await approveAndResume(jobId);
    const first = resumed[0];
    if (!first) throw new Error('the resumed job never called the model');
    expect(fileParts(first)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(PDF_B64);
    const savedInJson = JSON.stringify(saved).slice(1, -1);
    expect(toolText(first)).toContain(
      `[A PDF document was attached to this result, saved at ${savedInJson}: not passed to ` +
        `you: the model this agent runs (${NO_PDFS}) does not take PDF documents as input.]`,
    );
  });
});
