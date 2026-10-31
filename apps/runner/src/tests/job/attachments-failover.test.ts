// attachments-failover.test.ts — an image or a PDF is judged against the model
// that SERVES, never against the one the job started on (review of #905,
// pass 1).
//
// A failover chain moves its active model during a job (sticky-forward), and
// picks a link INSIDE a call. What a tool may hand the model (`ctx.modelInput`)
// and what a request carries (`hydrateForLlm`) were computed once, from the
// primary, at the job's start: after a failover, a PDF was admitted and sent
// to a model that takes none (a provider's refusal, or OpenRouter's parser
// replacing the scanned pages with its text) while the tool result said it
// was read — and, the other way round, a fallback that reads PDFs was refused
// one in the primary's name.
//
// Four chains, both kinds of file: the primary out of credits from the first
// request (the tool is told what the fallback takes), a primary that serves
// one turn then fails (the request is re-hydrated for the link that sends it),
// and the reverse chain (no false refusal). The REAL path: executeJob, a real
// test database, the real file_read, the real failover client (OpenRouter's
// builder), the provider requests read at the fetch boundary.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentWorkspaces, entityLlmKeys, eq } from '@nodal-agents/db';
import { encrypt } from '@nodal-agents/secrets';
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

vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

// PDF_MODEL_IDS / VISION_MODEL_IDS, OpenRouter input_modalities.
const READS_PDFS = 'anthropic/claude-haiku-5.5';
const SEES_NO_PDF = 'z-ai/glm-5.3-flash';
const SEES = 'anthropic/claude-sonnet-5.5';
const BLIND = 'z-ai/glm-5.3';

const PDF = buildTestPdf([{ text: 'Invoice 4217 from ACME' }, { scanned: 'INVOICE 4217 ACME' }]);
const PDF_B64 = PDF.toString('base64');
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a worksheet, rendered'),
]);
const PNG_B64 = PNG.toString('base64');

let db: TestDb;
let dir: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-attach-failover-')));
  await writeFile(join(dir, 'scan.pdf'), PDF);
  await writeFile(join(dir, 'apercu.png'), PNG);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** A job whose agent runs `primary`, with `fallback` behind it on a second OpenRouter key. */
async function chain(primary: string, fallback: string): Promise<string> {
  const { jobId, entityId, agentId } = await seedJob(db, { model: primary, role: 'agent' });
  const [second] = await db
    .insert(entityLlmKeys)
    .values({
      entityId,
      provider: 'openrouter',
      apiKey: encrypt('or-fallback-key'),
      baseUrl: null,
      nickname: 'OpenRouter (fallback)',
      isActive: true,
    })
    .returning();
  if (!second) throw new Error('failed to seed the fallback key');
  await db
    .update(agents)
    .set({ fallbackChain: [{ keyId: second.id, model: fallback }] })
    .where(eq(agents.id, agentId));
  await db
    .insert(agentWorkspaces)
    .values({ agentId, entityId, label: 'ws', path: dir, position: 0 });
  return jobId;
}

/**
 * Run the job against the scripted provider, with `failing` out of credits
 * from its `from`-th request on (1-based). Returns every request SERVED, in
 * order, each with the model it was sent to.
 */
async function run(
  jobId: string,
  script: ScriptedReply[],
  failing: { model: string; from: number },
): Promise<Body[]> {
  const served = scriptProvider(script);
  const answer = globalThis.fetch;
  let seen = 0;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Body;
    if (body.model === failing.model && ++seen >= failing.from) {
      return new Response(
        JSON.stringify({
          error: { message: 'Insufficient credits. Add more credits.', code: 429 },
        }),
        { status: 429, headers: { 'content-type': 'application/json' } },
      );
    }
    return answer(input, init);
  });
  await executeJob(jobId as JobId, makeDeps(db), testEnv);
  vi.unstubAllGlobals();
  return served;
}

type Part = { type?: string; file?: { file_data?: string }; image_url?: { url?: string } };

