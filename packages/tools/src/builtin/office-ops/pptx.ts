// office-ops/pptx.ts — PowerPoint tools
//
// Read: officeparser → extract text + slide count (no layout fidelity).
// Create: pptxgenjs → build a new deck from structured slide descriptors.
// Append: pptxgenjs (build new slides into a temp deck) + pptx-automizer
//   (merge that temp deck's slides onto the END of an existing .pptx, leaving
//   every original slide byte-for-byte untouched). pptx-automizer is
//   ADD-ONLY — it cannot modify a specific existing slide in place, only
//   import whole slides from a template — so append is the one true "edit"
//   primitive it gives us for free.
// Replace text: pptx-automizer's modify.replaceText() needs a shape NAME
//   selector, which the agent generally doesn't know. Instead we walk the
//   raw ppt/slides/slideN.xml with a JSZip round-trip and replace occurrences
//   that live entirely inside a single <a:t> run — the same "single-node"
//   strategy used for docx — reporting any match that only exists once
//   adjacent runs are concatenated as skipped_fragmented rather than
//   guessing how to safely rewrite it.
//
// V1 honest limits (documented in the skill):
//   - pptx_read returns PLAIN TEXT only (no position, no shapes, no images).
//     Per-slide text comes from officeparser's AST, which DROPS slides that
//     have no extractable text/shape content — a truly blank slide won't
//     appear in `slides`.
//   - pptx_replace_text / pptx_append_slides address slides by their
//     ppt/slides/slideN.xml file-order, which matches presentation order for
//     freshly generated decks but is not guaranteed after manual slide
//     reordering in PowerPoint.

import { OfficeParser, OfficeGenerator, type OfficeContentNode } from 'officeparser';
import PptxGenJs from 'pptxgenjs';
import { Automizer } from 'pptx-automizer';
import JSZip from 'jszip';
import { z } from 'zod';
import type { ToolContext, ToolDefinition } from '../../types';
import { detailOf, failureText, readCard, writtenFile } from '../../presenters';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';

// ─── pptx_read ────────────────────────────────────────────────────────────────

const MAX_PPTX_TEXT_CHARS = 200_000;
const MAX_PPTX_SLIDE_TEXT_CHARS = 20_000;

const PptxReadInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Workspace-relative path to the .pptx file. For multi-workspace agents, prefix with the workspace label.',
    ),
});

type PptxReadOutput =
  | { ok: true; text: string; slides: string[]; slideCount: number; truncated: boolean }
  | { ok: false; reason: string };

/** 1-based slide number stashed in officeparser's node.metadata, if present. */
function slideNumberOf(node: OfficeContentNode): number {
  const meta = node.metadata as { slideNumber?: number } | undefined;
  return meta?.slideNumber ?? 0;
}

