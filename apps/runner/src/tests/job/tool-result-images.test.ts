// tool-result-images.test.ts — what the model is SENT when a tool comes back
// with an image: the image itself, to a model that sees, in the form every
// provider takes (a user message after the tool message); a refusal that says
// why, to a model that does not — never the bytes as text.
//
// Run 039f8666 (2026-10-18): the root agent, on a model that sees, screenshot
// its worksheet into the shared folder, read it with file_read, got the PNG as
// UTF-8 garbage, wrote "I have no vision tool" and delegated the check — on
// the team block's word ("can see images — route image tasks here") — to a
// forum persona that could not see it either. Nothing here is that run: two
// formats in one turn (the parallel read path), a model that sees and one that
// does not, and a delegation, where the parent's image does not travel and the
// child, whose model sees, looks at the file itself; the team line says what
// is true of each runtime.
//
// The REAL path: executeJob, a real test database, the real file_read, the
// real LLM client (OpenRouter's builder), and the provider request read at the
// fetch boundary.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentAssignments,
  agentJobs,
  agents,
  agentWorkspaces,
  approvalRequests,
  approvalRules,
  entityLlmKeys,
  eq,
} from '@nodal-agents/db';
import { encrypt } from '@nodal-agents/secrets';
import type { JobId } from '@nodal-agents/orchestration';
import { executeJob } from '../../job/execute.ts';
import {
  makeDeps,
  scriptProvider,
  seedJob,
  systemOf,
  testEnv,
  type Body,
  type ScriptedReply,
} from './tool-loading-harness.ts';

// Provider calls leave through packages/llm's own transport (#609): routed back
// to the global fetch the harness stubs.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const SEEING = 'anthropic/claude-sonnet-5.5';
// Text-only per OpenRouter's input_modalities (model-catalog.ts, VISION_MODEL_IDS).
const BLIND = 'z-ai/glm-5.3';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('a worksheet, rendered'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('a photo')]);
const PNG_B64 = PNG.toString('base64');
const JPEG_B64 = JPEG.toString('base64');

let db: TestDb;
let dir: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  dir = await realpath(await mkdtemp(join(tmpdir(), 'nodal-tool-images-')));
  await writeFile(join(dir, 'apercu.png'), PNG);
  await writeFile(join(dir, 'photo.jpg'), JPEG);
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

type Part = { type?: string; text?: string; image_url?: { url?: string } };

/** Every image part of the request, as the data URL the provider receives. */
function imageUrls(b: Body): string[] {
  return b.messages.flatMap((m) =>
    Array.isArray(m.content)
      ? (m.content as Part[])
          .filter((p) => p.type === 'image_url')
          .map((p) => p.image_url?.url ?? '')
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

const readBoth = (): ScriptedReply => ({
  calls: [
    { name: 'file_read', args: { path: join(dir, 'apercu.png') } },
    { name: 'file_read', args: { path: join(dir, 'photo.jpg') } },
  ],
});

describe('a tool result that carries an image reaches the model @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a model that sees: each image, bytes intact, in a user message right after the tool results', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: SEEING, role: 'agent' });
    await giveFolder(agentId, entityId);
    const bodies = await run(jobId, [readBoth()]);

    const after = bodies[1];
    if (!after) throw new Error('expected a second request');
    expect(imageUrls(after)).toEqual([
      `data:image/png;base64,${PNG_B64}`,
      `data:image/jpeg;base64,${JPEG_B64}`,
    ]);
    // The tool results say what was read; they never carry the bytes as text.
    const tools = toolText(after);
    expect(tools).toContain('"image":{"media_type":"image/png","bytes":29}');
    expect(tools).toContain('"image":{"media_type":"image/jpeg","bytes":11}');
    expect(tools).not.toContain(PNG_B64);
    expect(tools).not.toContain(JPEG_B64);
    // The images follow the tool messages, each introduced by its call.
    const roles = after.messages.map((m) => m.role);
    const lastTool = roles.lastIndexOf('tool');
    const imagesMsg = after.messages[lastTool + 1];
    expect(imagesMsg?.role).toBe('user');
    const labels = (imagesMsg?.content as Part[])
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(labels).toEqual([
      expect.stringMatching(
        /^\[The image below was returned by your tool call \S+ \(file_read\)\./,
      ),
      expect.stringMatching(
        /^\[The image below was returned by your tool call \S+ \(file_read\)\./,
      ),
    ]);
  });

  it('a model that does not see: the call says why, and no image or byte leaves', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: BLIND, role: 'agent' });
    await giveFolder(agentId, entityId);
    const bodies = await run(jobId, [readBoth()]);

    const after = bodies[1];
    if (!after) throw new Error('expected a second request');
    expect(imageUrls(after)).toEqual([]);
    const all = JSON.stringify(after);
    expect(all).not.toContain(PNG_B64);
    expect(all).not.toContain(JPEG_B64);
    const tools = toolText(after);
    expect(tools).toContain('is an image (image/png, 29 B), and it was not read');
    expect(tools).toContain(`the model this agent runs (${BLIND}) does not take images as input`);
  });
});

