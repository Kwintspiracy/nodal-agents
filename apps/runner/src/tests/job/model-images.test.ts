// model-images.test.ts — every shape an image part of a transcript can take,
// proven AT THE WIRE (reviews of #798, passes 3 and 4): the body that reaches
// `fetch` for a native provider (Anthropic Messages) and a chat-completions one
// (openai-compatible). A test that only inspected `hydrateForLlm`'s output was
// green while the wire layer turned a tool's `image-url` into the text
// "[image-url]": the model never got the image.
//
// For a model that sees, the image's bytes are in the body; for one that does
// not, they are not, and the reason is. A remote image (`https:`) is refused,
// said in its place, and never fetched.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { createLlmClient } from '@nodal-agents/llm';
import type { ProviderConfig } from '@nodal-agents/llm';
import { MODEL_REQUEST_MAX_IMAGES } from '@nodal-agents/shared';
import type { ModelAttachmentInput } from '@nodal-agents/tools';
import { buildTestPdf } from '@nodal-agents/test-kit';
import { hydrateForLlm } from '../../job/model-images.ts';

// Provider calls leave through packages/llm's own transport (#609): routed to
// the global fetch stubbed below, the network boundary.
vi.mock('../../../../../packages/llm/src/transport.ts', () => ({
  providerFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('pixels of a worksheet'),
]);
const B64 = PNG.toString('base64');
const SEES: ModelAttachmentInput = { image: { sees: true }, pdf: { sees: true } };
const BLIND_REASON = 'the model this agent runs (z-ai/glm-5.3) does not take images as input';
const BLIND: ModelAttachmentInput = {
  image: { sees: false, reason: BLIND_REASON },
  pdf: {
    sees: false,
    reason: 'the model this agent runs (z-ai/glm-5.3) does not take PDF documents as input',
  },
};
/**
 * Each provider, and the exact form an image takes in its body: an image block
 * of base64 for Anthropic, an `image_url` data URL for chat completions — never
 * the base64 as text in a tool message.
 */
const PROVIDERS: Array<[string, ProviderConfig, string]> = [
  [
    'anthropic (native)',
    { provider: 'anthropic', model: 'claude-sonnet-5', apiKey: 'k' },
    `"type":"image","source":{"type":"base64","media_type":"image/png","data":"${B64}"}`,
  ],
  [
    'openai-compatible (chat completions)',
    { provider: 'openai-compatible', model: 'local-vision', baseURL: 'http://127.0.0.1:1234/v1' },
    `"type":"image_url","image_url":{"url":"data:image/png;base64,${B64}"}`,
  ],
];

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-model-images-'));
  file = join(dir, 'photo.png');
  await writeFile(file, PNG);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const userWith = (part: unknown): ModelMessage[] => [
  { role: 'user', content: [{ type: 'text', text: 'Look.' }, part] } as ModelMessage,
];
const toolWith = (part: unknown): ModelMessage[] => [
  { role: 'user', content: 'Read it.' },
  {
    role: 'assistant',
    content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'srv__shot', input: {} }],
  },
  {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'srv__shot',
        output: { type: 'content', value: [{ type: 'text', text: 'shot' }, part] },
      },
    ],
  } as ModelMessage,
];

