// workflows/suites/pdf.ts — lire un PDF et en produire un, vérifié en le relisant.
//
// Le juge lit un PDF avec pdf-parse (la bibliothèque de l'extracteur PDF du
// produit) : nombre de pages et texte de chaque page. Une lecture est jugée sur
// la réponse, plus l'intégrité du fichier lu ; une production, sur le fichier.

import { readFileSync } from 'node:fs';
import { findInRoots } from '../disk';
import { fileHash, fixturePath, installed } from '../fixtures';
import { INVOICE_NUMBER, INVOICE_TOTAL } from '../fixture-data';
import {
  JUDGED_COMMON,
  answerOf,
  commonReasons,
  hasNumber,
  matches,
  missingFacts,
} from '../judge-kit';
import { normalizeSpace, readPdf, type PdfView } from '../office';
import { defineScenario, type AnyScenario } from '../types';

const MIN = 60_000;
const SHARED = "de l'espace de travail partagé";

/** Un fichier lu, tel qu'il était à la fin de l'essai. */
function untouchedReason(rel: string, fixture: string, hash: string | null): string[] {
  return hash === fileHash(fixturePath(fixture)) ? [] : [`${rel} was changed or removed`];
}

// ─── lectures ────────────────────────────────────────────────────────────────

export const INVOICE_REL = 'nodal-bench/facture-bench.pdf';
export const GUIDE_REL = 'nodal-bench/guide-bench.pdf';

const readTotal = defineScenario<{ hash: string | null }>({
  id: 'pdf-read-total',
  judgedBy: [
    ...JUDGED_COMMON,
    `the final answer gives ${INVOICE_TOTAL} (any writing) and ${INVOICE_NUMBER}`,
    `${INVOICE_REL} is byte for byte the fixture (sha-256)`,
  ],
  version: 1,
  title: 'Read an amount and a number from a PDF invoice',
  green: `The answer gives the total ${INVOICE_TOTAL} and the invoice number ${INVOICE_NUMBER}, ${INVOICE_REL} is byte for byte the fixture, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'pdf',
  sends: 'nothing',
  instruction: `Quel est le montant total TTC de la facture ${INVOICE_REL} ${SHARED}, et quel est son numéro ?`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/facture-bench.pdf', to: INVOICE_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, INVOICE_REL, env.startedMs);
    return { hash: f.exists ? fileHash(f.path) : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(
      ...missingFacts(
        answerOf(facts),
        [
          hasNumber(INVOICE_TOTAL, 2, `give ${INVOICE_TOTAL}`),
          matches(new RegExp(INVOICE_NUMBER), `give ${INVOICE_NUMBER}`),
        ],
        'the answer',
      ),
    );
    r.push(...untouchedReason(INVOICE_REL, 'office/facture-bench.pdf', o.hash));
    return r;
  },
});

const readPages = defineScenario<{ hash: string | null }>({
  id: 'pdf-read-pages',
  judgedBy: [
    ...JUDGED_COMMON,
    'the final answer says 3 pages and names Installation (the title of page 2)',
    `${GUIDE_REL} is byte for byte the fixture (sha-256)`,
  ],
  version: 1,
  title: 'Count the pages of a PDF and read one of them',
  green: `The answer says the PDF has 3 pages and that page 2 is about installation, ${GUIDE_REL} is byte for byte the fixture, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'pdf',
  sends: 'nothing',
  instruction: `Combien de pages compte le document ${GUIDE_REL} ${SHARED}, et quel est le titre de la page 2 ?`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/guide-bench.pdf', to: GUIDE_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, GUIDE_REL, env.startedMs);
    return { hash: f.exists ? fileHash(f.path) : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    r.push(
      ...missingFacts(
        answerOf(facts),
        [
          matches(/\b(3|trois)\s+pages?\b/i, 'say it has 3 pages'),
          matches(/installation/i, 'give the title of page 2 (Installation)'),
        ],
        'the answer',
      ),
    );
    r.push(...untouchedReason(GUIDE_REL, 'office/guide-bench.pdf', o.hash));
    return r;
  },
});

// ─── productions ─────────────────────────────────────────────────────────────

interface PdfObservation {
  readonly found: { path: string; fresh: boolean } | null;
  readonly pdf: PdfView | null;
  readonly readError: string | null;
  /** Le Markdown d'origine, pour une conversion. */
  readonly source?: string;
}

async function observePdf(
  roots: readonly string[],
  rel: string,
  sinceMs: number,
): Promise<PdfObservation> {
  const [hit] = findInRoots(roots, rel, sinceMs);
  if (!hit) return { found: null, pdf: null, readError: null };
  const found = { path: hit.path, fresh: hit.fresh };
  try {
    return { found, pdf: await readPdf(hit.path), readError: null };
  } catch (e) {
    return { found, pdf: null, readError: String(e instanceof Error ? e.message : e) };
  }
}