/** The text of the tool messages of a request. */
function toolText(b: Body): string {
  return b.messages
    .filter((m) => m.role === 'tool')
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n');
}

/** The files of a request: OpenRouter `file` parts and `image_url` parts. */
function files(b: Body): string[] {
  return b.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Part[]).flatMap((p) =>
          p.type === 'file'
            ? [p.file?.file_data ?? '']
            : p.type === 'image_url'
              ? [p.image_url?.url ?? '']
              : [],
        )
      : [],
  );
}

const read = (name: string): ScriptedReply => ({
  calls: [{ name: 'file_read', args: { path: join(dir, name) } }],
});

describe('a file is judged against the model that serves, through a failover chain @cap:choisir-modele/moteur', () => {
  it('PDF: the primary fails from the start; the fallback takes no PDF, so the tool is refused in ITS name', async () => {
    const jobId = await chain(READS_PDFS, SEES_NO_PDF);
    const served = await run(jobId, [read('scan.pdf')], { model: READS_PDFS, from: 1 });

    expect(served.map((b) => b.model)).toEqual([SEES_NO_PDF, SEES_NO_PDF]);
    const after = served[1]!;
    expect(files(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(PDF_B64);
    // The TOOL says it, at the call: it never claims a read the model did not get.
    expect(toolText(after)).toContain(
      'and it was not read: the model this agent runs ' +
        `(${SEES_NO_PDF}) does not take PDF documents as input.`,
    );
    expect(toolText(after)).not.toContain('"document":{');
  });

  it('image: the primary fails from the start; the fallback does not see, so the image is refused in ITS name', async () => {
    const jobId = await chain(SEES, BLIND);
    const served = await run(jobId, [read('apercu.png')], { model: SEES, from: 1 });

    expect(served.map((b) => b.model)).toEqual([BLIND, BLIND]);
    const after = served[1]!;
    expect(files(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(PNG_B64);
    expect(toolText(after)).toContain(
      'is an image (image/png, 29 B), and it was not read: the model this agent ' +
        `runs (${BLIND}) does not take images as input.`,
    );
    expect(toolText(after)).not.toContain('"image":{');
  });

  it('the reverse chain: the fallback reads PDFs, so the PDF reaches it — no refusal in the primary’s name', async () => {
    const jobId = await chain(SEES_NO_PDF, READS_PDFS);
    const served = await run(jobId, [read('scan.pdf')], { model: SEES_NO_PDF, from: 1 });

    expect(served.map((b) => b.model)).toEqual([READS_PDFS, READS_PDFS]);
    const after = served[1]!;
    expect(files(after)).toEqual([`data:application/pdf;base64,${PDF_B64}`]);
    expect(JSON.stringify(after)).not.toContain(SEES_NO_PDF);
  });

  it('PDF: the primary serves a turn then fails; the request the fallback gets is hydrated for the fallback', async () => {
    const jobId = await chain(READS_PDFS, SEES_NO_PDF);
    // Request 1 (the primary) reads the scan; request 2 fails over inside the call.
    const served = await run(jobId, [read('scan.pdf')], { model: READS_PDFS, from: 2 });

    expect(served.map((b) => b.model)).toEqual([READS_PDFS, SEES_NO_PDF]);
    const after = served[1]!;
    expect(files(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(PDF_B64);
    expect(JSON.stringify(after)).toContain(
      `not passed to you: the model this agent runs (${SEES_NO_PDF}) does not take PDF ` +
        'documents as input.]',
    );
  });

  it('image: the primary serves a turn then fails; the image is not sent to a fallback that does not see', async () => {
    const jobId = await chain(SEES, BLIND);
    const served = await run(jobId, [read('apercu.png')], { model: SEES, from: 2 });

    expect(served.map((b) => b.model)).toEqual([SEES, BLIND]);
    const after = served[1]!;
    expect(files(after)).toEqual([]);
    expect(JSON.stringify(after)).not.toContain(PNG_B64);
    expect(JSON.stringify(after)).toContain(
      `not passed to you: the model this agent runs (${BLIND}) does not take images as input.]`,
    );
  });
});