/** Every shape, and whether its image can be delivered (a remote URL is refused). */
const SHAPES: Array<[string, () => ModelMessage[], 'delivered' | 'refused']> = [
  ['person: a channel photo path', () => userWith({ type: 'image', image: file }), 'delivered'],
  ['person: bytes', () => userWith({ type: 'image', image: new Uint8Array(PNG) }), 'delivered'],
  [
    'person: a data: URL',
    () => userWith({ type: 'image', image: `data:image/png;base64,${B64}` }),
    'delivered',
  ],
  [
    'person: base64',
    () => userWith({ type: 'image', image: B64, mediaType: 'image/png' }),
    'delivered',
  ],
  [
    'person: a file part of an image type',
    () => userWith({ type: 'file', data: new Uint8Array(PNG), mediaType: 'image/png' }),
    'delivered',
  ],
  [
    'person: an https: URL',
    () => userWith({ type: 'image', image: 'https://example.com/a.png' }),
    'refused',
  ],
  [
    'person: a URL object',
    () => userWith({ type: 'image', image: new URL('https://example.com/b.png') }),
    'refused',
  ],
  [
    'tool: image-url file:',
    () => toolWith({ type: 'image-url', url: pathToFileURL(file).href }),
    'delivered',
  ],
  [
    'tool: image-url data:',
    () => toolWith({ type: 'image-url', url: `data:image/png;base64,${B64}` }),
    'delivered',
  ],
  [
    'tool: image-data',
    () => toolWith({ type: 'image-data', data: B64, mediaType: 'image/png' }),
    'delivered',
  ],
  [
    'tool: file-data image/png',
    () => toolWith({ type: 'file-data', data: B64, mediaType: 'image/png' }),
    'delivered',
  ],
  [
    'tool: media image/png',
    () => toolWith({ type: 'media', data: B64, mediaType: 'image/png' }),
    'delivered',
  ],
  [
    'tool: image-url https:',
    () => toolWith({ type: 'image-url', url: 'https://example.com/c.png' }),
    'refused',
  ],
];

/** The body each provider's real builder sends for these messages; nothing is downloaded. */
async function wireBody(config: ProviderConfig, messages: ModelMessage[]): Promise<string> {
  const bodies: string[] = [];
  const downloads: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (typeof init?.body !== 'string') {
        downloads.push(String(input));
        throw new Error(`a download was attempted: ${String(input)}`);
      }
      bodies.push(init.body);
      return new Response(JSON.stringify({ error: { message: 'stub' } }), { status: 400 });
    }),
  );
  await createLlmClient(config)
    .generateText({ system: 's', messages })
    .catch(() => undefined);
  vi.unstubAllGlobals();
  expect(downloads, 'the SDK fetched an image URL').toEqual([]);
  const body = bodies[0];
  if (body === undefined) throw new Error(`${config.provider}: no request was sent`);
  return body;
}

describe('every image shape, at the wire @cap:travailler-sur-des-fichiers/moteur', () => {
  for (const [providerName, config, imageOnTheWire] of PROVIDERS) {
    describe(providerName, () => {
      it.each(SHAPES)('%s — a model that sees', async (_n, make, fate) => {
        const body = await wireBody(config, await hydrateForLlm(make(), SEES, new Map()));
        if (fate === 'delivered') {
          // The image's bytes reach the provider, once, as an image.
          expect(body).toContain(imageOnTheWire);
          expect(body.split(B64).length - 1).toBe(1);
          expect(body).not.toContain('[image-url]');
        } else {
          expect(body).toContain('is not sent: Nodal passes an image to a model as bytes');
          expect(body).not.toContain('"type":"image"');
          expect(body).not.toContain('image_url');
        }
      });

      it.each(SHAPES)('%s — a model that does not see', async (_n, make) => {
        const body = await wireBody(config, await hydrateForLlm(make(), BLIND, new Map()));
        expect(body).not.toContain(B64);
        expect(body).not.toContain('"type":"image"');
        expect(body).not.toContain('image_url');
        expect(body).toContain(BLIND_REASON);
      });
    });
  }

  it('a file part that is not an image is left alone', async () => {
    const pdf = { type: 'file', data: new Uint8Array([1, 2]), mediaType: 'application/pdf' };
    const msgs = userWith(pdf);
    expect(await hydrateForLlm(msgs, BLIND, new Map())).toBe(msgs);
  });

  it('a string no image can be read from is said, never passed on', async () => {
    const msgs = userWith({ type: 'image', image: 'blob:https://example.com/1234' });
    const out = JSON.stringify(await hydrateForLlm(msgs, SEES, new Map()));
    expect(out).toContain(
      '[An image part holds no image Nodal can read (blob:https://example.com/1234)',
    );
    expect(out).not.toContain('"type":"image"');
  });

  it('every inline shape counts toward the budget, on its bytes', async () => {
    const value = Array.from({ length: MODEL_REQUEST_MAX_IMAGES + 3 }, (_, k) =>
      k % 3 === 0
        ? { type: 'image-data', data: B64, mediaType: 'image/png' }
        : k % 3 === 1
          ? { type: 'file-data', data: B64, mediaType: 'image/png' }
          : { type: 'image-url', url: `data:image/png;base64,${B64}` },
    );
    const msgs: ModelMessage[] = [
      { role: 'user', content: 'Read them.' },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'srv__shots', input: {} }],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'srv__shots',
            output: { type: 'content', value },
          },
        ],
      } as ModelMessage,
    ];
    const body = await wireBody(PROVIDERS[1]![1], await hydrateForLlm(msgs, SEES, new Map()));
    expect(body.split('"type":"image_url"').length - 1).toBe(MODEL_REQUEST_MAX_IMAGES);
    expect(body.split('[An earlier image (image/png').length - 1).toBe(3);
    expect(body).toContain('It was not kept as a file, so it cannot be read again.');
  });
});