function pdfReasons(rel: string, o: PdfObservation): { r: string[]; pdf: PdfView | null } {
  if (!o.found) return { r: [`no file ${rel} in any workspace folder`], pdf: null };
  const r: string[] = [];
  if (!o.found.fresh) r.push(`${rel} was not written during the run`);
  if (!o.pdf) return { r: [...r, `${rel} cannot be read as a PDF: ${o.readError}`], pdf: null };
  return { r, pdf: o.pdf };
}

const pdfText = (pdf: PdfView): string => normalizeSpace(pdf.pageTexts.join(' ')).toLowerCase();

export const CERTIFICATE_REL = 'nodal-bench/attestation-bench.pdf';
const CERTIFICATE_LINES = ['Attestation de participation', 'Camille Martin', '15 octobre 2026'];

const create = defineScenario<PdfObservation>({
  id: 'pdf-create',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${CERTIFICATE_REL} with pdf-parse (the product's PDF extractor), written during the trial`,
    `exactly one page, whose text holds ${CERTIFICATE_LINES.map((l) => `"${l}"`).join(', ')}`,
  ],
  version: 1,
  title: 'Produce a one-page PDF',
  green: `${CERTIFICATE_REL} was written during the run, opens as a PDF of exactly one page whose text holds "${CERTIFICATE_LINES.join('", "')}", and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'pdf',
  sends: 'nothing',
  instruction:
    `Crée un PDF d'une seule page ${CERTIFICATE_REL} dans ton espace de travail, qui contient le ` +
    `titre « ${CERTIFICATE_LINES[0]} », le nom « ${CERTIFICATE_LINES[1]} » et la date du ${CERTIFICATE_LINES[2]}.`,
  timeoutMs: 10 * MIN,
  outputs: [CERTIFICATE_REL],
  observe: (_facts, env) => observePdf(env.workspaceRoots, CERTIFICATE_REL, env.startedMs),
  judge(facts, o) {
    const { r, pdf } = pdfReasons(CERTIFICATE_REL, o);
    r.unshift(...commonReasons(facts));
    if (!pdf) return r;
    if (pdf.pages !== 1) r.push(`${pdf.pages} page(s), expected 1`);
    const t = pdfText(pdf);
    for (const line of CERTIFICATE_LINES)
      if (!t.includes(line.toLowerCase())) r.push(`the PDF text does not hold "${line}"`);
    return r;
  },
});

export const MEETING_MD_REL = 'nodal-bench/notes-reunion.md';
export const MEETING_PDF_REL = 'nodal-bench/notes-reunion.pdf';

/** Les titres et les éléments de liste d'un Markdown, sans leurs marques. */
export function markdownItems(md: string): string[] {
  return md
    .split(/\r?\n/)
    .map((l) => /^\s*(?:#{1,6}|[-*+]|\d+\.)\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
}

const fromMarkdown = defineScenario<PdfObservation>({
  id: 'pdf-from-markdown',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${MEETING_PDF_REL} with pdf-parse, written during the trial`,
    `its text holds every heading and list item of ${MEETING_MD_REL}, which is left untouched`,
  ],
  version: 1,
  title: 'Convert a Markdown note into a PDF',
  green: `${MEETING_PDF_REL} was written during the run, opens as a PDF, and its text holds every heading and list item of the fixture ${MEETING_MD_REL} (which is left untouched), and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'pdf',
  sends: 'nothing',
  instruction: `Convertis la note ${MEETING_MD_REL} ${SHARED} en PDF : ${MEETING_PDF_REL}, avec tous ses titres et tout son contenu.`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/notes-reunion.md', to: MEETING_MD_REL }],
  outputs: [MEETING_PDF_REL],
  async observe(_facts, env) {
    const md = installed(env.workspaceRoots, MEETING_MD_REL, env.startedMs);
    return {
      ...(await observePdf(env.workspaceRoots, MEETING_PDF_REL, env.startedMs)),
      source: md.exists ? readFileSync(md.path, 'utf8') : '',
    };
  },
  judge(facts, o) {
    const { r, pdf } = pdfReasons(MEETING_PDF_REL, o);
    r.unshift(...commonReasons(facts));
    const fixture = readFileSync(fixturePath('office/notes-reunion.md'), 'utf8');
    if (o.source !== fixture) r.push(`${MEETING_MD_REL} was changed or removed`);
    if (!pdf) return r;
    const t = pdfText(pdf);
    const missing = markdownItems(fixture).filter(
      (x) => !t.includes(normalizeSpace(x).toLowerCase()),
    );
    if (missing.length > 0)
      r.push(`the PDF text does not hold: ${missing.map((m) => `"${m}"`).join(', ')}`);
    return r;
  },
});

export const PDF_SCENARIOS: AnyScenario[] = [readTotal, readPages, create, fromMarkdown];
