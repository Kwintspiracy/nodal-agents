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
import { join } from 'node:path';
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

/** A person's image: a user-message `image` part holding a local path. */
function personImagePath(p: unknown): string | null {
  const part = p as { type?: unknown; image?: unknown } | null;
  if (part?.type !== 'image' || typeof part.image !== 'string') return null;
  return /^(https?:|data:)/i.test(part.image) ? null : part.image;
}

/** A tool's image: an `image-url` part of a tool result holding a `file:` URL. */
function toolImagePath(p: unknown): string | null {
  const part = p as { type?: unknown; url?: unknown } | null;
  if (part?.type !== 'image-url' || typeof part.url !== 'string') return null;
  if (!part.url.startsWith('file:')) return null;
  try {
    return fileURLToPath(part.url);
  } catch {
    return null;
  }
}

function typeOfPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPE_OF_EXTENSION[ext] ?? 'image';
}

type Origin = 'person' | 'tool';

interface ImageRef {
  origin: Origin;
  path: string;
  /** Message index, then the part's place: [partIndex] or [resultIndex, valueIndex]. */
  at: [number, number, number?];
  /** What replaces the part in the request. */
  sent?: unknown;
}

/** Every image of the transcript, in order. */
function inventory(messages: readonly ModelMessage[]): ImageRef[] {
  const refs: ImageRef[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    if (m.role === 'user') {
      (m.content as unknown[]).forEach((p, j) => {
        const path = personImagePath(p);
        if (path !== null) refs.push({ origin: 'person', path, at: [i, j] });
      });
    }
    if (m.role === 'tool') {
      (m.content as unknown[]).forEach((r, j) => {
        const out = (r as { type?: unknown; output?: { type?: unknown; value?: unknown } }).output;
        if ((r as { type?: unknown }).type !== 'tool-result' || out?.type !== 'content') return;
        if (!Array.isArray(out.value)) return;
        out.value.forEach((v, k) => {
          const path = toolImagePath(v);
          if (path !== null) refs.push({ origin: 'tool', path, at: [i, j, k] });
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
 * transcript. For a model that sees, the person's images first, then the
 * tools', newest first within each, while they fit the budget: those are read
 * into bytes; any other is replaced by a sentence naming its file. For a model
 * that does not, every image is replaced by the reason. Returns the same array
 * when the transcript holds no image.
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
      r.sent =
        r.origin === 'person'
          ? text(visionRoutingNote(r.path, input.reason))
          : text(
              `[An image (${typeOfPath(r.path)}) was attached to this result, saved at ${r.path}: ` +
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
      const size = await sizeOf(r.path, cache);
      const fits =
        size !== null &&
        count < MODEL_REQUEST_MAX_IMAGES &&
        bytes + size <= MODEL_REQUEST_MAX_IMAGE_BYTES;
      const data = fits ? await bytesOf(r.path, cache) : null;
      if (size === null || (fits && data === null)) {
        r.sent = text(`[An image could not be loaded from ${r.path}.]`);
        continue;
      }
      if (!fits || data === null) {
        r.sent = text(
          `[An earlier image (${typeOfPath(r.path)}, ${formatBytes(size)}) is no longer sent: a ` +
            `request carries ${MODEL_REQUEST_MAX_IMAGES} images and ` +
            `${formatBytes(MODEL_REQUEST_MAX_IMAGE_BYTES)} of them at most, the ones the person ` +
            `sent first, then the newest. It is saved at ${r.path}: read it again if you need it.]`,
        );
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
              mediaType: typeOfPath(r.path),
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
