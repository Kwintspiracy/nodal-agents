// job/model-images.ts — every image of a job's request, from the transcript to
// the bytes a model receives. One place for both kinds of image a job holds:
//
//   - an image the PERSON sent (a channel photo): a user-message part whose
//     `image` is the absolute path of the file the channel handler saved;
//   - an image a TOOL fetched (`ctx.attachImage`: file_read on an image file,
//     an MCP block): saved by `saveToolImages` beside the channel photos, in the
//     entity's shared folder, and kept in the tool result as an `image-url`
//     part holding that file's `file:` URL.
//
// The transcript (`agent_jobs.messages`, every `job_checkpoints` save) keeps
// paths, never bytes (review of #798, pass 2: twelve 1 MiB MCP images wrote
// ~13 MiB into each checkpoint). `hydrateForLlm` turns the paths into bytes at
// request time, for a model that sees, within the request's image budget
// (`MODEL_REQUEST_MAX_IMAGES`, `MODEL_REQUEST_MAX_IMAGE_BYTES`,
// @nodal-agents/shared): the images the person sent first, then the ones tools
// fetched, newest first within each; an image past the budget is replaced by a
// sentence that names its file, which the agent can read again.

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import { MODEL_REQUEST_MAX_IMAGES, MODEL_REQUEST_MAX_IMAGE_BYTES } from '@nodal-agents/shared';
import {
  MODEL_IMAGE_MEDIA_TYPES,
  formatBytes,
  sniffImageMediaType,
  type ModelImageInput,
  type ToolImage,
} from '@nodal-agents/tools';

const EXTENSION_OF: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/** The folder a job's tool images are saved in, beside the channel photos. */
export function toolImagesDir(sharedFolder: string, jobId: string): string {
  return join(sharedFolder, 'tools', jobId);
}

/**
 * Save the images one call attached, and return the parts its tool result
 * keeps: one `image-url` part per image, its `file:` URL. The bytes go to the
 * disk once; no row ever holds them.
 */
export async function saveToolImages(
  dir: string,
  toolCallId: string,
  images: readonly ToolImage[],
): Promise<Array<{ type: 'image-url'; url: string }>> {
  await mkdir(dir, { recursive: true });
  const parts: Array<{ type: 'image-url'; url: string }> = [];
  for (const [k, image] of images.entries()) {
    const ext = EXTENSION_OF[image.mediaType] ?? 'img';
    const path = join(dir, `${toolCallId.replace(/[^\w.-]/g, '_')}-${k + 1}.${ext}`);
    await writeFile(path, Buffer.from(image.data, 'base64'));
    parts.push({ type: 'image-url', url: pathToFileURL(path).href });
  }
  return parts;
}

/**
 * Guidance handed to an agent whose model takes no image when the person sent
 * one, so the LLM itself decides what to do (routing is its call, never
 * hardcoded): delegate to a teammate that sees, or tell the person. `reason`
 * says which it is — a model known to be text-only, or one Nodal does not know
 * (`modelImageInputFor`) — never the second said as the first.
 */
export function visionRoutingNote(path: string, reason: string): string {
  return (
    `[The user attached an IMAGE (saved at ${path}). It was not passed to you: ${reason}. ` +
    `Decide what to do: if a teammate runs a vision-capable model, DELEGATE this to them — the ` +
    `image travels with the delegation, so just assign them the task (e.g. "describe this image"). ` +
    `If no agent in this workspace can see images, tell the user plainly and suggest switching an ` +
    `agent to a vision model (Claude, Gemini, GPT-4o, or a vision model on OpenRouter). Never ` +
    `pretend to describe an image you cannot see.]`
  );
}

/**
 * Where an image of the transcript is, whatever shape its part has (reviews of
 * #798, passes 3 and 4): a file (a channel photo's path, a tool image's
 * `file:` URL), bytes already inline (`image-data`, `file-data` / `media` of an
 * image type, a `data:` URL, base64, a byte array), a remote URL, or a value
 * no image can be read from. Every image part is one of these: none escapes
 * the inventory, so none reaches a model unseen.
 */
type ImageSource =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; data: Uint8Array; mediaType: string | undefined }
  | { kind: 'remote'; url: string }
  | { kind: 'unreadable'; what: string };

