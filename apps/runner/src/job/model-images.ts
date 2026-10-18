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
import { formatBytes, type ModelImageInput, type ToolImage } from '@nodal-agents/tools';

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
 * Where an image of the transcript is, whatever shape its part has (review of
 * #798, pass 3): a file (a channel photo's path, a tool image's `file:` URL),
 * bytes already inline (`image-data`, `file-data` / `media` of an image type,
 * a `data:` URL, a byte array), or a remote URL the provider fetches itself.
 */
type ImageSource =
  | { kind: 'file'; path: string }
  | { kind: 'inline'; bytes: number; mediaType: string | undefined }
  | { kind: 'remote'; url: string };

/** Decoded size of base64, without decoding it. */
function base64Size(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A `file:` URL as a path, or null when it is not one a path can be read from. */
function pathOfFileUrl(url: string): string | null {
  try {
    return fileURLToPath(url);
  } catch {
    return null;
  }
}

/** The source of a string or URL that names an image: a file, inline data, or remote. */
function sourceOfLocation(location: string, mediaType: string | undefined): ImageSource | null {
  if (/^data:/i.test(location)) {
    const comma = location.indexOf(',');
    const type = /^data:([^;,]+)/i.exec(location)?.[1] ?? mediaType;
    return { kind: 'inline', bytes: base64Size(location.slice(comma + 1)), mediaType: type };
  }
  if (/^https?:/i.test(location)) return { kind: 'remote', url: location };
  if (/^file:/i.test(location)) {
    const path = pathOfFileUrl(location);
    return path === null ? null : { kind: 'file', path };
  }
  return null;
}

function byteLength(data: unknown): number | null {
  if (data instanceof Uint8Array) return data.byteLength;
  if (data instanceof ArrayBuffer) return data.byteLength;
  return null;
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
  const size = byteLength(value);
  if (size !== null) return { kind: 'inline', bytes: size, mediaType };
  if (typeof value !== 'string') return null;
  // A channel photo: the absolute path its handler saved (telegram, discord),
  // always with its extension. Base64 never holds a dot, even when it starts
  // with `/` as a JPEG's does (`/9j/…`).
  if (isAbsolute(value) && /\.[a-z0-9]{2,5}$/i.test(value)) return { kind: 'file', path: value };
  // A URL (`data:`, `https:`, `file:`), else base64 bytes.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return sourceOfLocation(value, mediaType);
  return { kind: 'inline', bytes: base64Size(value), mediaType };
}

/** An image part of a tool result's `content`: `image-url`, `image-data`, or `file-data` / `media` of an image type. */
function toolImageSource(p: unknown): ImageSource | null {
  const part = p as { type?: unknown; url?: unknown; data?: unknown; mediaType?: unknown } | null;
  const mediaType = typeof part?.mediaType === 'string' ? part.mediaType : undefined;
  if (part?.type === 'image-url' && typeof part.url === 'string') {
    return sourceOfLocation(part.url, mediaType);
  }
  const isImageData =
    part?.type === 'image-data' ||
    ((part?.type === 'file-data' || part?.type === 'media') && mediaType?.startsWith('image/'));
  if (isImageData && typeof part.data === 'string') {
    return { kind: 'inline', bytes: base64Size(part.data), mediaType };
  }
  return null;
}

function typeOfPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPE_OF_EXTENSION[ext] ?? 'image';
}

function typeOf(source: ImageSource): string {
  if (source.kind === 'file') return typeOfPath(source.path);
  if (source.kind === 'inline') return source.mediaType ?? 'image';
  return 'image';
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
  /** The part as the transcript holds it. */
  part: unknown;
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
        if (source !== null) refs.push({ origin: 'person', source, part: p, at: [i, j] });
      });
    }
    if (m.role === 'tool') {
      (m.content as unknown[]).forEach((r, j) => {
        const out = (r as { type?: unknown; output?: { type?: unknown; value?: unknown } }).output;
        if ((r as { type?: unknown }).type !== 'tool-result' || out?.type !== 'content') return;
        if (!Array.isArray(out.value)) return;
        out.value.forEach((v, k) => {
          const source = toolImageSource(v);
          if (source !== null) refs.push({ origin: 'tool', source, part: v, at: [i, j, k] });
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
 * The request's messages, its images resolved, WITHOUT touching the stored
 * transcript. Every image part counts, whatever its shape (`inventory`). For a
 * model that sees, the person's images first, then the tools', newest first
 * within each, while they fit the budget: a file is read into bytes, an inline
 * or remote image is sent as it is; any other is replaced by a sentence saying
 * where it is. For a model that does not, every image is replaced by the
 * reason. Returns the same array when the transcript holds no image.
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
              `[An image (${typeOf(r.source)}) was attached to this result, ${where}: ` +
                `not passed to you: ${input.reason}.]`,
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
      const size =
        source.kind === 'file'
          ? await sizeOf(source.path, cache)
          : source.kind === 'inline'
            ? source.bytes
            : 0;
      const fits =
        size !== null &&
        count < MODEL_REQUEST_MAX_IMAGES &&
        bytes + size <= MODEL_REQUEST_MAX_IMAGE_BYTES;
      if (size === null) {
        r.sent = text(`[An image could not be loaded from ${(source as { path: string }).path}.]`);
        continue;
      }
      if (!fits) {
        r.sent = text(
          `[An earlier image (${typeOf(source)}, ${formatBytes(size)}) is no longer sent: a ` +
            `request carries ${MODEL_REQUEST_MAX_IMAGES} images and ` +
            `${formatBytes(MODEL_REQUEST_MAX_IMAGE_BYTES)} of them at most, the ones the person ` +
            `sent first, then the newest. ${whereItIs(source)}]`,
        );
        continue;
      }
      if (source.kind !== 'file') {
        // Inline or remote: already in a form the request carries.
        count += 1;
        bytes += size;
        r.sent = r.part;
        continue;
      }
      const data = await bytesOf(source.path, cache);
      if (data === null) {
        r.sent = text(`[An image could not be loaded from ${source.path}.]`);
        continue;
      }
      count += 1;
      bytes += data.byteLength;
      r.sent =
        r.origin === 'person'
          ? { type: 'image', image: data }
          : {
              type: 'image-data',
              data: Buffer.from(data).toString('base64'),
              mediaType: typeOfPath(source.path),
            };
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
