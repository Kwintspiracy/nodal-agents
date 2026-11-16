// pdf-facts.ts — ce qu'un PDF produit EST : ses pages et leur format, lus
// dans le fichier (#1082). Jamais une estimation : c'est ce que l'outil dit à
// l'agent, et ce que les tests vérifient.

import { PDFDocument } from 'pdf-lib';

/** Les formats que l'outil sait nommer, en millimètres, portrait. */
export const PAPER_SIZES_MM = {
  A3: [297, 420],
  A4: [210, 297],
  A5: [148, 210],
  Letter: [215.9, 279.4],
  Legal: [215.9, 355.6],
  Tabloid: [279.4, 431.8],
} as const satisfies Record<string, readonly [number, number]>;

export type PaperName = keyof typeof PAPER_SIZES_MM;
export const PAPER_NAMES = Object.keys(PAPER_SIZES_MM) as PaperName[];

/** Le format d'une page, tel que le PDF le porte. */
export interface PaperFacts {
  /** Le nom du format quand la page en a un (à 1,5 mm près), sinon null. */
  name: PaperName | null;
  orientation: 'portrait' | 'landscape';
  width_mm: number;
  height_mm: number;
}

export interface PdfFacts {
  pages: number;
  /** Le format de la première page. */
  paper: PaperFacts;
  /** Vrai quand toutes les pages n'ont pas le même format. */
  mixedSizes: boolean;
}

const MM_PER_POINT = 25.4 / 72;
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Le format d'une page de `width` × `height` points. */
export function paperOf(widthPt: number, heightPt: number): PaperFacts {
  const w = widthPt * MM_PER_POINT;
  const h = heightPt * MM_PER_POINT;
  const [short, long] = w <= h ? [w, h] : [h, w];
  const name =
    PAPER_NAMES.find((n) => {
      const [a, b] = PAPER_SIZES_MM[n];
      return Math.abs(a - short) <= 1.5 && Math.abs(b - long) <= 1.5;
    }) ?? null;
  return {
    name,
    orientation: w > h ? 'landscape' : 'portrait',
    width_mm: round1(w),
    height_mm: round1(h),
  };
}

/** Les pages et le format de `pdf`. Lève si le fichier n'est pas un PDF lisible. */
export async function readPdfFacts(pdf: Uint8Array): Promise<PdfFacts> {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  const first = pages[0];
  if (first === undefined) throw new Error('the PDF has no page');
  const { width, height } = first.getSize();
  const mixedSizes = pages.some((p) => {
    const s = p.getSize();
    return Math.abs(s.width - width) > 1 || Math.abs(s.height - height) > 1;
  });
  return { pages: pages.length, paper: paperOf(width, height), mixedSizes };
}