/** A `file:` URL as a path, or null when it is not one a path can be read from. */
function pathOfFileUrl(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

const unreadable = (value: string): ImageSource => ({
  kind: 'unreadable',
  what: value.length > 60 ? `${value.slice(0, 60)}…` : value,
});

/** The source of a string or URL that names an image. */
function sourceOfLocation(location: string, mediaType: string | undefined): ImageSource {
  if (/^data:/i.test(location)) {
    const comma = location.indexOf(',');
    if (comma < 0 || !/;base64,/i.test(location.slice(0, comma + 1))) return unreadable(location);
    const type = /^data:([^;,]+)/i.exec(location)?.[1] ?? mediaType;
    return {
      kind: 'inline',
      data: new Uint8Array(Buffer.from(location.slice(comma + 1), 'base64')),
      mediaType: type,
    };
  }
  if (/^https?:/i.test(location)) return { kind: 'remote', url: location };
  if (/^file:/i.test(location)) {
    const path = pathOfFileUrl(location);
    return path === null ? unreadable(location) : { kind: 'file', path };
  }
  return unreadable(location);
}

/** An image part of a user message: `image` (path, URL, data URL, bytes) or a `file` of an image type. */
function personImageSource(p: unknown): ImageSource | null {
  const part = p as { type?: unknown; image?: unknown; data?: unknown; mediaType?: unknown } | null;
  const mediaType = typeof part?.mediaType === 'string' ? part.mediaType : undefined;
  let value: unknown;
  if (part?.type === 'image') value = part.image;
  else if (part?.type === 'file' && mediaType?.startsWith('image/')) value = part.data;
  else return null;
  if (value instanceof URL) return sourceOfLocation(value.href, mediaType);
  if (value instanceof Uint8Array) return { kind: 'inline', data: value, mediaType };
  if (value instanceof ArrayBuffer)
    return { kind: 'inline', data: new Uint8Array(value), mediaType };
  if (typeof value !== 'string') return unreadable(typeof value);
  // A channel photo: the absolute path its handler saved (telegram, discord),
  // always with its extension. Base64 never holds a dot, even when it starts
  // with `/` as a JPEG's does (`/9j/…`).
  if (isAbsolute(value) && /\.[a-z0-9]{2,5}$/i.test(value)) return { kind: 'file', path: value };
  // A URL (`data:`, `https:`, `file:`, any other scheme: unreadable), else base64.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return sourceOfLocation(value, mediaType);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return unreadable(value);
  return { kind: 'inline', data: new Uint8Array(Buffer.from(value, 'base64')), mediaType };
}

/** An image part of a tool result's `content`: `image-url`, `image-data`, or `file-data` / `media` of an image type. */
function toolImageSource(p: unknown): ImageSource | null {
  const part = p as { type?: unknown; url?: unknown; data?: unknown; mediaType?: unknown } | null;
  const mediaType = typeof part?.mediaType === 'string' ? part.mediaType : undefined;
  if (part?.type === 'image-url') {
    return typeof part.url === 'string'
      ? sourceOfLocation(part.url, mediaType)
      : unreadable('image-url');
  }
  const isImageData =
    part?.type === 'image-data' ||
    ((part?.type === 'file-data' || part?.type === 'media') && mediaType?.startsWith('image/'));
  if (!isImageData) return null;
  return typeof part.data === 'string'
    ? { kind: 'inline', data: new Uint8Array(Buffer.from(part.data, 'base64')), mediaType }
    : unreadable(String(part.type));
}

function typeOfPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPE_OF_EXTENSION[ext];
}

/** Where the agent can find the image again, said in the sentence that replaces it. */
function whereItIs(source: ImageSource): string {
  if (source.kind === 'file') return `It is saved at ${source.path}: read it again if you need it.`;
  if (source.kind === 'remote') return `It is at ${source.url}.`;
  return 'It was not kept as a file, so it cannot be read again.';
}

type Origin = 'person' | 'tool';

interface ImageRef {
  origin: Origin;
  source: ImageSource;
  /** Message index, then the part's place: [partIndex] or [resultIndex, valueIndex]. */
  at: [number, number, number?];
  /** What replaces the part in the request. */
  sent?: unknown;
}

/** Every image of the transcript, in order, whatever the shape of its part. */
function inventory(messages: readonly ModelMessage[]): ImageRef[] {
  const refs: ImageRef[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    if (m.role === 'user') {
      (m.content as unknown[]).forEach((p, j) => {
        const source = personImageSource(p);
        if (source !== null) refs.push({ origin: 'person', source, at: [i, j] });
      });
    }
    if (m.role === 'tool') {
      (m.content as unknown[]).forEach((r, j) => {
        const out = (r as { type?: unknown; output?: { type?: unknown; value?: unknown } }).output;
        if ((r as { type?: unknown }).type !== 'tool-result' || out?.type !== 'content') return;
        if (!Array.isArray(out.value)) return;
        out.value.forEach((v, k) => {
          const source = toolImageSource(v);
          if (source !== null) refs.push({ origin: 'tool', source, at: [i, j, k] });
        });
      });
    }
  });
  return refs;
}

