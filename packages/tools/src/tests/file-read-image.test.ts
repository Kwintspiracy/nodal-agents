// file-read-image.test.ts — an image file in a folder the agent can read
// reaches a model that sees it, as the image itself, through the seam
// (`executeTool` → `ctx.attachImage`); to a model that does not, the call says
// why, and never hands over the bytes as text.
//
// Run 039f8666 (2026-10-18): the root agent, on a model that sees, took a PNG
// screenshot of its own worksheet and could not look at it — `file_read`
// decoded the PNG as UTF-8. Nothing here is about that run: four formats, a
// seeing and a non-seeing model, a format models do not take, an image above
// the cap, a file outside the readable folders, a text file named `.png` and a
// PNG with no extension.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { toolCalls, eq } from '@nodal-agents/db';
import { MODEL_REQUEST_MAX_IMAGES, MODEL_REQUEST_MAX_IMAGE_BYTES } from '@nodal-agents/shared';
import { z } from 'zod';
import { executeTool } from '../execute';
import { fileReadTool } from '../builtin/file-ops/file-read';
import {
  MAX_MODEL_IMAGE_BYTES,
  admitModelAttachment,
  sniffImageMediaType,
  type ModelAttachmentInput,
} from '../model-images';
import type { ToolContext, ToolExecutionResult } from '../types';

// The first bytes each format declares, then a body: the sniffer reads the
// bytes, never the name.
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg body')]);
const GIF = Buffer.from('GIF89a gif body');
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([0x10, 0, 0, 0]),
  Buffer.from('WEBPVP8 body'),
]);
const BMP = Buffer.concat([Buffer.from('BM'), Buffer.alloc(20, 1)]);

const SEES: ModelAttachmentInput = { image: { sees: true }, pdf: { sees: true } };
const BLIND: ModelAttachmentInput = {
  image: {
    sees: false,
    reason: 'the model this agent runs (z-ai/glm-5.3) does not take images as input',
  },
  pdf: {
    sees: false,
    reason: 'the model this agent runs (z-ai/glm-5.3) does not take PDF documents as input',
  },
};

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let ws: string;
let outside: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  ws = await realpath(await mkdtemp(join(tmpdir(), 'nodal-read-image-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'nodal-read-image-out-')));
  await writeFile(join(ws, 'shot.png'), PNG);
  await writeFile(join(ws, 'photo.jpg'), JPEG);
  await writeFile(join(ws, 'anim.gif'), GIF);
  await writeFile(join(ws, 'pic.webp'), WEBP);
  await writeFile(join(ws, 'scan.bmp'), BMP);
  await writeFile(join(ws, 'screenshot'), PNG);
  await writeFile(join(ws, 'notes.png'), 'just text, despite the name\n');
  await writeFile(
    join(ws, 'huge.png'),
    Buffer.concat([PNG, Buffer.alloc(MAX_MODEL_IMAGE_BYTES + 1024, 7)]),
  );
  await writeFile(join(outside, 'secret.png'), PNG);
});

afterAll(async () => {
  await rm(ws, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

function ctx(modelInput?: ModelAttachmentInput): ToolContext {
  return {
    db: db as unknown as ToolContext['db'],
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId: seed.jobId,
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    ...(modelInput ? { modelInput } : {}),
  };
}

const opts = { approvalRules: [], onApprovalRequired: async () => {} } as never;

async function read(path: string, input?: ModelAttachmentInput): Promise<ToolExecutionResult> {
  return executeTool(fileReadTool as never, { path }, ctx(input), opts);
}

/** The output the audit row of the last file_read on `path` keeps. */
async function recorded(path: string): Promise<unknown> {
  const rows = await db
    .select({ toolInput: toolCalls.toolInput, toolOutput: toolCalls.toolOutput })
    .from(toolCalls)
    .where(eq(toolCalls.jobId, seed.jobId));
  const row = rows.filter((r) => (r.toolInput as { path?: string }).path === path).at(-1);
  return JSON.parse(String(row?.toolOutput));
}

describe('file_read — an image file reaches a model that sees it @cap:travailler-sur-des-fichiers/moteur', () => {
  it.each([
    ['shot.png', PNG, 'image/png'],
    ['photo.jpg', JPEG, 'image/jpeg'],
    ['anim.gif', GIF, 'image/gif'],
    ['pic.webp', WEBP, 'image/webp'],
    // No extension: the bytes say what the file is.
    ['screenshot', PNG, 'image/png'],
  ])(
    '%s: the image itself, its bytes intact, never on the audit row',
    async (path, bytes, type) => {
      const r = await read(path, SEES);
      expect(r.outcome).toBe('success');
      if (r.outcome !== 'success') throw new Error('expected success');
      expect(r.attachments).toEqual([{ mediaType: type, data: bytes.toString('base64') }]);
      expect(r.output).toEqual({ ok: true, image: { media_type: type, bytes: bytes.length } });
      // The row is an audit, not a store: type and size, no base64.
      const row = await recorded(path);
      expect(row).toEqual({ ok: true, image: { media_type: type, bytes: bytes.length } });
      expect(JSON.stringify(row)).not.toContain(bytes.toString('base64'));
    },
  );

  it('a model that does not see: refused with its reason, no image, no bytes as text', async () => {
    const r = await read('shot.png', BLIND);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect(r.output).toEqual({
      ok: false,
      reason:
        '"shot.png" is an image (image/png, 16 B), and it was not read: the model this agent ' +
        'runs (z-ai/glm-5.3) does not take images as input.',
    });
  });

  it('a run that says nothing about its model passes no image, and says so', async () => {
    const r = await read('photo.jpg');
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { reason: string }).reason).toBe(
      '"photo.jpg" is an image (image/jpeg, 13 B), and it was not read: this run does not pass ' +
        'images to a model.',
    );
  });

  it('a format models do not take is refused as an image, named, never read as text', async () => {
    const r = await read('scan.bmp', SEES);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { ok: boolean; reason: string }).reason).toBe(
      '"scan.bmp" is an image (image/bmp, 22 B), and it was not read: image/bmp is not a format ' +
        'models take as input (image/png, image/jpeg, image/gif, image/webp).',
    );
  });

  it('an image above the whole-read cap is refused with its size, even to a model that sees', async () => {
    const r = await read('huge.png', SEES);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    const reason = (r.output as { reason: string }).reason;
    expect(reason).toContain('"huge.png" is an image (image/png, 1.0 MiB)');
    expect(reason).toContain('an image can be passed at 1.0 MiB at most');
  });

  it('an image outside the readable folders is refused by the folder rule, before any byte', async () => {
    const r = await read(join(outside, 'secret.png'), SEES);
    if (r.outcome !== 'success') throw new Error('expected the tool to answer');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { ok: boolean }).ok).toBe(false);
    expect((r.output as { reason: string }).reason).toContain(
      'does not reside in any configured workspace',
    );
  });

  it('a text file named .png is read as text', async () => {
    const r = await read('notes.png', SEES);
    if (r.outcome !== 'success') throw new Error('expected success');
    expect(r.attachments).toBeUndefined();
    expect((r.output as { content: string }).content).toBe('just text, despite the name\n');
  });
});

