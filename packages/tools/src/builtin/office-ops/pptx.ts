// office-ops/pptx.ts — PowerPoint tools
//
// Read: officeparser → extract text + slide count (no layout fidelity).
// Create: pptxgenjs → build a new deck from structured slide descriptors.
//   image_path is resolved through the workspace guard before embedding.
//
// V1 honest limits (documented in the skill):
//   - pptx_read returns PLAIN TEXT only (no position, no shapes, no images).
//   - pptx_create builds NEW presentations; in-place edit of existing PPTX is
//     not supported (pptxgenjs is create-only).

import { OfficeParser } from 'officeparser';
import PptxGenJs from 'pptxgenjs';
import { z } from 'zod';
import type { ToolDefinition } from '../../types';
import { readWorkspaceBinary, writeWorkspaceBinary } from './office-helpers';
import { resolveAndCheckPath, WorkspaceError } from '../file-ops/workspace';

// ─── pptx_read ────────────────────────────────────────────────────────────────

const MAX_PPTX_TEXT_CHARS = 200_000;

const PptxReadInput = z.object({
  path: z
    .string()
    .min(1)
    .describe(
      'Workspace-relative path to the .pptx file. For multi-workspace agents, prefix with the workspace label.',
    ),
});

type PptxReadOutput =
  | { ok: true; text: string; slideCount: number; truncated: boolean }
  | { ok: false; reason: string };

export const pptxReadTool: ToolDefinition<typeof PptxReadInput, PptxReadOutput> = {
  name: 'pptx_read',
  description:
    'Read the text content of a PowerPoint (.pptx) presentation from the agent workspace. ' +
    'Returns concatenated text from all slides. Slide count is estimated from the text ' +
    'structure. Images, animations, and speaker notes may not be included.',
  inputSchema: PptxReadInput,
  riskLevel: 'read',
  execute: async (input, ctx) => {
    const readResult = await readWorkspaceBinary(ctx, input.path);
    if (!readResult.ok) return readResult;

    let rawText: string;
    try {
      // OfficeParser.parseOffice accepts a Buffer and returns an AST with .toText()
      const ast = await OfficeParser.parseOffice(readResult.buffer);
      rawText = ast.toText();
    } catch (err) {
      return {
        ok: false,
        reason: `Failed to parse .pptx: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const truncated = rawText.length > MAX_PPTX_TEXT_CHARS;
    const text = truncated ? rawText.slice(0, MAX_PPTX_TEXT_CHARS) + '\n[truncated]' : rawText;

    // Estimate slide count: officeparser inserts a delimiter between slides.
    // Count non-empty segments as a rough slide count.
    const slideCount = rawText.split(/\f|\n{3,}/).filter((s) => s.trim().length > 0).length;

    return { ok: true, text, slideCount: Math.max(1, slideCount), truncated };
  },
};

// ─── pptx_create ─────────────────────────────────────────────────────────────

const SlideSchema = z.object({
  title: z.string().optional().describe('Slide title text.'),
  bullets: z.array(z.string()).optional().describe('Bullet point lines displayed below the title.'),
  body: z
    .string()
    .optional()
    .describe('Free-form text body (used instead of bullets if both provided, bullets win).'),
  image_path: z
    .string()
    .optional()
    .describe(
      'Workspace-relative path to an image file (PNG/JPEG/GIF) to embed on the slide. ' +
        'The path goes through the workspace security guard.',
    ),
});

const PptxCreateInput = z.object({
  path: z
    .string()
    .min(1)
    .describe('Workspace-relative path for the new .pptx file (e.g. "presentations/deck.pptx").'),
  slides: z
    .array(SlideSchema)
    .min(1)
    .describe('Array of slides to include in the presentation, in order.'),
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
    'have a title, bullet points (or body text), and an optional image (workspace-relative path). ' +
    'Fails if the file already exists unless overwrite:true is passed. ' +
    '⚠ V1 LIMIT: creates NEW presentations only — in-place edit of existing PPTX is not supported.',
  inputSchema: PptxCreateInput,
  riskLevel: 'write',
  execute: async (input, ctx) => {
    const pptx = new PptxGenJs();

    for (const slideDef of input.slides) {
      const slide = pptx.addSlide();

      // Title
      if (slideDef.title) {
        slide.addText(slideDef.title, {
          x: 0.5,
          y: 0.25,
          w: '90%',
          h: 1.0,
          fontSize: 28,
          bold: true,
          color: '363636',
        });
      }

      // Bullets or body text
      const yContent = slideDef.title ? 1.5 : 0.5;
      const hContent = slideDef.title ? 3.8 : 4.8;

      if (slideDef.bullets && slideDef.bullets.length > 0) {
        const bulletObjs = slideDef.bullets.map((b) => ({
          text: b,
          options: { bullet: true, fontSize: 18, color: '404040' },
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
          color: '404040',
          wrap: true,
        });
      }

      // Image — resolve through workspace guard
      if (slideDef.image_path) {
        try {
          const resolvedImg = await resolveAndCheckPath(ctx, slideDef.image_path);
          slide.addImage({
            path: resolvedImg,
            x: 0.5,
            y: 5.5,
            w: 3.0,
            h: 2.0,
          });
        } catch (err) {
          if (err instanceof WorkspaceError) {
            return { ok: false, reason: `image_path error: ${err.message}` };
          }
          throw err;
        }
      }
    }

    // pptxgenjs write() returns a Buffer when type='nodebuffer'
    const buffer = Buffer.from((await pptx.write({ outputType: 'nodebuffer' })) as ArrayBuffer);

    const writeResult = await writeWorkspaceBinary(ctx, input.path, buffer, {
      overwrite: input.overwrite,
    });
    if (!writeResult.ok) return writeResult;
    return { ok: true, path: writeResult.path, slide_count: input.slides.length };
  },
};
