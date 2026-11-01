// job/model-images.ts — every file of a job's request a model reads as itself
// (an image, a PDF document), from the transcript to the bytes a model
// receives. One place for every kind of file a job holds:
//
//   - an image the PERSON sent (a channel photo): a user-message part whose
//     `image` is the `file:` URL of the file the channel intake saved
//     (channels/inbound-files.ts), or its absolute path (Discord, and the
//     Telegram photos saved before #899);
//   - a file a TOOL fetched (`ctx.attachForModel`: file_read on an image or a
//     PDF, an MCP image block): saved by `saveToolAttachments` beside the
//     channel photos, in the entity's shared folder, and kept in the tool
//     result as an `image-url` part (an image) or a `file-url` part (a PDF)
//     holding that file's `file:` URL.
//
// The transcript (`agent_jobs.messages`, every `job_checkpoints` save) keeps
// paths, never bytes (review of #798, pass 2: twelve 1 MiB MCP images wrote
// ~13 MiB into each checkpoint). `hydrateForLlm` turns the paths into bytes at
// request time, for a model that takes that kind of file, within the request's
// budget (`MODEL_REQUEST_MAX_IMAGES`, a PDF counting its pages, and
// `MODEL_REQUEST_MAX_IMAGE_BYTES`, @nodal-agents/shared): the images the person
// sent first, then the files tools fetched, newest first within each; a file
// past the budget is replaced by a sentence that names it, which the agent can
// read again.

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ModelMessage } from 'ai';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { MODEL_REQUEST_MAX_IMAGES, MODEL_REQUEST_MAX_IMAGE_BYTES } from '@nodal-agents/shared';
import {
  MODEL_IMAGE_MEDIA_TYPES,
  PDF_MEDIA_TYPE,
  attachmentKind,
  countPdfPages,
  formatBytes,
  recordPlatformWrites,
  sniffAttachmentMediaType,
  type ModelAttachmentInput,
  type ToolAttachment,
} from '@nodal-agents/tools';

const EXTENSION_OF: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  [PDF_MEDIA_TYPE]: 'pdf',
};
const TYPE_OF_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: PDF_MEDIA_TYPE,
};

/** The folder a job's tool files are saved in, beside the channel photos. */
export function toolImagesDir(sharedFolder: string, jobId: string): string {
  return join(sharedFolder, 'tools', jobId);
}

/** The part a tool result keeps for a saved file: its `file:` URL. */
export type SavedAttachmentPart =
  | { type: 'image-url'; url: string }
  | { type: 'file-url'; url: string };

/**
 * Save the files one call attached, and return the parts its tool result
 * keeps: one part per file, its `file:` URL — `image-url` for an image,
 * `file-url` for a document. The bytes go to the disk once; no row ever holds
 * them.
 *
 * Each file is a write the platform made for `jobId` (#913), recorded as that
 * job's write by the one record the tools use (`recordPlatformWrites`), after
 * every file is written and before any part is returned: a record never names
 * a file that is not there, and a file the record could not take is never
 * handed to the model (the caller says none was saved). Throws.
 */
export async function saveToolAttachments(
  owner: { db: AnyDrizzleDb; jobId: string },
  dir: string,
  toolCallId: string,
  attachments: readonly ToolAttachment[],
): Promise<SavedAttachmentPart[]> {
  await mkdir(dir, { recursive: true });
  const parts: SavedAttachmentPart[] = [];
  const written: Array<{ path: string; sha256: string }> = [];
  for (const [k, attachment] of attachments.entries()) {
    const ext = EXTENSION_OF[attachment.mediaType] ?? 'bin';
    const path = join(dir, `${toolCallId.replace(/[^\w.-]/g, '_')}-${k + 1}.${ext}`);
    const bytes = Buffer.from(attachment.data, 'base64');
    await writeFile(path, bytes);
    written.push({ path, sha256: createHash('sha256').update(bytes).digest('hex') });
    const url = pathToFileURL(path).href;
    parts.push(
      attachmentKind(attachment.mediaType) === 'image'
        ? { type: 'image-url', url }
        : { type: 'file-url', url },
    );
  }
  await recordPlatformWrites({ db: owner.db, jobId: owner.jobId, files: written });
  return parts;
}

/**
 * Guidance handed to an agent whose model takes no image when the person sent
 * one, so the LLM itself decides what to do (routing is its call, never
 * hardcoded): delegate to a teammate that sees, or tell the person. `reason`
 * says which it is — a model known to be text-only, or one Nodal does not know
 * (`modelImageInputFor`) — never the second said as the first. `where` is the
 * whole phrase that says where the image is (`saved at <path>`, `at <url>`,
 * `not kept as a file`): the note adds no words of its own around it (#913).
 */
