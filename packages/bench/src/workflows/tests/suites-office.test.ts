// suites-office.test.ts — les juges Excel, Word, PowerPoint et PDF, sur de vrais fichiers.
//
// Chaque livrable est écrit avec la bibliothèque qu'un agent utiliserait
// (exceljs, docx, pptxgenjs, un PDF écrit à la main), dans le dossier où
// `prepare` a posé la fixture. Une modification est éprouvée des deux côtés :
// ce qui devait changer, et ce qui devait rester.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow } from 'docx';
import PptxGenJS from 'pptxgenjs';
import { describe, expect, it } from 'vitest';
import { CONTACTS_CSV, MEETING_MD, NOTES, PROJECT_DECK, REVIEW_DECK, STOCK } from '../fixture-data';
import type { SheetGrid } from '../disk';
import { evaluateCell } from '../office';
import { makePdf } from '../pdf-write';
import { play } from './harness';

const bench = (root: string, name: string): string => {
  mkdirSync(join(root, 'nodal-bench'), { recursive: true });
  return join(root, 'nodal-bench', name);
};

// ─── Excel ───────────────────────────────────────────────────────────────────

async function editWorkbook(path: string, edit: (wb: ExcelJS.Workbook) => void): Promise<void> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  edit(wb);
  await wb.xlsx.writeFile(path);
}

describe('the formula evaluator', () => {
  const sheets: SheetGrid[] = [
    {
      name: 'Notes',
      cells: {
        B2: { kind: 'number' as const, value: 17 },
        C2: { kind: 'number' as const, value: 15 },
        D2: { kind: 'number' as const, value: 18 },
      },
    },
    {
      name: 'Moyennes',
      cells: {
        B2: { kind: 'formula' as const, formula: 'ROUND(AVERAGE(Notes!B2:D2),2)', result: null },
        B3: { kind: 'formula' as const, formula: '(Notes!B2+Notes!C2)*2-1', result: null },
        B4: { kind: 'formula' as const, formula: 'VLOOKUP(A1,Notes!A:B,2)', result: null },
      },
    },
  ];
  it('computes references, ranges, functions and precedence', () => {
    expect(evaluateCell(sheets, 'Moyennes', 'B2')).toEqual({ ok: true, value: 16.67 });
    expect(evaluateCell(sheets, 'Moyennes', 'B3')).toEqual({ ok: true, value: 63 });
  });
  it('says what it cannot compute, never guesses a number', () => {
    expect(evaluateCell(sheets, 'Moyennes', 'B4')).toMatchObject({ ok: false });
  });
});