describe('a transcript that carries an image, resumed under a model that does not see @cap:travailler-sur-des-fichiers/moteur', () => {
  it('the image is said, never sent: the agent model changed while the job waited for an approval', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, {
      model: SEEING,
      role: 'agent',
      root: true,
      autonomy: 'propose_confirm',
    });
    await giveFolder(agentId, entityId);
    // file_list waits for a person: the job suspends with the image in its transcript.
    await db
      .insert(approvalRules)
      .values({ entityId, agentId: null, toolName: 'file_list', action: 'require_approval' });
    await run(jobId, [
      { calls: [{ name: 'file_read', args: { path: join(dir, 'apercu.png') } }] },
      { calls: [{ name: 'file_list', args: { path: dir, purpose: 'List the folder.' } }] },
    ]);
    const [suspended] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(suspended?.status).toBe('awaiting_approval');
    expect(JSON.stringify(suspended?.messages)).toContain(PNG_B64);

    // The owner moves the agent to a model that does not see, then approves.
    await db.update(agents).set({ model: BLIND }).where(eq(agents.id, agentId));
    await db
      .update(approvalRequests)
      .set({ status: 'approved', resolvedAt: new Date(), resolvedBy: 'test' })
      .where(eq(approvalRequests.jobId, jobId));
    await db
      .update(agentJobs)
      .set({ status: 'pending', updatedAt: new Date() })
      .where(eq(agentJobs.id, jobId));
    const resumed = await run(jobId, [{ text: 'Done.' }]);

    const first = resumed[0];
    if (!first) throw new Error('the resumed job never called the model');
    expect(imageUrls(first)).toEqual([]);
    expect(JSON.stringify(first)).not.toContain(PNG_B64);
    expect(toolText(first)).toContain(
      '[An image (image/png) was attached to this result: not passed to you, your current ' +
        'model does not take images as input.]',
    );
  });
});

describe('an image and a delegation @cap:organiser-equipe/moteur', () => {
  it('the parent image does not travel; the child, whose model sees, looks at the file itself; the team line is a fact', async () => {
    const { jobId, entityId, agentId, keyId } = await seedJob(db, {
      model: SEEING,
      role: 'orchestrator',
    });
    await giveFolder(agentId, entityId);
    const [child] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Checker',
        slug: `checker-${Date.now()}`,
        personality: 'You check documents.',
        role: 'agent',
        llmKeyId: keyId,
        model: SEEING,
      })
      .returning();
    const [cli] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Coder',
        slug: `coder-${Date.now()}`,
        personality: 'You write code.',
        role: 'agent',
        llmKeyId: keyId,
        // A model that sees, on a CLI runtime: the CLI runs its own model and
        // receives the task as text, so nothing is claimed for it.
        model: SEEING,
        runtime: 'claude-code',
      })
      .returning();
    if (!child || !cli) throw new Error('failed to seed the children');
    for (const sub of [child, cli]) {
      await db
        .insert(agentAssignments)
        .values({ orchestratorId: agentId, subAgentId: sub.id, entityId });
    }
    await giveFolder(child.id, entityId);
    const assign = `assign_${child.slug.replace(/-/g, '_')}`;

    // The child runs in the parent's run: the requests follow one another,
    // the parent's two turns, the child's two, then the parent resumed — with
    // the final-answer rechecks (#711) in between, which have no system prompt.
    const bodies = await run(jobId, [
      { calls: [{ name: 'file_read', args: { path: join(dir, 'apercu.png') } }] },
      { calls: [{ name: assign, args: { task: `Check ${join(dir, 'apercu.png')}` } }] },
      { calls: [{ name: 'file_read', args: { path: join(dir, 'apercu.png') } }] },
      { text: 'The worksheet is fine.' },
    ]);
    const parent = bodies.filter((b) => systemOf(b).includes('Your agents:'));
    const childBodies = bodies.filter((b) => systemOf(b).includes('You are Checker'));
    const rechecks = bodies.filter((b) => !parent.includes(b) && !childBodies.includes(b));
    expect(childBodies).toHaveLength(2);
    // A recheck reads the run's results as text: an image is said, never its base64.
    expect(rechecks.length).toBeGreaterThan(0);
    for (const r of rechecks) expect(JSON.stringify(r)).not.toContain(PNG_B64);

    // The parent saw its own image.
    expect(imageUrls(parent[1] as Body)).toEqual([`data:image/png;base64,${PNG_B64}`]);
    // The team block states the fact, for the runtime where it holds, and
    // gives no routing order.
    // The system prompt as text (OpenRouter sends it as parts: serialized).
    const system = systemOf(parent[0] as Body).replace(/\\n/g, '\n');
    expect(system).not.toContain('route image tasks here');
    const lineOf = (name: string): string =>
      system.split('\n- **').find((l) => l.startsWith(`${name}**`)) ?? '';
    expect(lineOf('Checker')).toContain(`Images: its model (${SEEING}) takes images as input.`);
    expect(lineOf('Coder')).not.toBe('');
    expect(lineOf('Coder')).not.toContain('Images:');

    // The child's task is text: the parent's tool image did not travel.
    const [childJob] = await db.select().from(agentJobs).where(eq(agentJobs.parentJobId, jobId));
    if (!childJob) throw new Error('the delegation created no child job');
    const firstMessage = JSON.stringify((childJob.messages as unknown[])[0]);
    expect(firstMessage).toContain('Check ');
    expect(firstMessage).not.toContain(PNG_B64);
    expect(firstMessage).not.toContain('"type":"image"');
    expect(JSON.stringify(childBodies[0])).not.toContain(PNG_B64);
    // The line and what the child actually received, side by side: the line
    // may only promise an image travels if the child's payload carries one.
    const lineClaimsDelivery = /travel|carried|attached|reaches/i.test(lineOf('Checker'));
    const childReceivedImage =
      firstMessage.includes('"type":"image"') || imageUrls(childBodies[0] as Body).length > 0;
    expect(!lineClaimsDelivery || childReceivedImage).toBe(true);

    // The child reads the file from its own folder, and sees it.
    expect(imageUrls(childBodies[0] as Body)).toEqual([]);
    expect(imageUrls(childBodies[1] as Body)).toEqual([`data:image/png;base64,${PNG_B64}`]);
  });
});