// #903: a PDF is one more file of the same inventory, with its own capability,
// spending the same budget a page per image.
describe('a PDF of the transcript @cap:travailler-sur-des-fichiers/moteur', () => {
  const PDF = buildTestPdf([{ text: 'Invoice 4217' }, { scanned: 'INVOICE 4217' }]);
  const PDF_B64 = PDF.toString('base64');
  const toolResult = (value: unknown[]): ModelMessage[] => [
    { role: 'user', content: 'Read them.' },
    {
      role: 'assistant',
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'file_read', input: {} }],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'file_read',
          output: { type: 'content', value: [{ type: 'text', text: 'read' }, ...value] },
        },
      ],
    } as ModelMessage,
  ];

  it('a saved PDF reaches Anthropic as a document block, its pages spending the image budget', async () => {
    const pdfPath = join(dir, 'c1-1.pdf');
    await writeFile(pdfPath, PDF);
    // The PDF is the newest file: its 2 pages go first, then 18 of the 19 images.
    const images = Array.from({ length: MODEL_REQUEST_MAX_IMAGES - 1 }, () => ({
      type: 'image-data',
      data: B64,
      mediaType: 'image/png',
    }));
    const msgs = toolResult([...images, { type: 'file-url', url: pathToFileURL(pdfPath).href }]);
    const body = await wireBody(PROVIDERS[0]![1], await hydrateForLlm(msgs, SEES, new Map()));
    expect(body).toContain(
      `"type":"document","source":{"type":"base64","media_type":"application/pdf","data":"${PDF_B64}"}`,
    );
    expect(body.split('"type":"image","source"').length - 1).toBe(MODEL_REQUEST_MAX_IMAGES - 2);
    expect(body.split('[An earlier image (image/png').length - 1).toBe(1);
  });

  it('a model that takes no PDF: the reason in its place, the bytes never read', async () => {
    const msgs = toolResult([{ type: 'file-url', url: pathToFileURL(join(dir, 'gone.pdf')).href }]);
    const body = await wireBody(PROVIDERS[0]![1], await hydrateForLlm(msgs, BLIND, new Map()));
    expect(body).toContain(
      'A PDF document was attached to this result, saved at ' +
        JSON.stringify(join(dir, 'gone.pdf')).slice(1, -1) +
        ': not passed to you: the model this agent runs (z-ai/glm-5.3) does not take PDF ' +
        'documents as input.',
    );
  });

  it('a .pdf whose bytes are an image is sent as the image it is', async () => {
    const lying = join(dir, 'c2-1.pdf');
    await writeFile(lying, PNG);
    const msgs = toolResult([{ type: 'file-url', url: pathToFileURL(lying).href }]);
    const body = await wireBody(PROVIDERS[0]![1], await hydrateForLlm(msgs, SEES, new Map()));
    expect(body).toContain(`"type":"image","source":{"type":"base64","media_type":"image/png"`);
    expect(body).not.toContain('application/pdf');
  });
});