describe('excel judges', () => {
  it('excel-edit-column: formulas without cached results are computed and green', async () => {
    const r = await play('excel-edit-column', {}, (root) =>
      editWorkbook(join(root, 'nodal-bench', 'stock.xlsx'), (wb) => {
        const ws = wb.getWorksheet('Stock')!;
        ws.getCell('D1').value = 'Valeur';
        for (let i = 2; i <= 6; i++)
          ws.getCell(`D${i}`).value = { formula: `B${i}*C${i}` } as ExcelJS.CellValue;
        ws.getCell('D7').value = { formula: 'SUM(D2:D6)' } as ExcelJS.CellValue;
      }),
    );
    expect(r.reasons).toEqual([]);
  });

  it('excel-edit-column: a wrong value and a changed original cell are both named', async () => {
    const r = await play('excel-edit-column', {}, (root) =>
      editWorkbook(join(root, 'nodal-bench', 'stock.xlsx'), (wb) => {
        const ws = wb.getWorksheet('Stock')!;
        ws.getCell('D1').value = 'Valeur';
        STOCK.rows.forEach(([, q, p], i) => (ws.getCell(`D${i + 2}`).value = q * p));
        ws.getCell('D3').value = 1;
        ws.getCell('B2').value = 121;
        ws.getCell('D7').value = { formula: 'SUM(D2:D6)' } as ExcelJS.CellValue;
      }),
    );
    expect(r.reasons).toEqual([
      'Stock!B2 was 120, now 121',
      'D3 is 1, expected 108',
      // 120 × 0,85 + 1 + 30 × 4,75 + 12 × 9,9 + 200 × 0,35, contre 541,3 attendus.
      'D7 is 434.3, expected the total 541.3',
    ]);
  });

  it('excel-edit-column: the workbook left as it was is red', async () => {
    const r = await play('excel-edit-column', {});
    expect(r.reasons[0]).toBe('nodal-bench/stock.xlsx was not changed during the run');
  });

  it('excel-new-sheet: a sheet of AVERAGE formulas across sheets is green; a missing pupil is red', async () => {
    const write = (skip: string | null) => (root: string) =>
      editWorkbook(join(root, 'nodal-bench', 'notes.xlsx'), (wb) => {
        const ws = wb.addWorksheet('Moyennes');
        NOTES.rows.forEach(([name], i) => {
          if (name === skip) return;
          ws.getCell(`A${i + 1}`).value = name;
          ws.getCell(`B${i + 1}`).value = {
            formula: `ROUND(AVERAGE(Notes!B${i + 2}:D${i + 2}),2)`,
          } as ExcelJS.CellValue;
        });
      });
    expect((await play('excel-new-sheet', {}, write(null))).reasons).toEqual([]);
    expect((await play('excel-new-sheet', {}, write('Bruno'))).reasons).toEqual([
      'no row for Bruno in "Moyennes"',
    ]);
  });

  it('excel-read-answer: the right answer and an untouched file is green; a saved file is red', async () => {
    const answer = 'Le Café moulu, avec 550 ventes sur le trimestre.';
    expect((await play('excel-read-answer', { result: answer })).reasons).toEqual([]);
    const r = await play('excel-read-answer', { result: answer }, (root) =>
      editWorkbook(join(root, 'nodal-bench', 'ventes-trimestre.xlsx'), () => undefined),
    );
    expect(r.reasons).toEqual(['nodal-bench/ventes-trimestre.xlsx was changed or removed']);
  });

  it('excel-csv-import: the CSV rows, e-mails as links, is green; a dropped row is red', async () => {
    const rows = CONTACTS_CSV.split('\n').map((l) => l.split(','));
    const write = (drop: number | null) => async (root: string) => {
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Contacts');
      rows
        .filter((_, i) => i !== drop)
        .forEach((r, i) => {
          r.forEach((v, c) => {
            ws.getCell(i + 1, c + 1).value =
              c === 1 && i > 0 ? ({ text: v, hyperlink: `mailto:${v}` } as ExcelJS.CellValue) : v;
          });
        });
      await wb.xlsx.writeFile(bench(root, 'contacts.xlsx'));
    };
    expect((await play('excel-csv-import', {}, write(null))).reasons).toEqual([]);
    const r = await play('excel-csv-import', {}, write(3));
    expect(r.reasons[0]).toBe('A4 is "Nathan Robert", expected "Léa Petit"');
  });
});

// ─── Word ────────────────────────────────────────────────────────────────────

async function writeDocx(path: string, children: Array<Paragraph | Table>): Promise<void> {
  writeFileSync(path, await Packer.toBuffer(new Document({ sections: [{ children }] })));
}

/** Modifie le XML d'un document Word existant, comme un outil de remplacement le ferait. */
async function editDocxXml(path: string, edit: (xml: string) => string): Promise<void> {
  const zip = await JSZip.loadAsync(readFileSync(path));
  const xml = await zip.file('word/document.xml')!.async('string');
  zip.file('word/document.xml', edit(xml));
  writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer' }));
}

