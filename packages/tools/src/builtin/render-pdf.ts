// Built-in: render_pdf — une page HTML des dossiers de l'agent, rendue en PDF
// par le moteur de rendu de Nodal (#1082).
//
// POURQUOI. Rien dans Nodal ne faisait d'une page HTML un PDF. Les agents
// improvisaient avec le navigateur installé sur la machine (`msedge --headless
// --print-to-pdf` par `run_command`) : des fenêtres et des alertes de
// plantage sur l'écran du propriétaire, et un travail lent. Mesuré sur son
// installation depuis le 01/09/2026 : 20 tâches ont fait un PDF ainsi, 16
// plus d'une fois, 40 rendus de trop ; le 16/11 une demande a rendu le même
// fichier 6 fois en 108 s pour le faire tenir sur une page. La compétence
// communautaire `pdf` le dit elle-même : « NOT for pixel-perfect HTML-to-PDF
// rendering (use a headless browser) ». Cet outil EST ce navigateur sans tête.
//
// CE QU'IL FAIT, pour tout agent (il est toujours donné, comme `file_write`) :
//   - LIT la page par le périmètre de `file_read` (`resolveAndCheckPath`), et
//     chaque fichier local qu'elle charge (images, CSS, polices) par le même :
//     un fichier hors des dossiers de l'agent n'est pas chargé, et le résultat
//     le dit ;
//   - ÉCRIT le PDF par le périmètre et la porte d'écrasement de `file_write` :
//     même résolution, même écriture atomique (`writeFileAtomically`, qui
//     rapporte l'empreinte écrite et repose la question de la porte), même
//     cible déclarée au seam (`resolveMutationTargets`), donc le même constat
//     du fichier créé ;
//   - TIENT le nombre de pages demandé (`pages`) : il cherche lui-même la plus
//     grande échelle qui tient, en un appel, jamais au-dessus de 1 ni sous
//     l'échelle minimale lisible (`MIN_READABLE_SCALE`) ; une page qui ne tient
//     pas même là fait échouer l'appel, avec le nombre de pages qu'elle y fait ;
//   - DIT ce qu'il a fait, compté sur le PDF produit : pages, échelle, papier.
//
// Le moteur (chrome-headless-shell, sans fenêtre) est installé au premier
// démarrage de Nodal (@nodal-agents/page-render, `installRenderer`). Absent, en
// cours d'installation, en échec ou refusé par le réglage : l'appel le dit, et
// dit comment l'installer. Jamais le navigateur de la personne.

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { z } from 'zod';
import {
  MIN_READABLE_SCALE,
  PAPER_NAMES,
  PageRenderError,
  RENDERER_INSTALL_COMMAND,
  RENDER_TIME_LIMIT_MS,
  readRendererStatus,
  renderPdf,
  type LocalRead,
  type NotLoaded,
  type PaperFacts,
  type PaperName,
  type RendererStatus,
} from '@nodal-agents/page-render';
import type { ToolContext, ToolDefinition } from '../types';
import { failureText, writtenFile } from '../presenters';
import {
  declaredWrittenFileType,
  deliverableTypeForWrittenFile,
} from '../verification/written-file-type';
import { fileDeliverableKey } from '../verification/office-file-key';
import { writeFileAtomically } from './file-ops/atomic-write';
import {
  computeSharedOverwriteApproval,
  isProtectedWorkflowTemplate,
  MAX_READ_FILE_BYTES,
  resolveAndCheckPath,
  WORKFLOW_TEMPLATE_PROTECTED_MESSAGE,
  WorkspaceError,
} from './file-ops/workspace';
import { outcomeOfOkFlag } from '../outcome';

/** Le plus gros PDF que l'outil écrit (le plafond de lecture de `file_read`). */
export const MAX_PDF_BYTES = MAX_READ_FILE_BYTES;

/** Le plus de pages qu'un appel peut demander. */
const MAX_PAGES_ASKED = 500;

const MarginMm = z.number().min(0).max(100);