describe('the one rule for every image a tool attaches @cap:travailler-sur-des-fichiers/moteur', () => {
  it('sniffs the formats from their bytes, and SVG (text) as no image', () => {
    expect(sniffImageMediaType(PNG)).toBe('image/png');
    expect(sniffImageMediaType(JPEG)).toBe('image/jpeg');
    expect(sniffImageMediaType(GIF)).toBe('image/gif');
    expect(sniffImageMediaType(WEBP)).toBe('image/webp');
    expect(sniffImageMediaType(BMP)).toBe('image/bmp');
    expect(sniffImageMediaType(Buffer.from([0x49, 0x49, 0x2a, 0x00, 1, 2]))).toBe('image/tiff');
    expect(
      sniffImageMediaType(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')])),
    ).toBe('image/heic');
    expect(
      sniffImageMediaType(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypavif')])),
    ).toBe('image/avif');
    expect(sniffImageMediaType(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe(
      null,
    );
    expect(sniffImageMediaType(Buffer.from('hello'))).toBe(null);
  });

  it('admits a model format within the cap to a seeing model, and says why otherwise', () => {
    const png = { mediaType: 'image/png', data: PNG.toString('base64') };
    expect(admitModelAttachment(SEES, png)).toEqual({ attached: true });
    expect(admitModelAttachment(BLIND, png)).toEqual({
      attached: false,
      reason: (BLIND.image as { reason: string }).reason,
    });
    expect(admitModelAttachment(undefined, png)).toEqual({
      attached: false,
      reason: 'this run does not pass images to a model',
    });
    expect(admitModelAttachment(SEES, { mediaType: 'image/svg+xml', data: 'PHN2Zy8+' })).toEqual({
      attached: false,
      reason:
        'image/svg+xml is not a format models take as input (image/png, image/jpeg, image/gif, image/webp)',
    });
    const big = Buffer.alloc(MAX_MODEL_IMAGE_BYTES + 1).toString('base64');
    expect(admitModelAttachment(SEES, { mediaType: 'image/png', data: big }).attached).toBe(false);
    const atCap = Buffer.alloc(MAX_MODEL_IMAGE_BYTES).toString('base64');
    expect(admitModelAttachment(SEES, { mediaType: 'image/png', data: atCap })).toEqual({
      attached: true,
    });
  });
});

describe('one call attaches no more than one request carries @cap:travailler-sur-des-fichiers/moteur', () => {
  /** A tool that hands `count` images of `bytes` each to the seam, and returns what became of them. */
  function attaching(count: number, bytes: number) {
    return {
      name: 'attach_many',
      description: 'test tool',
      inputSchema: z.object({}),
      riskLevel: 'read',
      card: 'generic',
      execute: async (_input: unknown, c: ToolContext) =>
        Array.from({ length: count }, (_, k) =>
          c.attachForModel?.({
            mediaType: 'image/png',
            data: Buffer.alloc(bytes, k).toString('base64'),
          }),
        ),
    };
  }

  it('by count: the first 20 are attached, each one past them is refused with the budget named', async () => {
    const r = await executeTool(attaching(23, 10) as never, {}, ctx(SEES), opts);
    if (r.outcome !== 'success') throw new Error('expected success');
    expect(r.attachments).toHaveLength(MODEL_REQUEST_MAX_IMAGES);
    const refused = (r.output as Array<{ attached: boolean; reason?: string }>).filter(
      (o) => !o.attached,
    );
    expect(refused).toHaveLength(3);
    expect(refused[0]?.reason).toBe(
      'this call already attached 20 file(s) (20 image(s) or PDF page(s), 200 B), and a request ' +
        'to a model carries at most 20 images and 10.0 MiB of them, a PDF page counting as one image',
    );
  });

  it('by bytes: 1 MiB images, as many as fit 10 MiB', async () => {
    const r = await executeTool(attaching(12, MAX_MODEL_IMAGE_BYTES) as never, {}, ctx(SEES), opts);
    if (r.outcome !== 'success') throw new Error('expected success');
    expect(r.attachments).toHaveLength(MODEL_REQUEST_MAX_IMAGE_BYTES / MAX_MODEL_IMAGE_BYTES);
    expect((r.output as Array<{ attached: boolean }>).filter((o) => !o.attached)).toHaveLength(2);
  });
});