const para = (text: string): string =>
  `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const heading = (text: string): string =>
  `<w:p><w:pPr><w:pStyle w:val="Titre1"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`;

describe('word judges', () => {
  it('word-create: a heading and three paragraphs naming date, hour and room is green', async () => {
    const r = await play('word-create', {}, (root) =>
      writeDocx(bench(root, 'convocation-bench.docx'), [
        new Paragraph({ text: 'Convocation', heading: HeadingLevel.HEADING_1 }),
        new Paragraph({ text: 'L’équipe est convoquée le 12 novembre 2026.' }),
        new Paragraph({ text: 'La réunion commence à 14 h.' }),
        new Paragraph({ text: 'Elle se tient en salle B.' }),
      ]),
    );
    expect(r.reasons).toEqual([]);
  });

  it('word-create: "Convocation" as plain bold text is not a heading', async () => {
    const r = await play('word-create', {}, (root) =>
      writeDocx(bench(root, 'convocation-bench.docx'), [
        new Paragraph({ text: 'Convocation' }),
        new Paragraph({ text: 'Le 12 novembre 2026 à 14 h en salle B.' }),
      ]),
    );
    expect(r.reasons).toEqual(['no heading paragraph reads "Convocation"']);
  });

  it('word-replace: every occurrence replaced, table included, nothing else changed: green', async () => {
    const r = await play('word-replace', {}, (root) =>
      editDocxXml(join(root, 'nodal-bench', 'contrat.docx'), (x) =>
        x.split('ACME SARL').join('Nodal Bench SAS'),
      ),
    );
    expect(r.reasons).toEqual([]);
  });

  it('word-replace: the table forgotten, and a word changed elsewhere, are both red', async () => {
    const r = await play('word-replace', {}, (root) =>
      editDocxXml(join(root, 'nodal-bench', 'contrat.docx'), (x) => {
        const [body, table] = x.split('<w:tbl>');
        return `${body!.split('ACME SARL').join('Nodal Bench SAS').replace('trente', 'quarante')}<w:tbl>${table}`;
      }),
    );
    expect(r.reasons).toEqual([
      '"ACME SARL" still appears 1 time(s)',
      '"Nodal Bench SAS" appears 3 time(s), expected 4',
      'the rest of the text is not the fixture’s: something else changed',
    ]);
  });

  it('word-append: a French-styled heading and three decisions after the original text is green', async () => {
    const r = await play('word-append', {}, (root) =>
      editDocxXml(join(root, 'nodal-bench', 'compte-rendu.docx'), (x) =>
        x.replace(
          '<w:sectPr',
          `${heading('Décisions')}${para('Lancer l’offre.')}${para('Budget validé.')}${para('Recruter.')}<w:sectPr`,
        ),
      ),
    );
    expect(r.reasons).toEqual([]);
  });

  it('word-append: a section put FIRST breaks the original order', async () => {
    const r = await play('word-append', {}, (root) =>
      editDocxXml(join(root, 'nodal-bench', 'compte-rendu.docx'), (x) =>
        x.replace(
          '<w:body>',
          `<w:body>${heading('Décisions')}${para('a')}${para('b')}${para('c')}`,
        ),
      ),
    );
    expect(r.reasons[0]).toMatch(/^paragraph 1 is "Décisions", expected the fixture's$/);
  });

  it('word-table: the header and the five weekdays is green; a missing Friday is red', async () => {
    const table = (days: string[]) =>
      new Table({
        rows: [
          ['Jour', 'Tâche', 'Responsable'],
          ...days.map((d) => [d, 'Inventaire', 'Alice']),
        ].map(
          (row) =>
            new TableRow({
              children: row.map((c) => new TableCell({ children: [new Paragraph(c)] })),
            }),
        ),
      });
    const days = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi'];
    expect(
      (
        await play('word-table', {}, (root) =>
          writeDocx(bench(root, 'planning-bench.docx'), [table(days)]),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('word-table', {}, (root) =>
      writeDocx(bench(root, 'planning-bench.docx'), [table(days.slice(0, 4))]),
    );
    expect(r.reasons).toEqual(['no row for vendredi']);
  });
});

// ─── PowerPoint ──────────────────────────────────────────────────────────────

async function writeDeck(path: string, slides: ReadonlyArray<readonly string[]>): Promise<void> {
  const pptx = new PptxGenJS();
  for (const [title, ...bullets] of slides) {
    const s = pptx.addSlide();
    s.addText(title!, { x: 0.5, y: 0.3, w: 9, h: 1 });
    if (bullets.length > 0)
      s.addText(
        bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.5, y: 1.5, w: 9, h: 4 },
      );
  }
  writeFileSync(path, (await pptx.write({ outputType: 'nodebuffer' })) as Buffer);
}

describe('powerpoint judges', () => {
  const GLASS = [
    ['Le recyclage du verre'],
    ['Pourquoi', 'Le verre se recycle à l’infini', 'Moins d’énergie'],
    ['Comment', 'Le tri', 'La collecte'],
    ['Chiffres', '80 % recyclé', '1 bouteille = 1 bouteille'],
    ['Agir', 'Trier', 'Réduire'],
  ];

  it('ppt-create: five slides, a title slide and four contents is green; four slides is red', async () => {
    expect(
      (
        await play('ppt-create', {}, (root) =>
          writeDeck(bench(root, 'presentation-bench.pptx'), GLASS),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('ppt-create', {}, (root) =>
      writeDeck(bench(root, 'presentation-bench.pptx'), GLASS.slice(0, 4)),
    );
    expect(r.reasons).toEqual(['4 slide(s), expected 5']);
  });

  it('ppt-append: the deck rewritten with the three slides kept and a fourth is green', async () => {
    const r = await play('ppt-append', {}, (root) =>
      writeDeck(join(root, 'nodal-bench', 'projet.pptx'), [
        ...PROJECT_DECK,
        ['Prochaines étapes', 'Valider', 'Lancer', 'Mesurer'],
      ]),
    );
    expect(r.reasons).toEqual([]);
  });

  it('ppt-append: an original slide altered is red, with what it reads', async () => {
    const changed = [
      PROJECT_DECK[0]!,
      ['Objectifs', 'Réduire les délais'],
      PROJECT_DECK[2]!,
      ['Prochaines étapes', 'a', 'b', 'c'],
    ];
    const r = await play('ppt-append', {}, (root) =>
      writeDeck(join(root, 'nodal-bench', 'projet.pptx'), changed),
    );
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(
      /^slide 2 reads \["Objectifs","Réduire les délais"\], expected the fixture's/,
    );
  });

  it('ppt-replace: every 2025 turned into 2026 is green; one left over is red', async () => {
    const swap = (deck: ReadonlyArray<readonly string[]>) =>
      deck.map((s) => s.map((t) => t.replace(/2025/g, '2026')));
    expect(
      (
        await play('ppt-replace', {}, (root) =>
          writeDeck(join(root, 'nodal-bench', 'bilan-2025.pptx'), swap(REVIEW_DECK)),
        )
      ).reasons,
    ).toEqual([]);
    const partial = [...swap(REVIEW_DECK.slice(0, 2)), REVIEW_DECK[2]!];
    const r = await play('ppt-replace', {}, (root) =>
      writeDeck(join(root, 'nodal-bench', 'bilan-2025.pptx'), partial),
    );
    expect(r.reasons[0]).toBe('2025 still appears');
  });

  it('ppt-read-answer: 4 slides and 49 € is green; a wrong count is red', async () => {
    expect(
      (
        await play('ppt-read-answer', {
          result: 'La présentation compte 4 diapositives ; la formule Pro coûte 49 € par mois.',
        })
      ).reasons,
    ).toEqual([]);
    expect(
      (await play('ppt-read-answer', { result: '3 diapositives, Pro à 49 €.' })).reasons,
    ).toEqual(['the answer does not say it has 4 slides']);
  });
});

// ─── PDF ─────────────────────────────────────────────────────────────────────

describe('pdf judges', () => {
  it('pdf-read-total: the total written "1 234,56 €" and the number is green', async () => {
    expect(
      (await play('pdf-read-total', { result: 'Facture FB-2026-117 : total TTC 1 234,56 €.' }))
        .reasons,
    ).toEqual([]);
    expect((await play('pdf-read-total', { result: 'Total : 1 028,80 € HT.' })).reasons).toEqual([
      'the answer does not give 1234.56',
      'the answer does not give FB-2026-117',
    ]);
  });

  it('pdf-read-pages: "trois pages" and the chapter title is green', async () => {
    expect(
      (
        await play('pdf-read-pages', {
          result: 'Le guide fait trois pages ; la page 2 s’intitule « Chapitre 2 : Installation ».',
        })
      ).reasons,
    ).toEqual([]);
  });

  it('pdf-create: one page holding the three lines is green; two pages is red', async () => {
    const lines = [
      'Attestation de participation',
      'Nous attestons que Camille Martin a participé.',
      'Fait le 15 octobre 2026',
    ];
    expect(
      (
        await play('pdf-create', {}, (root) =>
          writeFileSync(bench(root, 'attestation-bench.pdf'), makePdf([lines])),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('pdf-create', {}, (root) =>
      writeFileSync(
        bench(root, 'attestation-bench.pdf'),
        makePdf([lines.slice(0, 2), lines.slice(2)]),
      ),
    );
    expect(r.reasons).toEqual(['2 page(s), expected 1']);
  });

  it('pdf-create: a file that is not a PDF is red, with the reader’s words', async () => {
    const r = await play('pdf-create', {}, (root) =>
      writeFileSync(bench(root, 'attestation-bench.pdf'), 'pas un pdf'),
    );
    expect(r.reasons).toHaveLength(1);
    expect(r.reasons[0]).toMatch(/^nodal-bench\/attestation-bench\.pdf cannot be read as a PDF: /);
  });

  it('pdf-from-markdown: every heading and item is green; a dropped item is named', async () => {
    const all = MEETING_MD.split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => l.replace(/^[#\-\s]+/, ''));
    expect(
      (
        await play('pdf-from-markdown', {}, (root) =>
          writeFileSync(bench(root, 'notes-reunion.pdf'), makePdf([all])),
        )
      ).reasons,
    ).toEqual([]);
    const r = await play('pdf-from-markdown', {}, (root) =>
      writeFileSync(
        bench(root, 'notes-reunion.pdf'),
        makePdf([all.filter((l) => l !== 'Recruter un designer')]),
      ),
    );
    expect(r.reasons).toEqual(['the PDF text does not hold: "Recruter un designer"']);
  });
});
