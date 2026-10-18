// workflows/make-fixtures.ts — écrit les fixtures de bureau du banc.
//
//   pnpm --filter @nodal-agents/bench exec tsx src/workflows/make-fixtures.ts [fichier…]
//
// Les fichiers écrits (packages/bench/fixtures/office) sont VERSIONNÉS : un
// scénario est figé, sa fixture aussi. Ce script dit comment ils ont été
// faits, et les refait à l'identique en contenu (un zip Office porte une date :
// l'octet change, pas ce qu'un juge lit). Ne le relancer qu'en montant la
// version des scénarios qui les lisent. Nommer des fichiers (`bon-commande.docx`)
// n'écrit qu'eux : ajouter une fixture ne réécrit pas les autres.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import PptxGenJS from 'pptxgenjs';
import {
  CONTACTS_CSV,
  CONTRACT,
  HOME_HTML,
  INVOICE_PDF,
  MEETING_MD,
  MINUTES,
  OFFER_DECK,
  ORDER,
  PROJECT_DECK,
  QUARTER,
  REVIEW_DECK,
  STOCK,
  WEATHER_CSV,
} from './fixture-data';
import { FIXTURES_DIR } from './fixtures';
import { makePdf } from './pdf-write';

const OFFICE = join(FIXTURES_DIR, 'office');

async function workbook(
  file: string,
  sheet: string,
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  // Une date fixe : le classeur ne porte pas l'heure de sa fabrication.
  wb.created = new Date('2026-10-15T00:00:00Z');
  wb.modified = wb.created;
  const ws = wb.addWorksheet(sheet);
  ws.addRow([...header]);
  for (const r of rows) ws.addRow([...r]);
  await wb.xlsx.writeFile(join(OFFICE, file));
}

async function docx(file: string, children: Array<Paragraph | Table>): Promise<void> {
  const doc = new Document({ sections: [{ children }] });
  writeFileSync(join(OFFICE, file), await Packer.toBuffer(doc));
}

function table(rows: ReadonlyArray<readonly string[]>): Table {
  return new Table({
    rows: rows.map(
      (r) =>
        new TableRow({
          children: r.map((c) => new TableCell({ children: [new Paragraph({ text: c })] })),
        }),
    ),
  });
}

async function deck(file: string, slides: ReadonlyArray<readonly string[]>): Promise<void> {
  const pptx = new PptxGenJS();
  for (const [title, ...bullets] of slides) {
    const s = pptx.addSlide();
    s.addText(title!, { x: 0.5, y: 0.3, w: 9, h: 1, fontSize: 28, bold: true });
    if (bullets.length > 0) {
      s.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.5, w: 9, h: 4, fontSize: 18 },
      );
    }
  }
  writeFileSync(join(OFFICE, file), (await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

/** Chaque fixture, par son nom de fichier sous fixtures/office. */
const FIXTURES: Record<string, () => Promise<void> | void> = {
  'stock.xlsx': () => workbook('stock.xlsx', STOCK.sheet, STOCK.header, STOCK.rows),
  'ventes-trimestre.xlsx': () =>
    workbook('ventes-trimestre.xlsx', QUARTER.sheet, QUARTER.header, QUARTER.rows),
  'contacts.csv': () => writeFileSync(join(OFFICE, 'contacts.csv'), `${CONTACTS_CSV}\n`),
  'contrat.docx': () =>
    docx('contrat.docx', [
      new Paragraph({ text: CONTRACT.title, heading: HeadingLevel.HEADING_1 }),
      ...CONTRACT.paragraphs.map((t) => new Paragraph({ text: t })),
      table(CONTRACT.table),
    ]),
  'compte-rendu.docx': () =>
    docx('compte-rendu.docx', [
      new Paragraph({ text: MINUTES.title, heading: HeadingLevel.HEADING_1 }),
      ...MINUTES.paragraphs.map((t) => new Paragraph({ text: t })),
    ]),
  'bon-commande.docx': () =>
    docx('bon-commande.docx', [
      new Paragraph({ text: ORDER.title, heading: HeadingLevel.HEADING_1 }),
      ...ORDER.paragraphs.map((t) => new Paragraph({ text: t })),
      table(ORDER.table),
    ]),
  'projet.pptx': () => deck('projet.pptx', PROJECT_DECK),
  'bilan-2025.pptx': () => deck('bilan-2025.pptx', REVIEW_DECK),
  'offre.pptx': () => deck('offre.pptx', OFFER_DECK),
  'facture-bench.pdf': () =>
    writeFileSync(join(OFFICE, 'facture-bench.pdf'), makePdf([INVOICE_PDF])),
  'notes-reunion.md': () => writeFileSync(join(OFFICE, 'notes-reunion.md'), MEETING_MD),
  'meteo.csv': () => writeFileSync(join(OFFICE, 'meteo.csv'), `${WEATHER_CSV}\n`),
  'accueil.html': () => writeFileSync(join(OFFICE, 'accueil.html'), HOME_HTML),
};

async function main(names: readonly string[]): Promise<void> {
  const unknown = names.filter((n) => !(n in FIXTURES));
  if (unknown.length > 0)
    throw new Error(
      `unknown fixture(s): ${unknown.join(', ')} (known: ${Object.keys(FIXTURES).join(', ')})`,
    );
  mkdirSync(OFFICE, { recursive: true });
  const chosen = names.length > 0 ? names : Object.keys(FIXTURES);
  for (const name of chosen) await FIXTURES[name]!();
  console.log(`fixtures written under ${OFFICE}: ${chosen.join(', ')}`);
}

main(process.argv.slice(2)).catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
