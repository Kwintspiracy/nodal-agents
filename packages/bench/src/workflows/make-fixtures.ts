// workflows/make-fixtures.ts — écrit les fixtures de bureau du banc.
//
//   pnpm --filter @nodal-agents/bench exec tsx src/workflows/make-fixtures.ts
//
// Les fichiers écrits (packages/bench/fixtures/office, fixtures/data) sont
// VERSIONNÉS : un scénario est figé, sa fixture aussi. Ce script dit comment
// ils ont été faits, et les refait à l'identique en contenu (un zip Office
// porte une date : l'octet change, pas ce qu'un juge lit). Ne le relancer
// qu'en montant la version des scénarios qui les lisent.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import PptxGenJS from 'pptxgenjs';
import {
  CONTACTS_CSV,
  CONTRACT,
  GUIDE_PDF,
  HOME_HTML,
  INVOICE_PDF,
  MEETING_MD,
  MINUTES,
  NOTES,
  OFFER_DECK,
  PROJECT_DECK,
  QUARTER,
  REVIEW_DECK,
  STOCK,
  WEATHER_CSV,
  salesCsv,
} from './fixture-data';
import { FIXTURES_DIR } from './fixtures';
import { makePdf } from './pdf-write';

const OFFICE = join(FIXTURES_DIR, 'office');
const DATA = join(FIXTURES_DIR, 'data');

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

async function main(): Promise<void> {
  mkdirSync(OFFICE, { recursive: true });
  mkdirSync(DATA, { recursive: true });

  await workbook('stock.xlsx', STOCK.sheet, STOCK.header, STOCK.rows);
  await workbook('notes.xlsx', NOTES.sheet, NOTES.header, NOTES.rows);
  await workbook('ventes-trimestre.xlsx', QUARTER.sheet, QUARTER.header, QUARTER.rows);
  writeFileSync(join(OFFICE, 'contacts.csv'), `${CONTACTS_CSV}\n`);

  await docx('contrat.docx', [
    new Paragraph({ text: CONTRACT.title, heading: HeadingLevel.HEADING_1 }),
    ...CONTRACT.paragraphs.map((t) => new Paragraph({ text: t })),
    new Table({
      rows: CONTRACT.table.map(
        (r) =>
          new TableRow({
            children: r.map((c) => new TableCell({ children: [new Paragraph({ text: c })] })),
          }),
      ),
    }),
  ]);
  await docx('compte-rendu.docx', [
    new Paragraph({ text: MINUTES.title, heading: HeadingLevel.HEADING_1 }),
    ...MINUTES.paragraphs.map((t) => new Paragraph({ text: t })),
  ]);

  await deck('projet.pptx', PROJECT_DECK);
  await deck('bilan-2025.pptx', REVIEW_DECK);
  await deck('offre.pptx', OFFER_DECK);

  writeFileSync(join(OFFICE, 'facture-bench.pdf'), makePdf([INVOICE_PDF]));
  writeFileSync(join(OFFICE, 'guide-bench.pdf'), makePdf(GUIDE_PDF));
  writeFileSync(join(OFFICE, 'notes-reunion.md'), MEETING_MD);
  writeFileSync(join(OFFICE, 'meteo.csv'), `${WEATHER_CSV}\n`);
  writeFileSync(join(OFFICE, 'accueil.html'), HOME_HTML);

  writeFileSync(join(DATA, 'ventes-regions.csv'), `${salesCsv()}\n`);
  console.log(`fixtures written under ${FIXTURES_DIR}`);
}

main().catch((e: unknown) => {
  console.error(e);
  process.exitCode = 1;
});