export function visionRoutingNote(where: string, reason: string): string {
  return (
    `[The user attached an IMAGE (${where}). It was not passed to you: ${reason}. ` +
    `Decide what to do: if a teammate runs a vision-capable model, DELEGATE this to them — the ` +
    `image travels with the delegation, so just assign them the task (e.g. "describe this image"). ` +
    `If no agent in this workspace can see images, tell the user plainly and suggest switching an ` +
    `agent to a vision model (Claude, Gemini, GPT-4o, or a vision model on OpenRouter). Never ` +
    `pretend to describe an image you cannot see.]`
  );
}

/**
 * Where a file of the transcript is, whatever shape its part has (reviews of
 * #798, passes 3 and 4): a file (a channel photo's path, a tool file's `file:`
 * URL), bytes already inline (`image-data`, `file-data` / `media`, a `data:`
 * URL, base64, a byte array), a remote URL, or a value no file can be read
 * from. Every image or document part is one of these: none escapes the
 * inventory, so none reaches a model unseen.
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

/** The source of a string or URL that names a file. */
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
  // A channel photo as an absolute path (discord, and telegram before #899),
  // always with its extension. Base64 never holds a dot, even when it starts
  // with `/` as a JPEG's does (`/9j/…`). The channel intake writes a `file:`
  // URL instead, read below whatever the file's name (review of #902).
  if (isAbsolute(value) && /\.[a-z0-9]{2,5}$/i.test(value)) return { kind: 'file', path: value };
  // A URL (`data:`, `https:`, `file:`, any other scheme: unreadable), else base64.
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return sourceOfLocation(value, mediaType);
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) return unreadable(value);
  return { kind: 'inline', data: new Uint8Array(Buffer.from(value, 'base64')), mediaType };
}

/**
 * A file part of a tool result's `content`: `image-url` / `file-url` (a saved
 * file), `image-data`, or `file-data` / `media` (bytes inline, an image or a
 * document). The part type says which kind it was declared as; the bytes have
 * the last word (`hydrateForLlm`).
 */
function toolFileSource(p: unknown): ImageSource | null {
  const part = p as { type?: unknown; url?: unknown; data?: unknown; mediaType?: unknown } | null;
  const mediaType = typeof part?.mediaType === 'string' ? part.mediaType : undefined;
  if (part?.type === 'image-url' || part?.type === 'file-url') {
    return typeof part.url === 'string'
      ? sourceOfLocation(part.url, mediaType)
      : unreadable(String(part.type));
  }
  const isInline =
    part?.type === 'image-data' || part?.type === 'file-data' || part?.type === 'media';
  if (!isInline) return null;
  return typeof part.data === 'string'
    ? { kind: 'inline', data: new Uint8Array(Buffer.from(part.data, 'base64')), mediaType }
    : unreadable(String(part.type));
}

function typeOfPath(path: string): string | undefined {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return TYPE_OF_EXTENSION[ext];
}

/** Where the agent can find the file again, said in the sentence that replaces it. */
function whereItIs(source: ImageSource): string {
  if (source.kind === 'file') return `It is saved at ${source.path}: read it again if you need it.`;
  if (source.kind === 'remote') return `It is at ${source.url}.`;
  return 'It was not kept as a file, so it cannot be read again.';
}

type Origin = 'person' | 'tool';
type Kind = keyof ModelAttachmentInput;

/** How a kind of file is named in the sentence that replaces it. */
const NOUN: Readonly<Record<Kind, string>> = { image: 'image', pdf: 'PDF document' };
const AN: Readonly<Record<Kind, string>> = { image: 'An image', pdf: 'A PDF document' };

interface ImageRef {
  origin: Origin;
  source: ImageSource;
  /**
   * The kind the part declares: an image for a person's image and a tool's
   * `image-*` part; for a tool's `file-*` / `media` part, its media type or
   * its file's extension. The bytes, once read, have the last word.
   */
  declared: Kind;
  /** Message index, then the part's place: [partIndex] or [resultIndex, valueIndex]. */
  at: [number, number, number?];
  /** What replaces the part in the request. */
  sent?: unknown;
}

/** The kind a tool's part declares (`ImageRef.declared`). */
function declaredKind(part: unknown, source: ImageSource): Kind {
  const p = part as { type?: unknown; mediaType?: unknown } | null;
  if (p?.type === 'image-url' || p?.type === 'image-data') return 'image';
  const type =
    typeof p?.mediaType === 'string'
      ? p.mediaType
      : source.kind === 'file'
        ? typeOfPath(source.path)
        : source.kind === 'inline'
          ? source.mediaType
          : undefined;
  return type === undefined ? 'image' : (attachmentKind(type) ?? 'image');
}

