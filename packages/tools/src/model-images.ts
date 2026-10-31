// model-images.ts — a file a tool hands to the model with its result: an
// image, or a PDF document (#903).
//
// One rule for every tool that comes back with one (file_read on an image or a
// PDF, an MCP server's image block): the file reaches the model when the model
// takes that kind of file as input (`ctx.modelInput`: images, PDFs), in a
// format models take, within its cap and the request's budget. Otherwise it
// does not, and the tool says why in its result — never the bytes as text,
// never silence (invariant #4).
//
// The tool asks `ctx.attachForModel` (installed per call by `executeTool`);
// the runner says what its model takes (`ctx.modelInput`); `executeTool`
// returns the attached files next to the output, and the runner puts them in
// the tool result the model reads. The `tool_calls` row never keeps the bytes:
// it is an audit, not a store.
//
// A PDF is not a second path: it is the same attachment, with its own
// capability (a model that takes PDFs is not every model that sees) and its
// own size cap, spending the same request budget as the images — a page
// counts as an image (`@nodal-agents/shared` model-image-budget.ts).

import { MODEL_REQUEST_MAX_IMAGES, MODEL_REQUEST_MAX_IMAGE_BYTES } from '@nodal-agents/shared';
import { MAX_READ_BYTES } from './builtin/file-ops/workspace';

import type {
  ModelAttachOutcome,
  ModelAttachmentInput,
  ModelInputSupport,
  ToolAttachment,
} from './types';

// The types live with ToolContext (`types.ts`), which carries them.
export type { ModelAttachOutcome, ModelAttachmentInput, ModelInputSupport, ToolAttachment };

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

/** The one document type models take. */
export const PDF_MEDIA_TYPE = 'application/pdf';

/**
 * The largest PDF passed to a model, decoded: the whole request budget
 * (`MODEL_REQUEST_MAX_IMAGE_BYTES`, 10 MiB), which a PDF shares with the
 * images. Read whole like an image (no window of lines of it means anything),
 * so above the whole-read cap of a text. A printer's scan is commonly 0.2 to
 * 3 MiB a page.
 */
export const MAX_MODEL_PDF_BYTES = MODEL_REQUEST_MAX_IMAGE_BYTES;

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

/** Whether a file's first bytes declare a PDF (`%PDF-`): the bytes, never the name. */
export function isPdf(head: Uint8Array): boolean {
  return ascii(head, '%PDF-');
}

/**
 * The type a file's first bytes declare among the files a tool can hand a
 * model: an image type (`sniffImageMediaType`), `application/pdf`, or `null`.
 */
export function sniffAttachmentMediaType(head: Uint8Array): string | null {
  return sniffImageMediaType(head) ?? (isPdf(head) ? PDF_MEDIA_TYPE : null);
}

/** Which kind of file a type is, for the capability it needs; `null` for neither. */
export function attachmentKind(mediaType: string): keyof ModelAttachmentInput | null {
  if (mediaType.startsWith('image/')) return 'image';
  if (mediaType === PDF_MEDIA_TYPE) return 'pdf';
  return null;
}

/** What a file spends of a request's count: one for an image, its pages for a PDF. */
export function attachmentUnits(attachment: Pick<ToolAttachment, 'mediaType' | 'pages'>): number {
  return attachment.mediaType === PDF_MEDIA_TYPE ? (attachment.pages ?? 0) : 1;
}

/**
 * The pages of a PDF, read by pdf-parse (the library Nodal already ships for
 * Drive PDFs), or why they could not be: a file that only starts like a PDF,
 * a damaged or encrypted one. Loaded on demand: pdfjs weighs, and only a PDF
 * needs it.
 */
