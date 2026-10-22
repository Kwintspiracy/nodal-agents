// printer/pages.ts — les pages que l'impression aurait, et les images que le document désigne.
//
// L'imprimante du banc n'a pas de moteur de mise en page. Elle dit ce qu'elle
// SAIT : le nombre de pages d'un PDF (lu par pdf-parse, comme le fait le banc),
// une page pour une image, et pour un texte ou un HTML composé une ESTIMATION,
// étiquetée comme telle dans l'enregistrement (`pagesBasis`). Un contenu qu'elle
// ne sait pas lire n'a pas de nombre de pages : null, dit, jamais un 1 par défaut.

import { extname } from 'node:path';
import type { PrintRecord } from './record';

/** Lignes d'une page, et largeur d'une ligne, pour l'estimation d'un texte. */
const LINES_PER_PAGE = 60;
const CHARS_PER_LINE = 90;
/** Une image désignée occupe à peu près ce nombre de lignes. */
const LINES_PER_IMAGE = 15;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);

export interface PageCount {
  readonly pages: PrintRecord['pages'];
  readonly basis: PrintRecord['pagesBasis'];
  /** Pourquoi le serveur ne sait pas compter, quand `pages` est null. */
  readonly problem: string | null;
}

function linesOf(text: string): number {
  return text
    .split(/\r?\n/)
    .reduce((n, line) => n + Math.max(1, Math.ceil(line.length / CHARS_PER_LINE)), 0);
}

const pagesFor = (lines: number): number => Math.max(1, Math.ceil(lines / LINES_PER_PAGE));

/** Les `<img src>` d'un document HTML : les images qu'il désigne, dans l'ordre. */
export function htmlImages(html: string): Array<{ origin: string }> {
  const out: Array<{ origin: string }> = [];
  for (const m of html.matchAll(/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const origin = (m[1] ?? m[2] ?? m[3] ?? '').trim();
    if (origin !== '') out.push({ origin });
  }
  return out;
}

/** Le texte visible d'un HTML, grossièrement : sans balises, styles ni scripts. */
function visibleText(html: string): string {
  return html
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ');
}

export function estimateTextPages(text: string): PageCount {
  return { pages: pagesFor(linesOf(text)), basis: 'text-estimate', problem: null };
}

export function estimateHtmlPages(html: string): PageCount {
  const lines = linesOf(visibleText(html)) + htmlImages(html).length * LINES_PER_IMAGE;
  return { pages: pagesFor(lines), basis: 'html-estimate', problem: null };
}

/** Le nombre de pages d'un fichier imprimé tel quel, d'après son contenu et son extension. */
export async function countFilePages(path: string, bytes: Buffer): Promise<PageCount> {
  const ext = extname(path).toLowerCase();
  if (ext === '.pdf' || bytes.subarray(0, 5).toString('latin1') === '%PDF-') {
    try {
      // Chargé à la demande : pdfjs pèse, et seules les demandes de PDF en ont besoin.
      const { PDFParse } = await import('pdf-parse');
      const parser = new PDFParse({ data: new Uint8Array(bytes) });
      try {
        const r = await parser.getText();
        return { pages: r.total > 0 ? r.total : null, basis: 'pdf', problem: null };
      } finally {
        await parser.destroy();
      }
    } catch (e) {
      return {
        pages: null,
        basis: 'unknown',
        problem: `the PDF could not be read to count its pages: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }
  if (IMAGE_EXT.has(ext)) return { pages: 1, basis: 'image', problem: null };
  if (ext === '.txt' || ext === '.md') return estimateTextPages(bytes.toString('utf8'));
  if (ext === '.html' || ext === '.htm') return estimateHtmlPages(bytes.toString('utf8'));
  return {
    pages: null,
    basis: 'unknown',
    problem: `the bench printer cannot count the pages of a ${ext || 'extensionless'} file`,
  };
}