/** Every image and document of the transcript, in order, whatever the shape of its part. */
function inventory(messages: readonly ModelMessage[]): ImageRef[] {
  const refs: ImageRef[] = [];
  messages.forEach((m, i) => {
    if (!Array.isArray(m.content)) return;
    if (m.role === 'user') {
      (m.content as unknown[]).forEach((p, j) => {
        const source = personImageSource(p);
        if (source !== null) refs.push({ origin: 'person', source, declared: 'image', at: [i, j] });
      });
    }
    if (m.role === 'tool') {
      (m.content as unknown[]).forEach((r, j) => {
        const out = (r as { type?: unknown; output?: { type?: unknown; value?: unknown } }).output;
        if ((r as { type?: unknown }).type !== 'tool-result' || out?.type !== 'content') return;
        if (!Array.isArray(out.value)) return;
        out.value.forEach((v, k) => {
          const source = toolFileSource(v);
          if (source !== null) {
            refs.push({ origin: 'tool', source, declared: declaredKind(v, source), at: [i, j, k] });
          }
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

/**
 * A PDF's pages, counted once per job and file (`pageCache`, keyed by the
 * path, or by nothing for inline bytes): the budget spends them on every turn.
 */
async function pagesOf(
  source: ImageSource,
  data: Uint8Array,
  pageCache: Map<string, number | string>,
): Promise<{ pages: number } | { error: string }> {
  const key = source.kind === 'file' ? source.path : null;
  const cached = key === null ? undefined : pageCache.get(key);
  if (typeof cached === 'number') return { pages: cached };
  if (typeof cached === 'string') return { error: cached };
  const counted = await countPdfPages(data);
  if (key !== null) pageCache.set(key, 'pages' in counted ? counted.pages : counted.error);
  return counted;
}

const text = (t: string) => ({ type: 'text' as const, text: t });

/**
 * The ONE wire shape of each kind of file, the form `packages/llm` sends to
 * every provider (`withToolResultAttachmentsAsUserParts` lifts a tool
 * result's `image-data` and `file-data` into a user message): a person's
 * image is an `image` part of bytes, a tool's image an `image-data` part of
 * base64, a PDF a `file` part (the person's) or a `file-data` part of base64
 * (a tool's) named after its saved file — all with the type the bytes declare (`sniffAttachmentMediaType`), else the
 * one the part declared. No other shape leaves this module, so there is no
 * shape the wire layer can drop.
 */
function wirePart(
  origin: Origin,
  data: Uint8Array,
  mediaType: string,
  source: ImageSource,
): unknown {
  const filename = source.kind === 'file' ? basename(source.path) : 'document.pdf';
  if (origin === 'person') {
    return mediaType === PDF_MEDIA_TYPE
      ? { type: 'file', data, mediaType, filename }
      : { type: 'image', image: data, mediaType };
  }
  const base64 = Buffer.from(data).toString('base64');
  if (mediaType !== PDF_MEDIA_TYPE) return { type: 'image-data', data: base64, mediaType };
  return { type: 'file-data', data: base64, mediaType, filename };
}

/**
 * The request's messages, their images and PDFs resolved, WITHOUT touching
 * the stored transcript. Every image or document part counts, whatever its
 * shape (`inventory`), and leaves in the one wire shape of its kind
 * (`wirePart`).
 *
 * A file whose kind the model does not take (`input.image`, `input.pdf`) is
 * replaced by the reason, its bytes never read. The others — the person's
 * images first, then the tools' files, newest first within each — are sent
 * while they fit the budget (`MODEL_REQUEST_MAX_IMAGES`, a PDF counting its
 * pages, and `MODEL_REQUEST_MAX_IMAGE_BYTES`, counted on the bytes sent). A
 * file past the budget is replaced by a sentence saying where it is. A remote
 * file (`https:`) is not sent and not counted: Nodal passes a file to a model
 * as bytes and does not fetch a URL for it, so it says so in its place. A file
 * that cannot be read, or whose format models do not take, is said too.
 *
 * Returns the same array when the transcript holds no image or document.
 */
export async function hydrateForLlm(
  messages: ModelMessage[],
  input: ModelAttachmentInput,
  cache: Map<string, Uint8Array>,
  pageCache: Map<string, number | string> = new Map(),
): Promise<ModelMessage[]> {
  const refs = inventory(messages);
  if (refs.length === 0) return messages;

  let count = 0;
  let bytes = 0;
  const order = [
    ...refs.filter((r) => r.origin === 'person').reverse(),
    ...refs.filter((r) => r.origin === 'tool').reverse(),
  ];
  for (const r of order) {
    const source = r.source;
    const noun = NOUN[r.declared];
    const an = AN[r.declared];
    const support = input[r.declared];
    if (!support.sees) {
      const where =
        source.kind === 'file'
          ? `saved at ${source.path}`
          : source.kind === 'remote'
            ? `at ${source.url}`
            : 'not kept as a file';
      r.sent =
        r.origin === 'person'
          ? text(visionRoutingNote(where, support.reason))
          : text(
              `[${an} was attached to this result, ${where}: not passed to you: ${support.reason}.]`,
            );
      continue;
    }
    if (source.kind === 'remote') {
      r.sent = text(
        `[${an} at ${source.url} is not sent: Nodal passes ${an.charAt(0).toLowerCase() + an.slice(1)} to a model as ` +
          'bytes, and does not fetch a URL for it.]',
      );
      continue;
    }
    if (source.kind === 'unreadable') {
      r.sent = text(
        `[${an} part holds no ${noun} Nodal can read (${source.what}); it is not sent.]`,
      );
      continue;
    }
    const size = source.kind === 'file' ? await sizeOf(source.path, cache) : source.data.byteLength;
    if (size === null) {
      r.sent = text(`[${an} could not be loaded from ${(source as { path: string }).path}.]`);
      continue;
    }
    const declaredType = source.kind === 'file' ? typeOfPath(source.path) : source.mediaType;
    const budgetLine = (what: string): string =>
      `[An earlier ${what} is no longer sent: a request carries ${MODEL_REQUEST_MAX_IMAGES} ` +
      `images and ${formatBytes(MODEL_REQUEST_MAX_IMAGE_BYTES)} of them at most` +
      `${r.declared === 'pdf' ? ', a PDF page counting as one image' : ''}, the ones the person ` +
      `sent first, then the newest. ${whereItIs(source)}]`;
    if (count >= MODEL_REQUEST_MAX_IMAGES || bytes + size > MODEL_REQUEST_MAX_IMAGE_BYTES) {
      r.sent = text(budgetLine(`${noun} (${declaredType ?? noun}, ${formatBytes(size)})`));
      continue;
    }
    const data = source.kind === 'file' ? await bytesOf(source.path, cache) : source.data;
    if (data === null) {
      r.sent = text(`[${an} could not be loaded from ${(source as { path: string }).path}.]`);
      continue;
    }
    const mediaType = sniffAttachmentMediaType(data.subarray(0, 16)) ?? declaredType;
    const kind = mediaType === undefined ? null : attachmentKind(mediaType);
    const taken =
      kind === 'pdf' ||
      (kind === 'image' && mediaType !== undefined && MODEL_IMAGE_MEDIA_TYPES.includes(mediaType));
    if (mediaType === undefined || kind === null || !taken) {
      r.sent = text(
        `[${an} (${mediaType ?? 'of an unknown format'}) is not sent: models take ` +
          `${[...MODEL_IMAGE_MEDIA_TYPES, ...(r.declared === 'pdf' ? [PDF_MEDIA_TYPE] : [])].join(', ')}. ` +
          `${whereItIs(source)}]`,
      );
      continue;
    }
    // The bytes are another kind than the part declared (a `.pdf` that holds a
    // PNG): the capability of what they ARE decides.
    if (kind !== r.declared && !input[kind].sees) {
      r.sent = text(
        `[A file attached to this result is ${kind === 'pdf' ? 'a PDF document' : 'an image'}: ` +
          `not passed to you: ${input[kind].reason}. ${whereItIs(source)}]`,
      );
      continue;
    }
    let units = 1;
    if (kind === 'pdf') {
      const counted = await pagesOf(source, data, pageCache);
      if ('error' in counted) {
        r.sent = text(
          `[A PDF document could not be opened (${counted.error}); it is not sent. ` +
            `${whereItIs(source)}]`,
        );
        continue;
      }
      units = counted.pages;
      if (count + units > MODEL_REQUEST_MAX_IMAGES) {
        r.sent = text(
          budgetLine(`PDF document (${units} page(s), ${formatBytes(data.byteLength)})`),
        );
        continue;
      }
    }
    count += units;
    bytes += data.byteLength;
    r.sent = wirePart(r.origin, data, mediaType, source);
  }

  // Rebuild only the messages that hold a file; the others keep their identity.
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