export const pptxReadTool: ToolDefinition<typeof PptxReadInput, PptxReadOutput> = {
  name: 'pptx_read',
  description:
    'Read the text content of a PowerPoint (.pptx) presentation from the agent workspace. ' +
    'Returns concatenated text from all slides plus a per-slide text array. Slide count is ' +
    'estimated from the text structure — a slide with no extractable text/shape content may ' +
    'be dropped from the per-slide breakdown. Images, animations, and speaker notes may not ' +
    'be included.',
  inputSchema: PptxReadInput,
  riskLevel: 'read',
  card: 'read',
  present: ({ input, output }) =>
    output.ok
      ? readCard({
          path: input.path,
          text: output.text,
          truncated: output.truncated,
          sections: output.slideCount,
        })
      : failureText(output.reason),
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    let ast;
    try {
      // OfficeParser.parseOffice accepts a Buffer and returns an AST with .toText()
      // and a .content array of top-level nodes (one per slide/note for pptx).
      ast = await OfficeParser.parseOffice(readResult.buffer);
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to parse .pptx: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    let rawText: string;
    try {
      rawText = ast.toText();
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to extract text from .pptx: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const truncated = rawText.length > MAX_PPTX_TEXT_CHARS;
    const text = truncated ? rawText.slice(0, MAX_PPTX_TEXT_CHARS) + '\n[truncated]' : rawText;

    // Per-slide breakdown: officeparser keeps one top-level 'slide' node per
    // slide (notes are SEPARATE top-level 'note' nodes, not nested — so this
    // filter naturally excludes speaker notes from the per-slide text).
    // Render each slide node in isolation through the same generator that
    // powers .toText() by feeding it a single-node AST clone.
    const slideNodes = ast.content
      .filter((node) => node.type === 'slide')
      .sort((a, b) => slideNumberOf(a) - slideNumberOf(b));

    const slides: string[] = [];
    for (const node of slideNodes) {
      let slideText = '';
      try {
        // 'text' is a literal here, but generate()'s return type is generic
        // over the destination and widens to a union that includes non-string
        // formats (pdf/chunks) — safe to assert since we always pass 'text'.
        const rendered = await OfficeGenerator.generate({ ...ast, content: [node] }, 'text');
        slideText = (rendered.value as string).trim();
      } catch {
        // Best-effort: a single slide failing to render shouldn't fail the whole read.
        slideText = '';
      }
      slides.push(
        slideText.length > MAX_PPTX_SLIDE_TEXT_CHARS
          ? slideText.slice(0, MAX_PPTX_SLIDE_TEXT_CHARS) + '\n[truncated]'
          : slideText,
      );
    }

    // Fall back to the old delimiter heuristic only if the AST gave us nothing
    // (e.g. a malformed deck officeparser couldn't structure into slide nodes).
    const slideCount =
      slides.length > 0
        ? slides.length
        : Math.max(1, rawText.split(/\f|\n{3,}/).filter((s) => s.trim().length > 0).length);

    return { ok: true, text, slides, slideCount, truncated };
  },
};

// ─── Shared slide-building (pptx_create + pptx_append_slides) ────────────────

const TableSchema = z.object({
  rows: z
    .array(z.array(z.string()))
    .min(1)
    .describe('Row-major 2-D array of cell text. rows[0] is the first row.'),
  header: z
    .boolean()
    .optional()
    .describe('If true, the first row is styled as a bold header row with a light fill.'),
});

const SlideSchema = z.object({
  title: z.string().optional().describe('Slide title text.'),
  bullets: z.array(z.string()).optional().describe('Bullet point lines displayed below the title.'),
  body: z
    .string()
    .optional()
    .describe('Free-form text body (used instead of bullets if both provided, bullets win).'),
  notes: z
    .string()
    .optional()
    .describe(
      'Speaker notes for this slide. Not visible during the presentation — only in ' +
        'Presenter View or when notes are printed.',
    ),
  table: TableSchema.optional().describe(
    'A simple table rendered near the bottom of the slide. If image_path is also set on the ' +
      'same slide, the table is shifted to the right of the image to reduce overlap.',
  ),
  image_path: z
    .string()
    .optional()
    .describe(
      'Workspace-relative path to an image file (PNG/JPEG/GIF) to embed on the slide. ' +
        'The path goes through the workspace security guard.',
    ),
  image_width_in: z
    .number()
    .positive()
    .optional()
    .describe('Image width in inches. Defaults to 3.0.'),
  image_height_in: z
    .number()
    .positive()
    .optional()
    .describe('Image height in inches. Defaults to 2.0.'),
});
type SlideDef = z.infer<typeof SlideSchema>;

const ThemeSchema = z.object({
  title_color: z
    .string()
    .optional()
    .describe('Hex color without "#" applied to every slide title, e.g. "1A73E8".'),
  body_color: z
    .string()
    .optional()
    .describe('Hex color without "#" applied to bullet/body/table text, e.g. "404040".'),
  background_color: z
    .string()
    .optional()
    .describe('Hex color without "#" applied as the slide background, e.g. "F5F5F5".'),
});
type Theme = z.infer<typeof ThemeSchema>;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Best-effort image mime-type sniff from magic bytes, falling back to the
 * image_path extension and finally to 'png'. Needed because embedding now
 * goes through pptxgenjs's `data:` (base64) input rather than `path` (see
 * the M2 fix note at the image_path call site) — pptxgenjs derives the
 * output content-type from this string instead of reading the file itself.
 */
function sniffImageMimeType(buffer: Buffer, hintPath: string): string {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff)
    return 'jpeg';
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii')))
    return 'gif';
  if (buffer.length >= 2 && buffer[0] === 0x42 && buffer[1] === 0x4d) return 'bmp';
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  const ext = hintPath.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'jpeg';
  if (ext === 'gif' || ext === 'bmp' || ext === 'webp' || ext === 'png') return ext;
  return 'png';
}

/**
 * Build a pptxgenjs deck from slide descriptors and return the raw .pptx bytes.
 * Shared by pptx_create (writes the buffer as a new file) and
 * pptx_append_slides (feeds the buffer to pptx-automizer as a template to
 * import slides FROM, never written to disk directly).
 */