export const RenderPdfInputSchema = z.object({
  source: z
    .string()
    .min(1)
    .describe(
      'The HTML page to render, a path in your folders (like file_read). Its images, CSS and ' +
        'fonts load from your folders by paths relative to the page.',
    ),
  output: z
    .string()
    .min(1)
    .describe(
      'Where to write the PDF, a path in your folders ending in .pdf (like file_write). An ' +
        'existing file there is replaced.',
    ),
  pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES_ASKED)
    .optional()
    .describe(
      'OPTIONAL. The most pages the PDF may have. The tool shrinks the page itself, in this ' +
        `one call, to the largest scale that fits (never larger than 1, never below ` +
        `${MIN_READABLE_SCALE}); leave the text as it is. Without it, the page renders at scale 1.`,
    ),
  paper: z
    .enum(PAPER_NAMES as [PaperName, ...PaperName[]])
    .optional()
    .describe(
      "OPTIONAL. The paper size. Without paper, orientation or margins, the page's own CSS " +
        '`@page` decides, and A4 when it says nothing.',
    ),
  orientation: z
    .enum(['portrait', 'landscape'])
    .optional()
    .describe('OPTIONAL. The paper orientation.'),
  margins_mm: z
    .union([
      MarginMm,
      z.object({ top: MarginMm, right: MarginMm, bottom: MarginMm, left: MarginMm }),
    ])
    .optional()
    .describe(
      "OPTIONAL. The margins in millimetres: one number for all four sides, or each side. They win over the page's CSS.",
    ),
  create_dirs: z
    .boolean()
    .optional()
    .default(false)
    .describe('If true, create missing folders for `output`.'),
  purpose: z
    .string()
    .optional()
    .describe(
      'OPTIONAL. One short sentence on WHY this PDF is needed. Shown on the approval card ' +
        'when this call replaces a file in the shared workspace.',
    ),
});

export type RenderPdfInput = z.infer<typeof RenderPdfInputSchema>;
export type RenderPdfOutput =
  | {
      ok: true;
      written: true;
      path: string;
      bytes: number;
      pages: number;
      /** L'échelle du rendu écrit : 1, ou moins quand `pages` l'a demandé. */
      scale: number;
      pages_at_scale_1: number;
      pages_asked?: number;
      paper: PaperFacts;
      mixed_sizes?: true;
      not_loaded?: NotLoaded[];
      /** Ce que l'appel a fait, en une phrase. */
      summary: string;
      deliverable_key?: string;
    }
  | { ok: false; reason: string };

/** `x` → `x.pdf`, `x.PDF` → `x.pdf` ; toute autre extension est refusée. */
function pdfPath(path: string): string | null {
  const ext = extname(path);
  if (ext === '') return `${path}.pdf`;
  return ext.toLowerCase() === '.pdf' ? `${path.slice(0, -ext.length)}.pdf` : null;
}

const MB = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;

/** Pourquoi le moteur ne peut pas rendre, et comment l'installer. */
export function rendererUnavailable(status: Exclude<RendererStatus, { kind: 'ready' }>): string {
  const later = `Install it with \`${RENDERER_INSTALL_COMMAND}\` (or restart Nodal, which downloads it at start unless that is turned off).`;
  switch (status.kind) {
    case 'installing': {
      const progress =
        status.downloadedBytes !== undefined && status.totalBytes !== undefined
          ? `, ${MB(status.downloadedBytes)} of ${MB(status.totalBytes)} downloaded`
          : '';
      return (
        `Nodal's page renderer is being installed right now (started ${status.startedAt} by ` +
        `process ${status.pid}${progress}). Nothing was written. Call again once it is installed.`
      );
    }
    case 'failed':
      return (
        `Nodal's page renderer is not installed: its install failed (${status.reason}, ` +
        `${status.at}). Nothing was written. ${later}`
      );
    case 'off':
      return (
        `Nodal's page renderer is not installed: its download at start is turned off ` +
        `(${status.how}). Nothing was written. Install it with \`${RENDERER_INSTALL_COMMAND}\`.`
      );
    case 'missing':
      return `Nodal's page renderer is not installed (${status.detail}). Nothing was written. ${later}`;
  }
}

function describePaper(p: PaperFacts): string {
  return `${p.name ?? 'custom'} ${p.orientation} (${p.width_mm} × ${p.height_mm} mm)`;
}