async function sizeOf(path: string, cache: Map<string, Uint8Array>): Promise<number | null> {
  const cached = cache.get(path);
  if (cached) return cached.byteLength;
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

async function bytesOf(path: string, cache: Map<string, Uint8Array>): Promise<Uint8Array | null> {
  const cached = cache.get(path);
  if (cached) return cached;
  try {
    const bytes = new Uint8Array(await readFile(path));
    cache.set(path, bytes);
    return bytes;
  } catch {
    return null;
  }
}

const text = (t: string) => ({ type: 'text' as const, text: t });

/**
 * The ONE wire shape of an image, the form `packages/llm` sends to every
 * provider (`withToolResultImagesAsUserParts` lifts a tool result's
 * `image-data` into a user message): a person's image is an `image` part of
 * bytes, a tool's is an `image-data` part of base64 — both with the type the
 * bytes declare (`sniffImageMediaType`), else the one the part declared. No
 * other shape leaves this module, so there is no shape the wire layer can drop.
 */
function wirePart(origin: Origin, data: Uint8Array, mediaType: string): unknown {
  return origin === 'person'
    ? { type: 'image', image: data, mediaType }
    : { type: 'image-data', data: Buffer.from(data).toString('base64'), mediaType };
}

/**
 * The request's messages, its images resolved, WITHOUT touching the stored
 * transcript. Every image part counts, whatever its shape (`inventory`), and
 * leaves in the one wire shape (`wirePart`).
 *
 * For a model that sees: the person's images first, then the tools', newest
 * first within each, while they fit the budget (`MODEL_REQUEST_MAX_IMAGES`,
 * `MODEL_REQUEST_MAX_IMAGE_BYTES`, counted on the bytes sent). An image past
 * the budget is replaced by a sentence saying where it is. A remote image
 * (`https:`) is not sent and not counted: Nodal passes an image to a model as
 * bytes and does not fetch a URL for it, so it says so in its place. An image
 * that cannot be read, or whose format models do not take, is said too.
 *
 * For a model that does not see, every image is replaced by the reason.
 * Returns the same array when the transcript holds no image.
 */
export async function hydrateForLlm(
  messages: ModelMessage[],
  input: ModelImageInput,
  cache: Map<string, Uint8Array>,
): Promise<ModelMessage[]> {
  const refs = inventory(messages);
  if (refs.length === 0) return messages;

  if (!input.sees) {
    for (const r of refs) {
      const where =
        r.source.kind === 'file'
          ? `saved at ${r.source.path}`
          : r.source.kind === 'remote'
            ? `at ${r.source.url}`
            : 'not kept as a file';
      r.sent =
        r.origin === 'person'
          ? text(visionRoutingNote(where, input.reason))
          : text(
              `[An image was attached to this result, ${where}: not passed to you: ${input.reason}.]`,
            );
    }
  } else {
    let count = 0;
    let bytes = 0;
    const order = [
      ...refs.filter((r) => r.origin === 'person').reverse(),
      ...refs.filter((r) => r.origin === 'tool').reverse(),
    ];
    for (const r of order) {
      const source = r.source;
      if (source.kind === 'remote') {
        r.sent = text(
          `[An image at ${source.url} is not sent: Nodal passes an image to a model as bytes, ` +
            'and does not fetch a URL for it.]',
        );
        continue;
      }
      if (source.kind === 'unreadable') {
        r.sent = text(
          `[An image part holds no image Nodal can read (${source.what}); it is not sent.]`,
        );
        continue;
      }
      const size =
        source.kind === 'file' ? await sizeOf(source.path, cache) : source.data.byteLength;
      if (size === null) {
        r.sent = text(`[An image could not be loaded from ${(source as { path: string }).path}.]`);
        continue;
      }
      const declared = source.kind === 'file' ? typeOfPath(source.path) : source.mediaType;
      if (count >= MODEL_REQUEST_MAX_IMAGES || bytes + size > MODEL_REQUEST_MAX_IMAGE_BYTES) {
        r.sent = text(
          `[An earlier image (${declared ?? 'image'}, ${formatBytes(size)}) is no longer sent: a ` +
            `request carries ${MODEL_REQUEST_MAX_IMAGES} images and ` +
            `${formatBytes(MODEL_REQUEST_MAX_IMAGE_BYTES)} of them at most, the ones the person ` +
            `sent first, then the newest. ${whereItIs(source)}]`,
        );
        continue;
      }
      const data = source.kind === 'file' ? await bytesOf(source.path, cache) : source.data;
      if (data === null) {
        r.sent = text(`[An image could not be loaded from ${(source as { path: string }).path}.]`);
        continue;
      }
      const mediaType = sniffImageMediaType(data.subarray(0, 16)) ?? declared;
      if (mediaType === undefined || !MODEL_IMAGE_MEDIA_TYPES.includes(mediaType)) {
        r.sent = text(
          `[An image (${mediaType ?? 'of an unknown format'}) is not sent: models take ` +
            `${MODEL_IMAGE_MEDIA_TYPES.join(', ')}. ${whereItIs(source)}]`,
        );
        continue;
      }
      count += 1;
      bytes += data.byteLength;
      r.sent = wirePart(r.origin, data, mediaType);
    }
  }

  // Rebuild only the messages that hold an image; the others keep their identity.
  const byMessage = new Map<number, ImageRef[]>();
  for (const r of refs) byMessage.set(r.at[0], [...(byMessage.get(r.at[0]) ?? []), r]);
  return messages.map((m, i) => {
    const here = byMessage.get(i);
    if (!here) return m;
    const content = [...(m.content as unknown[])];
    for (const r of here) {
      const [, j, k] = r.at;
      if (k === undefined) {
        content[j] = r.sent;
        continue;
      }
      const result = content[j] as { output: { type: 'content'; value: unknown[] } };
      const value = [...result.output.value];
      value[k] = r.sent;
      content[j] = { ...result, output: { ...result.output, value } };
    }
    return { ...m, content } as ModelMessage;
  });
}