async function buildPptxGenJsBuffer(
  ctx: ToolContext,
  slides: SlideDef[],
  theme?: Theme,
): Promise<{ ok: true; buffer: Buffer } | { ok: false; reason: string }> {
  const pptx = new PptxGenJs();
  const titleColor = theme?.title_color ?? '363636';
  const bodyColor = theme?.body_color ?? '404040';

  for (const slideDef of slides) {
    const slide = pptx.addSlide();

    if (theme?.background_color) {
      slide.background = { color: theme.background_color };
    }

    // Title
    if (slideDef.title) {
      slide.addText(slideDef.title, {
        x: 0.5,
        y: 0.25,
        w: '90%',
        h: 1.0,
        fontSize: 28,
        bold: true,
        color: titleColor,
      });
    }

    // Bullets or body text
    const yContent = slideDef.title ? 1.5 : 0.5;
    const hContent = slideDef.title ? 3.8 : 4.8;

    if (slideDef.bullets && slideDef.bullets.length > 0) {
      const bulletObjs = slideDef.bullets.map((b) => ({
        text: b,
        options: { bullet: true, fontSize: 18, color: bodyColor },
      }));
      slide.addText(bulletObjs, {
        x: 0.5,
        y: yContent,
        w: '90%',
        h: hContent,
      });
    } else if (slideDef.body) {
      slide.addText(slideDef.body, {
        x: 0.5,
        y: yContent,
        w: '90%',
        h: hContent,
        fontSize: 16,
        color: bodyColor,
        wrap: true,
      });
    }

    // Table — placed near the bottom; shifted right of the image slot when
    // both are present on the same slide to reduce (not eliminate) overlap.
    if (slideDef.table && slideDef.table.rows.length > 0) {
      const hasImage = Boolean(slideDef.image_path);
      const tableRows = slideDef.table.rows.map((row, rowIdx) => {
        const isHeaderRow = slideDef.table!.header === true && rowIdx === 0;
        return row.map((cellText) => ({
          text: cellText,
          options: isHeaderRow ? { bold: true, fill: { color: 'E5E5E5' } } : {},
        }));
      });
      slide.addTable(tableRows, {
        x: hasImage ? 4.0 : 0.5,
        y: 5.5,
        w: hasImage ? 5.5 : 9.0,
        fontSize: 12,
        color: bodyColor,
      });
    }

    // Image — read the bytes through the workspace guard (readWorkspaceBinary
    // checks existence AND the 25 MiB cap, returning ok:false rather than
    // throwing) and hand pptxgenjs the base64 payload via `data`, NOT `path`.
    // pptxgenjs's own path-based addImage defers the actual file read to
    // pptx.write() below, OUTSIDE any try/catch here — a missing file would
    // throw ENOENT out of write() and escape execute() entirely, breaking
    // this module's "never throw, always {ok:false,reason}" contract.
    if (slideDef.image_path) {
      const imgRead = await readWorkspaceBinary(ctx, slideDef.image_path);
      if (!imgRead.ok) {
        return { ok: false, reason: `image_path error: ${imgRead.reason}` };
      }
      const mimeType = sniffImageMimeType(imgRead.buffer, slideDef.image_path);
      slide.addImage({
        data: `data:image/${mimeType};base64,${imgRead.buffer.toString('base64')}`,
        x: 0.5,
        y: 5.5,
        w: slideDef.image_width_in ?? 3.0,
        h: slideDef.image_height_in ?? 2.0,
      });
    }

    // Speaker notes
    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  // pptxgenjs write() returns a Buffer when type='nodebuffer'
  const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as ArrayBuffer);
  return { ok: true, buffer };
}

// ─── pptx_create ─────────────────────────────────────────────────────────────

const PptxCreateInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path for the new .pptx file (e.g. "presentations/deck.pptx").'),
  slides: z
    .array(SlideSchema)
    .min(1)
    .describe('Array of slides to include in the presentation, in order.'),
  theme: ThemeSchema.optional().describe('Optional deck-wide color theme.'),
  overwrite: z
    .boolean()
    .optional()
    .default(false)
    .describe('If false (default) refuse to overwrite an existing file.'),
});

type PptxCreateOutput =
  | { ok: true; path: string; slide_count: number }
  | { ok: false; reason: string };