export async function countPdfPages(
  bytes: Uint8Array,
): Promise<{ pages: number } | { error: string }> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: new Uint8Array(bytes) });
    try {
      const info = await parser.getInfo();
      return info.total > 0 ? { pages: info.total } : { error: 'it has no page' };
    } finally {
      await parser.destroy();
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const NOUN: Readonly<Record<keyof ModelAttachmentInput, string>> = {
  image: 'images',
  pdf: 'PDF documents',
};

/**
 * Whether `attachment` may reach the model of this call, and if not, why. The
 * one rule `executeTool` applies to every file a tool attaches. `attached` is
 * what this call already attached: one call never attaches more than one
 * request carries (`MODEL_REQUEST_MAX_IMAGES` images, a PDF counting its
 * pages; `MODEL_REQUEST_MAX_IMAGE_BYTES` of them; @nodal-agents/shared),
 * whatever the tool — an MCP server returning thirty images included.
 */
export function admitModelAttachment(
  input: ModelAttachmentInput | undefined,
  attachment: ToolAttachment,
  attached: readonly ToolAttachment[] = [],
): ModelAttachOutcome {
  const kind = attachmentKind(attachment.mediaType);
  if (kind === null) {
    return {
      attached: false,
      reason:
        `${attachment.mediaType} is not a format models take as input ` +
        `(${[...MODEL_IMAGE_MEDIA_TYPES, PDF_MEDIA_TYPE].join(', ')})`,
    };
  }
  if (input === undefined) {
    return { attached: false, reason: `this run does not pass ${NOUN[kind]} to a model` };
  }
  const support: ModelInputSupport = input[kind];
  if (!support.sees) return { attached: false, reason: support.reason };
  const bytes = base64DecodedBytes(attachment.data);
  if (kind === 'image') {
    if (!MODEL_IMAGE_MEDIA_TYPES.includes(attachment.mediaType)) {
      return {
        attached: false,
        reason:
          `${attachment.mediaType} is not a format models take as input ` +
          `(${MODEL_IMAGE_MEDIA_TYPES.join(', ')})`,
      };
    }
    if (bytes > MAX_MODEL_IMAGE_BYTES) {
      return {
        attached: false,
        reason:
          `the image is ${formatBytes(bytes)}, above the ${formatBytes(MAX_MODEL_IMAGE_BYTES)} ` +
          `an image can be passed at; a smaller copy (scaled down, or JPEG) can be`,
      };
    }
  } else {
    if (attachment.pages === undefined || attachment.pages < 1) {
      return { attached: false, reason: 'its pages were not counted, so its cost is not known' };
    }
    if (bytes > MAX_MODEL_PDF_BYTES) {
      return {
        attached: false,
        reason:
          `the PDF is ${formatBytes(bytes)}, above the ${formatBytes(MAX_MODEL_PDF_BYTES)} a PDF ` +
          'can be passed at; a lighter copy (fewer pages, a lower scan resolution) can be',
      };
    }
    if (attachment.pages > MODEL_REQUEST_MAX_IMAGES) {
      return {
        attached: false,
        reason:
          `the PDF has ${attachment.pages} pages, and a request to a model carries at most ` +
          `${MODEL_REQUEST_MAX_IMAGES} images, a PDF page counting as one; a copy of ` +
          `${MODEL_REQUEST_MAX_IMAGES} pages or fewer can be passed`,
      };
    }
  }
  const already = attached.reduce((sum, a) => sum + base64DecodedBytes(a.data), 0);
  const spent = attached.reduce((sum, a) => sum + attachmentUnits(a), 0);
  if (
    spent + attachmentUnits(attachment) > MODEL_REQUEST_MAX_IMAGES ||
    already + bytes > MODEL_REQUEST_MAX_IMAGE_BYTES
  ) {
    return {
      attached: false,
      reason:
        `this call already attached ${attached.length} file(s) (${spent} image(s) or PDF ` +
        `page(s), ${formatBytes(already)}), and a request to a model carries at most ` +
        `${MODEL_REQUEST_MAX_IMAGES} images and ${formatBytes(MODEL_REQUEST_MAX_IMAGE_BYTES)} of ` +
        'them, a PDF page counting as one image',
    };
  }
  return { attached: true };
}