function summaryOf(r: {
  pages: number;
  scale: number;
  pagesAtFullScale: number;
  pagesAsked?: number;
  paper: PaperFacts;
}): string {
  const count = `${r.pages} page${r.pages === 1 ? '' : 's'}, ${describePaper(r.paper)}`;
  if (r.pagesAsked === undefined) return `${count}, at scale 1.`;
  if (r.scale === 1) {
    return `${count}, at scale 1: it already fits on ${r.pagesAsked} page(s), nothing was shrunk.`;
  }
  return (
    `${count}, shrunk to scale ${r.scale} to fit on ${r.pagesAsked} page(s) ` +
    `(${r.pagesAtFullScale} page(s) at scale 1).`
  );
}

/** Le périmètre de lecture de `file_read`, pour la page et tout ce qu'elle charge. */
function localReader(ctx: ToolContext): (absPath: string) => Promise<LocalRead> {
  return async (absPath) => {
    let path: string;
    try {
      path = await resolveAndCheckPath(ctx, absPath);
    } catch (err) {
      if (err instanceof WorkspaceError) {
        return { ok: false, reason: `outside the folders this agent can read (${err.message})` };
      }
      throw err;
    }
    try {
      const info = await stat(path);
      if (!info.isFile()) return { ok: false, reason: 'not a file' };
      if (info.size > MAX_READ_FILE_BYTES) {
        return { ok: false, reason: `larger than ${MAX_READ_FILE_BYTES} bytes` };
      }
      const bytes = await readFile(path);
      ctx.reportReadContent?.(path, createHash('sha256').update(bytes).digest('hex'));
      return { ok: true, bytes };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return { ok: false, reason: code === 'ENOENT' ? 'file not found' : `unreadable (${code})` };
    }
  };
}