export const pptxCreateTool: ToolDefinition<typeof PptxCreateInput, PptxCreateOutput> = {
  name: 'pptx_create',
  description:
    'Create a new PowerPoint (.pptx) presentation from slide descriptors. Each slide can ' +
    'have a title, bullet points (or body text), speaker notes, a table, and an optional ' +
    'image (workspace-relative path). An optional deck-wide theme sets title/body/background ' +
    'colors. Fails if the file already exists unless overwrite:true is passed. ' +
    '⚠ V1 LIMIT: creates NEW presentations only — to add slides to an existing .pptx use ' +
    'pptx_append_slides, and to edit text in place use pptx_replace_text.',
  inputSchema: PptxCreateInput,
  riskLevel: 'write',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? writtenFile(output.path, 'created', { detail: detailOf(output) })
      : failureText(output.reason),
  execute: async (input, ctx) => {
    const built = await buildPptxGenJsBuffer(ctx, input.slides, input.theme);
    if (!built.ok) return built;

    const writeResult = await writeWorkspaceBinary(ctx, input.path, built.buffer, {
      overwrite: input.overwrite,
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, slide_count: input.slides.length };
  },
};

// ─── pptx_append_slides ────────────────────────────────────────────────────────

const PptxAppendSlidesInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path to the existing .pptx file to append to.'),
  slides: z
    .array(SlideSchema)
    .min(1)
    .describe('Array of new slides to append AFTER the existing slides, in order.'),
});

type PptxAppendSlidesOutput =
  | { ok: true; path: string; slides_appended: number; total_slides: number }
  | { ok: false; reason: string };

export const pptxAppendSlidesTool: ToolDefinition<
  typeof PptxAppendSlidesInput,
  PptxAppendSlidesOutput
> = {
  name: 'pptx_append_slides',
  description:
    'Append new slides to the END of an existing PowerPoint (.pptx) file without touching any ' +
    'existing slide. Each new slide accepts the same fields as pptx_create (title, bullets/body, ' +
    'notes, table, image). Internally builds the new slides with pptxgenjs, then imports them ' +
    'onto the existing deck with pptx-automizer, which only ADDS content — existing slides are ' +
    'never modified.',
  inputSchema: PptxAppendSlidesInput,
  riskLevel: 'write',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? writtenFile(output.path, 'modified', { detail: detailOf(output) })
      : failureText(output.reason),
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    const built = await buildPptxGenJsBuffer(ctx, input.slides);
    if (!built.ok) return built;

    const automizer = new Automizer({
      // Both the root and the appended deck are pptxgenjs output, but their
      // master/layout sets are independently generated — always importing
      // masters avoids "missing slideLayout" corruption on the merged file.
      autoImportSlideMasters: true,
      // Default behavior: append after whatever is already in the root.
      removeExistingSlides: false,
      verbosity: 0,
    });

    const pres = automizer.loadRoot(readResult.buffer).load(built.buffer, 'appended');
    for (let i = 1; i <= input.slides.length; i++) {
      pres.addSlide('appended', i);
    }

    let zip: JSZip;
    try {
      zip = await pres.getJSZip();
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to append slides to .pptx: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const totalSlides = Object.keys(zip.files).filter((name) =>
      /^ppt\/slides\/slide\d+\.xml$/.test(name),
    ).length;

    const buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, { overwrite: true });
    if (!writeResult.ok) return writeResult;

    return {
      ok: true,
      path: writeResult.path,
      slides_appended: input.slides.length,
      total_slides: totalSlides,
    };
  },
};

// ─── pptx_replace_text ─────────────────────────────────────────────────────────

function unescapeXmlText(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCharCode(Number(dec)))
    .replace(/&amp;/g, '&'); // must run last
}

function escapeXmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let idx = 0;
  for (;;) {
    const found = haystack.indexOf(needle, idx);
    if (found === -1) break;
    count++;
    idx = found + needle.length;
  }
  return count;
}

function replaceAllOccurrences(haystack: string, needle: string, replacement: string): string {
  if (!needle) return haystack;
  return haystack.split(needle).join(replacement);
}

const PARAGRAPH_RE = /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;
const TEXT_RUN_RE = /(<a:t(?:\s[^>]*)?>)([\s\S]*?)(<\/a:t>)/g;

/**
 * Replace `search` with `replace` inside a slide's raw XML, scoped per
 * paragraph (<a:p>). An occurrence is only rewritten when it lives ENTIRELY
 * inside a single <a:t> text run — the "single-node" strategy also used for
 * docx. An occurrence that only appears once adjacent runs in the SAME
 * paragraph are concatenated (i.e. PowerPoint split one logical string
 * across multiple runs, usually from mid-sentence formatting changes) is
 * counted as skippedFragmented instead of being guessed at.
 */
