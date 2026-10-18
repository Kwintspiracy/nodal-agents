// model-images.ts — an image a tool hands to the model with its result.
//
// One rule for every tool that comes back with a picture (file_read on an
// image file, an MCP server's image block): the image reaches the model when
// the model takes images as input, in a format models take, within the
// whole-read cap. Otherwise it does not, and the tool says why in its result —
// never the bytes as text, never silence (invariant #4).
//
// The tool asks `ctx.attachImage` (installed per call by `executeTool`); the
// runner says what its model takes (`ctx.modelImageInput`); `executeTool`
// returns the attached images next to the output, and the runner puts them in
// the tool result the model reads. The `tool_calls` row never keeps the bytes:
// it is an audit, not a store.

import { MAX_READ_BYTES } from './builtin/file-ops/workspace';

import type { ImageAttachOutcome, ModelImageInput, ToolImage } from './types';

// The types live with ToolContext (`types.ts`), which carries them.
export type { ImageAttachOutcome, ModelImageInput, ToolImage };

/**
 * The formats every vision provider Nodal speaks to takes as image input
 * (Anthropic, OpenAI, Google, OpenRouter): PNG, JPEG, GIF, WebP. Another image
 * format (BMP, TIFF, HEIC, AVIF, SVG) is refused with its type named.
 */
export const MODEL_IMAGE_MEDIA_TYPES: readonly string[] = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
];

/**
 * The largest image passed to a model, decoded. An image cannot be read a
 * section at a time, so it obeys the cap of a whole read (`MAX_READ_BYTES`,
 * 1 MiB), well under every provider's own per-image limit.
 */
export const MAX_MODEL_IMAGE_BYTES = MAX_READ_BYTES;

/** Decoded size of a base64 payload, without decoding it. */
export function base64DecodedBytes(data: string): number {
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/** A size as a person reads it. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

const startsWith = (head: Uint8Array, sig: readonly number[], at = 0): boolean =>
  sig.every((b, i) => head[at + i] === b);
const ascii = (head: Uint8Array, text: string, at = 0): boolean =>
  startsWith(
    head,
    [...text].map((c) => c.charCodeAt(0)),
    at,
  );

/**
 * The image type a file's first bytes declare, or `null` when they declare
 * none. Read from the bytes, never the name: a `.png` that holds text is text,
 * and a screenshot saved without an extension is still an image. Knows the
 * formats models take and the common ones they do not, so that a BMP is
 * refused as an image rather than read as text. SVG is text, and is read as
 * text.
 */
export function sniffImageMediaType(head: Uint8Array): string | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(head, 'GIF87a') || ascii(head, 'GIF89a')) return 'image/gif';
  if (ascii(head, 'RIFF') && ascii(head, 'WEBP', 8)) return 'image/webp';
  if (ascii(head, 'BM') && head.length >= 14) return 'image/bmp';
  if (startsWith(head, [0x49, 0x49, 0x2a, 0x00]) || startsWith(head, [0x4d, 0x4d, 0x00, 0x2a])) {
    return 'image/tiff';
  }
  if (ascii(head, 'ftyp', 4)) {
    if (ascii(head, 'avif', 8) || ascii(head, 'avis', 8)) return 'image/avif';
    if (['heic', 'heix', 'mif1', 'msf1', 'hevc'].some((brand) => ascii(head, brand, 8))) {
      return 'image/heic';
    }
  }
  return null;
}

/**
 * Whether `image` may reach the model of this call, and if not, why. The one
 * rule `executeTool` applies to every image a tool attaches.
 */
export function admitModelImage(
  input: ModelImageInput | undefined,
  image: ToolImage,
): ImageAttachOutcome {
  if (input === undefined) {
    return {
      attached: false,
      reason: 'this run does not pass images to a model',
    };
  }
  if (!input.sees) return { attached: false, reason: input.reason };
  if (!MODEL_IMAGE_MEDIA_TYPES.includes(image.mediaType)) {
    return {
      attached: false,
      reason:
        `${image.mediaType} is not a format models take as input ` +
        `(${MODEL_IMAGE_MEDIA_TYPES.join(', ')})`,
    };
  }
  const bytes = base64DecodedBytes(image.data);
  if (bytes > MAX_MODEL_IMAGE_BYTES) {
    return {
      attached: false,
      reason:
        `the image is ${formatBytes(bytes)}, above the ${formatBytes(MAX_MODEL_IMAGE_BYTES)} ` +
        `an image can be passed at; a smaller copy (scaled down, or JPEG) can be`,
    };
  }
  return { attached: true };
}
