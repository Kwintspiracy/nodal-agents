// model-images.test.ts — hydrateForLlm reads EVERY shape an image part of a
// transcript can take (review of #798, pass 3): the note for a model that does
// not see, the budget for one that does. A shape the inventory did not know
// went to a model that does not see untouched, and escaped the budget of one
// that does.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { MODEL_REQUEST_MAX_IMAGES } from '@nodal-agents/shared';
import type { ModelImageInput } from '@nodal-agents/tools';
import { hydrateForLlm } from '../../job/model-images.ts';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('pixels'),
]);
const B64 = PNG.toString('base64');
const SEES: ModelImageInput = { sees: true };
const BLIND: ModelImageInput = {
  sees: false,
  reason: 'the model this agent runs (z-ai/glm-5.3) does not take images as input',
};

let dir: string;
let file: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-model-images-'));
  file = join(dir, 'photo.png');
  await writeFile(file, PNG);
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

/** The parts of the request, flattened: a user message's, a tool result's content. */
function partsOf(messages: ModelMessage[]): unknown[] {
  return messages.flatMap((m) => {
    if (!Array.isArray(m.content)) return [];
    if (m.role !== 'tool') return m.content as unknown[];
    return (m.content as Array<{ output?: { value?: unknown } }>).flatMap((r) =>
      Array.isArray(r.output?.value) ? (r.output.value as unknown[]) : [],
    );
  });
}
const isImage = (p: unknown): boolean =>
  ['image', 'image-data', 'image-url', 'file-data', 'media'].includes(
    (p as { type?: string }).type ?? '',
  ) ||
  ((p as { type?: string }).type === 'file' &&
    String((p as { mediaType?: string }).mediaType).startsWith('image/'));

// Every shape: where it lives, and the part.
const SHAPES: Array<[string, () => ModelMessage[]]> = [
  ['person: a channel photo path', () => userWith({ type: 'image', image: file })],
  ['person: bytes', () => userWith({ type: 'image', image: new Uint8Array(PNG) })],
  ['person: a data: URL', () => userWith({ type: 'image', image: `data:image/png;base64,${B64}` })],
  ['person: base64', () => userWith({ type: 'image', image: B64, mediaType: 'image/png' })],
  ['person: an https: URL', () => userWith({ type: 'image', image: 'https://example.com/a.png' })],
  [
    'person: a URL object',
    () => userWith({ type: 'image', image: new URL('https://example.com/b.png') }),
  ],
  [
    'person: a file part of an image type',
    () => userWith({ type: 'file', data: new Uint8Array(PNG), mediaType: 'image/png' }),
  ],
  ['tool: image-url file:', () => toolWith({ type: 'image-url', url: pathToFileURL(file).href })],
  [
    'tool: image-url data:',
    () => toolWith({ type: 'image-url', url: `data:image/png;base64,${B64}` }),
  ],
  [
    'tool: image-url https:',
    () => toolWith({ type: 'image-url', url: 'https://example.com/c.png' }),
  ],
  ['tool: image-data', () => toolWith({ type: 'image-data', data: B64, mediaType: 'image/png' })],
  [
    'tool: file-data image/png',
    () => toolWith({ type: 'file-data', data: B64, mediaType: 'image/png' }),
  ],
  ['tool: media image/png', () => toolWith({ type: 'media', data: B64, mediaType: 'image/png' })],
];

describe('hydrateForLlm reads every image shape @cap:travailler-sur-des-fichiers/moteur', () => {
  it.each(SHAPES)(
    '%s — a model that does not see gets the reason, never the image',
    async (_n, make) => {
      const out = await hydrateForLlm(make(), BLIND, new Map());
      expect(partsOf(out).filter(isImage)).toEqual([]);
      expect(JSON.stringify(out)).not.toContain(B64);
      expect(JSON.stringify(out)).toContain(BLIND.reason);
    },
  );

  it.each(SHAPES)('%s — a model that sees gets the image', async (_n, make) => {
    const out = await hydrateForLlm(make(), SEES, new Map());
    expect(partsOf(out).filter(isImage)).toHaveLength(1);
  });

  it('a file part that is not an image is left alone', async () => {
    const pdf = { type: 'file', data: new Uint8Array([1, 2]), mediaType: 'application/pdf' };
    const msgs = userWith(pdf);
    expect(await hydrateForLlm(msgs, BLIND, new Map())).toBe(msgs);
  });

  it('every shape counts toward the budget of a model that sees', async () => {
    // One inline tool image per shape that carries bytes, repeated past the count.
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
    const out = await hydrateForLlm(msgs, SEES, new Map());
    const parts = partsOf(out);
    expect(parts.filter(isImage)).toHaveLength(MODEL_REQUEST_MAX_IMAGES);
    const said = parts.filter((p) =>
      String((p as { text?: string }).text).startsWith('[An earlier image'),
    );
    expect(said).toHaveLength(3);
    // Not kept as a file: the sentence says it cannot be read again.
    expect((said[0] as { text: string }).text).toContain(
      'It was not kept as a file, so it cannot be read again.',
    );
  });
});