function replaceTextInSlideXml(
  xml: string,
  search: string,
  replace: string,
): { xml: string; replaced: number; skippedFragmented: number } {
  let totalReplaced = 0;
  let totalSkipped = 0;

  const newXml = xml.replace(PARAGRAPH_RE, (paragraph) => {
    const nodeTexts: string[] = [];
    TEXT_RUN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TEXT_RUN_RE.exec(paragraph)) !== null) {
      nodeTexts.push(unescapeXmlText(m[2]!));
    }
    if (nodeTexts.length === 0) return paragraph;

    const concatPlain = nodeTexts.join('');
    const concatOccurrences = countOccurrences(concatPlain, search);
    if (concatOccurrences === 0) return paragraph;

    let replacedInParagraph = 0;
    TEXT_RUN_RE.lastIndex = 0;
    const newParagraph = paragraph.replace(
      TEXT_RUN_RE,
      (full, open: string, inner: string, close: string) => {
        const plain = unescapeXmlText(inner);
        const occ = countOccurrences(plain, search);
        if (occ === 0) return full;
        replacedInParagraph += occ;
        const newPlain = replaceAllOccurrences(plain, search, replace);
        return open + escapeXmlText(newPlain) + close;
      },
    );

    totalReplaced += replacedInParagraph;
    totalSkipped += Math.max(0, concatOccurrences - replacedInParagraph);
    return newParagraph;
  });

  return { xml: newXml, replaced: totalReplaced, skippedFragmented: totalSkipped };
}

const PptxReplaceTextInput = z.object({
  path: z.string().min(1).describe('Workspace-relative path to the existing .pptx file to edit.'),
  search: z.string().min(1).describe('Text to find and replace.'),
  replace: z.string().describe('Replacement text.'),
  slide_index: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      '1-indexed slide to restrict the replacement to (by ppt/slides/slideN.xml file order). ' +
        'Omit to replace across every slide.',
    ),
});

type PptxReplaceTextOutput =
  | { ok: true; replaced: number; skipped_fragmented: number; slides_touched: number[] }
  | { ok: false; reason: string };

export const pptxReplaceTextTool: ToolDefinition<
  typeof PptxReplaceTextInput,
  PptxReplaceTextOutput
> = {
  name: 'pptx_replace_text',
  description:
    'Find and replace text inside an existing PowerPoint (.pptx) file, in place. Only ' +
    'occurrences that live entirely inside a single text run are replaced; occurrences split ' +
    'across multiple runs (e.g. mid-word formatting changes) are reported as ' +
    'skipped_fragmented rather than guessed at. Fails loud if the search text is not found ' +
    'anywhere in the presentation (or in the target slide, if slide_index is given).',
  inputSchema: PptxReplaceTextInput,
  riskLevel: 'write',
  card: 'files',
  present: ({ input, output }) =>
    output.ok
      ? writtenFile(input.path, 'modified', { detail: detailOf(output) })
      : failureText(output.reason),
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(readResult.buffer);
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to parse .pptx as a zip archive: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const slideEntries = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .map((name) => ({ name, index: Number(name.match(/slide(\d+)\.xml$/)![1]) }))
      .sort((a, b) => a.index - b.index);

    if (slideEntries.length === 0) {
      return { ok: false, reason: 'No slides found in the presentation.' };
    }

    if (
      input.slide_index !== undefined &&
      (input.slide_index < 1 || input.slide_index > slideEntries.length)
    ) {
      return {
        ok: false,
        reason: `slide_index ${input.slide_index} is out of range (presentation has ${slideEntries.length} slides).`,
      };
    }

    const targets =
      input.slide_index !== undefined ? [slideEntries[input.slide_index - 1]!] : slideEntries;

    let totalReplaced = 0;
    let totalSkipped = 0;
    const slidesTouched: number[] = [];

    for (const target of targets) {
      const file = zip.file(target.name);
      if (!file) continue;
      const xml = await file.async('string');
      const result = replaceTextInSlideXml(xml, input.search, input.replace);
      if (result.replaced > 0) {
        zip.file(target.name, result.xml);
        slidesTouched.push(target.index);
      }
      totalReplaced += result.replaced;
      totalSkipped += result.skippedFragmented;
    }

    if (totalReplaced === 0 && totalSkipped === 0) {
      const scope = input.slide_index !== undefined ? ` on slide ${input.slide_index}` : '';
      return {
        ok: false,
        reason: `Text "${input.search}" was not found${scope} in the presentation.`,
      };
    }

    const buffer = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, { overwrite: true });
    if (!writeResult.ok) return writeResult;

    return {
      ok: true,
      replaced: totalReplaced,
      skipped_fragmented: totalSkipped,
      slides_touched: slidesTouched,
    };
  },
};