describe('an image read in the turn that delegates @cap:organiser-equipe/moteur', () => {
  it('its result travels as a side result: the image is said there, never its base64 as text', async () => {
    const { jobId, entityId, agentId, keyId } = await seedJob(db, {
      model: SEEING,
      role: 'orchestrator',
    });
    await giveFolder(agentId, entityId);
    const [child] = await db
      .insert(agents)
      .values({
        entityId,
        name: 'Reviewer',
        slug: `reviewer-${Date.now()}`,
        personality: 'You review documents.',
        role: 'agent',
        llmKeyId: keyId,
        model: SEEING,
      })
      .returning();
    if (!child) throw new Error('failed to seed the child');
    await db
      .insert(agentAssignments)
      .values({ orchestratorId: agentId, subAgentId: child.id, entityId });
    const assign = `assign_${child.slug.replace(/-/g, '_')}`;

    // One turn: the read and the delegation. The read runs first, its result
    // travels with the delegation and is re-injected next to the child's.
    const bodies = await run(jobId, [
      {
        calls: [
          { name: 'file_read', args: { path: join(dir, 'apercu.png') } },
          { name: assign, args: { task: 'Review the worksheet layout.' } },
        ],
      },
      { text: 'Reviewed.' },
    ]);
    const parent = bodies.filter((b) => systemOf(b).includes('Your agents:'));
    const resumed = parent.at(-1);
    if (!resumed || parent.length < 2) throw new Error('the parent never resumed');
    expect(JSON.stringify(resumed)).not.toContain(PNG_B64);
    expect(toolText(resumed)).toContain(
      '[An image (image/png) was attached to this result; it is not carried here. Read it again to see it.]',
    );
  });
});

describe('whether a model sees is read per model, never per provider @cap:choisir-modele/moteur', () => {
  /** An Anthropic Messages stream: one tool call, or a closing text. */
  function anthropicSse(turn: number, path: string): string {
    const head = {
      type: 'message_start',
      message: {
        id: `msg_${turn}`,
        type: 'message',
        role: 'assistant',
        model: 'claude-instant-1.2',
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    };
    const body =
      turn === 1
        ? [
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'tool_use', id: 'toolu_1', name: 'file_read', input: {} },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path }) },
            },
          ]
        : [
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done.' } },
          ];
    const tail = [
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: turn === 1 ? 'tool_use' : 'end_turn', stop_sequence: null },
        usage: { output_tokens: 2 },
      },
      { type: 'message_stop' },
    ];
    return [head, ...body, ...tail]
      .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
      .join('');
  }

  it('a text-only model of a provider whose other models see is refused the image, and told why', async () => {
    const { jobId, entityId, agentId } = await seedJob(db, { model: SEEING, role: 'agent' });
    await giveFolder(agentId, entityId);
    // An Anthropic key, and an Anthropic model that takes text only.
    const [key] = await db
      .insert(entityLlmKeys)
      .values({
        entityId,
        provider: 'anthropic',
        apiKey: encrypt('sk-ant-test'),
        baseUrl: null,
        nickname: 'Anthropic (test)',
        isActive: true,
      })
      .returning();
    if (!key) throw new Error('failed to seed the anthropic key');
    await db
      .update(agents)
      .set({ llmKeyId: key.id, model: 'claude-instant-1.2' })
      .where(eq(agents.id, agentId));

    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (!url.includes('/messages')) throw new Error(`unexpected fetch ${url}`);
        sent.push(String(init?.body));
        return new Response(anthropicSse(sent.length, join(dir, 'apercu.png')), {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        });
      }),
    );
    await executeJob(jobId as JobId, makeDeps(db), testEnv);
    vi.unstubAllGlobals();

    const after = sent[1];
    if (!after) throw new Error('the model was never called after the tool ran');
    expect(after).not.toContain(PNG_B64);
    expect(after).toContain(
      'the model this agent runs (claude-instant-1.2) does not take images as input',
    );
  });
});