export const renderPdfTool: ToolDefinition<typeof RenderPdfInputSchema, RenderPdfOutput> = {
  name: 'render_pdf',
  label: 'Render a page to PDF',
  summary:
    "Turn an HTML page from the agent's folders into a PDF with Nodal's own page renderer, which shows nothing on screen. It can shrink the page to fit the number of pages asked.",
  description:
    "Nodal's headless browser render: turn an HTML page from your folders into a PDF with " +
    "Nodal's own headless Chrome, which opens no window. Use it whenever a task or a skill " +
    'calls for a headless browser or a pixel-perfect HTML-to-PDF render, never a browser ' +
    'launched by a command. Give `pages` to hold the PDF to at most that many pages: the tool ' +
    'finds the largest scale that fits by itself, in this one call, so do not cut or rewrite ' +
    "the text to make it fit. Without paper options the page's CSS `@page` decides, A4 " +
    'otherwise. The result states the page count, the scale and the paper, counted on the PDF ' +
    'written. Local images, CSS and fonts load from your folders by paths relative to the ' +
    'page; the public internet loads, local and private addresses do not, and what did not ' +
    'load is listed.',
  inputSchema: RenderPdfInputSchema,
  riskLevel: 'write',
  egress: 'internet',
  card: 'files',
  present: ({ output }) =>
    output.ok
      ? writtenFile(output.path, 'written', {
          bytes: output.bytes,
          detail: output.summary,
          ...(output.deliverable_key !== undefined
            ? { deliverableKey: output.deliverable_key }
            : {}),
        })
      : failureText(output.reason),
  mutatesWorkspace: true,
  // Le fichier que l'appel écrit, résolu comme `execute` le résout : la même
  // forme que `file_write` (la `catch` ne couvre que la résolution, #211).
  resolveMutationTargets: async (input, ctx) => {
    const target = pdfPath(input.output);
    if (target === null) return [];
    let path: string;
    try {
      path = await resolveAndCheckPath(ctx, target);
    } catch {
      return [];
    }
    return [
      { kind: 'file', path, deliverableType: await deliverableTypeForWrittenFile(ctx, path) },
    ];
  },
  // La porte d'écrasement de `file_write`, sur le PDF : remplacer un fichier
  // du dossier partagé que cet agent n'a pas écrit demande le réglage.
  replacesSharedFile: async (input, ctx) => {
    const target = pdfPath(input.output);
    if (target === null) return false;
    try {
      const path = await resolveAndCheckPath(ctx, target);
      if (await isProtectedWorkflowTemplate(ctx, path)) return false;
    } catch {
      return false;
    }
    return (await computeSharedOverwriteApproval(ctx, target)) === 'require_approval';
  },
  outcomeOf: outcomeOfOkFlag,
  execute: async (input, ctx) => {
    const target = pdfPath(input.output);
    if (target === null) {
      return {
        ok: false,
        reason: `The output is a PDF: "${input.output}" must end in .pdf (or have no extension).`,
      };
    }
    let source: string;
    let output: string;
    try {
      source = await resolveAndCheckPath(ctx, input.source);
      output = await resolveAndCheckPath(ctx, target);
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      throw err;
    }
    const info = await stat(source).catch(() => null);
    if (info === null) return { ok: false, reason: `File not found: "${input.source}".` };
    if (!info.isFile()) return { ok: false, reason: `"${input.source}" is not a file.` };
    if (await isProtectedWorkflowTemplate(ctx, output)) {
      return { ok: false, reason: WORKFLOW_TEMPLATE_PROTECTED_MESSAGE };
    }

    const status = await readRendererStatus();
    if (status.kind !== 'ready') return { ok: false, reason: rendererUnavailable(status) };

    const m = input.margins_mm;
    const marginsMm =
      m === undefined
        ? undefined
        : typeof m === 'number'
          ? { top: m, right: m, bottom: m, left: m }
          : m;
    let rendered;
    try {
      rendered = await renderPdf({
        executablePath: status.executablePath,
        source,
        readLocal: localReader(ctx),
        ...(input.pages !== undefined ? { maxPages: input.pages } : {}),
        paper: {
          ...(input.paper !== undefined ? { format: input.paper } : {}),
          ...(input.orientation !== undefined ? { orientation: input.orientation } : {}),
          ...(marginsMm !== undefined ? { marginsMm } : {}),
        },
        timeoutMs: RENDER_TIME_LIMIT_MS,
      });
    } catch (err) {
      if (err instanceof PageRenderError) return { ok: false, reason: err.message };
      throw err;
    }
    if (rendered.pdf.byteLength > MAX_PDF_BYTES) {
      return {
        ok: false,
        reason: `The PDF is ${rendered.pdf.byteLength} bytes, above the ${MAX_PDF_BYTES} this tool writes. Nothing was written.`,
      };
    }

    try {
      if (input.create_dirs) await mkdir(dirname(output), { recursive: true });
      const deliverableType =
        declaredWrittenFileType(ctx, output) ?? (await deliverableTypeForWrittenFile(ctx, output));
      const deliverableKey =
        deliverableType === 'document'
          ? fileDeliverableKey(
              output,
              (ctx.workspaces ?? []).map((w) => w.path),
              'document',
            )
          : null;
      await writeFileAtomically(ctx, output, rendered.pdf);
      return {
        ok: true,
        written: true,
        path: output,
        bytes: rendered.pdf.byteLength,
        pages: rendered.pages,
        scale: rendered.scale,
        pages_at_scale_1: rendered.pagesAtFullScale,
        ...(input.pages !== undefined ? { pages_asked: input.pages } : {}),
        paper: rendered.paper,
        ...(rendered.mixedSizes ? { mixed_sizes: true as const } : {}),
        ...(rendered.notLoaded.length > 0 ? { not_loaded: rendered.notLoaded } : {}),
        summary: summaryOf({
          pages: rendered.pages,
          scale: rendered.scale,
          pagesAtFullScale: rendered.pagesAtFullScale,
          ...(input.pages !== undefined ? { pagesAsked: input.pages } : {}),
          paper: rendered.paper,
        }),
        ...(deliverableKey !== null ? { deliverable_key: deliverableKey } : {}),
      };
    } catch (err) {
      if (err instanceof WorkspaceError) return { ok: false, reason: err.message };
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {
          ok: false,
          reason: `Parent directory does not exist for "${input.output}". Pass create_dirs:true to create it.`,
        };
      }
      throw err;
    }
  },
};
