// workflows/suites/excel.ts — créer et MODIFIER un classeur, vérifié en le relisant.
//
// Le juge rouvre le classeur avec exceljs (la bibliothèque des outils xlsx_* du
// produit) et lit chaque cellule comme Excel l'afficherait : un nombre, un
// texte, ou une formule CALCULÉE par le banc quand le fichier n'en garde pas
// le résultat (`evaluateCell`). Une modification est jugée sur deux faces : ce
// qui devait changer a changé, et ce qui ne devait pas changer est resté
// identique à la fixture du dépôt.

import { readFileSync } from 'node:fs';
import { readXlsxGrid, findInRoots, type SheetGrid } from '../disk';
import { fileHash, fixturePath, installed } from '../fixtures';
import { CONTACTS_CSV, QUARTER, STOCK } from '../fixture-data';
import {
  JUDGED_COMMON,
  answerOf,
  commonReasons,
  hasNumber,
  matches,
  missingFacts,
} from '../judge-kit';
import { evaluateCell } from '../office';
import { defineScenario, type AnyScenario } from '../types';
import { BASE, FILES, TEAM, XLSX, toolList } from '../scenario-tools';

const MIN = 60_000;
const SHARED = "de l'espace de travail partagé";

interface WorkbookObservation {
  readonly found: { path: string; fresh: boolean; hash: string } | null;
  readonly sheets: SheetGrid[] | null;
  readonly readError: string | null;
}

async function observeWorkbook(path: string | null, fresh: boolean): Promise<WorkbookObservation> {
  if (path === null) return { found: null, sheets: null, readError: null };
  const found = { path, fresh, hash: fileHash(path) };
  try {
    return { found, sheets: await readXlsxGrid(path), readError: null };
  } catch (e) {
    return { found, sheets: null, readError: String(e instanceof Error ? e.message : e) };
  }
}

const same = (a: string, b: string): boolean =>
  a.normalize('NFC').trim().toLowerCase() === b.normalize('NFC').trim().toLowerCase();

function findSheet(sheets: readonly SheetGrid[], name: string): SheetGrid | undefined {
  return sheets.find((s) => same(s.name, name));
}

/** La valeur affichée d'une cellule, ou la raison pour laquelle le banc ne peut pas la lire. */
function shown(sheets: readonly SheetGrid[], sheet: string, addr: string): number | string | null {
  const v = evaluateCell(sheets, sheet, addr);
  return v.ok ? v.value : null;
}
function why(sheets: readonly SheetGrid[], sheet: string, addr: string): string {
  const v = evaluateCell(sheets, sheet, addr);
  return v.ok ? JSON.stringify(v.value) : v.why;
}

/** Les cellules d'origine (en-tête + lignes) toujours là, à l'identique. */
function untouched(
  sheets: readonly SheetGrid[],
  sheet: string,
  header: readonly string[],
  rows: ReadonlyArray<ReadonlyArray<string | number>>,
): string[] {
  const out: string[] = [];
  [header, ...rows].forEach((row, i) =>
    row.forEach((want, c) => {
      const addr = `${String.fromCharCode(65 + c)}${i + 1}`;
      const got = shown(sheets, sheet, addr);
      const ok =
        typeof want === 'number' ? got === want : typeof got === 'string' && same(got, want);
      if (!ok)
        out.push(`${sheet}!${addr} was ${JSON.stringify(want)}, now ${why(sheets, sheet, addr)}`);
    }),
  );
  return out;
}

const near = (a: number, b: number, tol = 0.005): boolean => Math.abs(a - b) <= tol;

// ─── excel-edit-column ───────────────────────────────────────────────────────

export const STOCK_REL = 'nodal-bench/stock.xlsx';

const editColumn = defineScenario<WorkbookObservation>({
  id: 'excel-edit-column',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${STOCK_REL} with exceljs; it must be changed during the trial`,
    'sheet Stock: D1 "Valeur"; D2..D6 = quantity × unit price (a value, a cached result, or a formula the bench computes); D7 their total',
    "columns A to C are exactly the fixture's",
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (xlsx_*) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, XLSX),
  title: 'Edit a workbook without damaging the rest',
  path: 'xlsx_read, then xlsx_set_range. A script in their place is red.',
  deliverable: `${STOCK_REL}, changed`,
  productTools: {
    tools: ['xlsx_read', 'xlsx_set_range', 'xlsx_set_cell'],
    writes: [STOCK_REL],
    reads: [],
  },
  green: `${STOCK_REL} was changed during the run through the product's Excel tools (no command in their place): D1 reads "Valeur", D2 to D6 hold quantity × unit price, D7 their total (values or formulas the bench computes), columns A to C are exactly the fixture's, and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'excel',
  sends: 'nothing',
  instruction:
    `Dans le classeur ${STOCK_REL} ${SHARED}, ajoute une colonne D « Valeur » égale à la quantité ` +
    'multipliée par le prix unitaire pour chaque article, puis le total de la colonne D juste sous ' +
    'la dernière ligne.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/stock.xlsx', to: STOCK_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, STOCK_REL, env.startedMs);
    return observeWorkbook(f.exists ? f.path : null, f.fresh);
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.found) return [...r, `${STOCK_REL} is gone`];
    if (!o.found.fresh) r.push(`${STOCK_REL} was not changed during the run`);
    if (!o.sheets) return [...r, `${STOCK_REL} cannot be read as a workbook: ${o.readError}`];
    const s = STOCK.sheet;
    if (!findSheet(o.sheets, s)) return [...r, `no sheet "${s}" any more`];
    r.push(...untouched(o.sheets, s, STOCK.header, STOCK.rows));
    const d1 = shown(o.sheets, s, 'D1');
    if (typeof d1 !== 'string' || !same(d1, 'Valeur'))
      r.push(`D1 is ${why(o.sheets, s, 'D1')}, expected "Valeur"`);
    let total = 0;
    STOCK.rows.forEach(([, q, p], i) => {
      const addr = `D${i + 2}`;
      const want = Math.round(q * p * 100) / 100;
      total += want;
      const got = shown(o.sheets!, s, addr);
      if (typeof got !== 'number' || !near(got, want))
        r.push(`${addr} is ${why(o.sheets!, s, addr)}, expected ${want}`);
    });
    const tAddr = `D${STOCK.rows.length + 2}`;
    const t = shown(o.sheets, s, tAddr);
    const wantTotal = Math.round(total * 100) / 100;
    if (typeof t !== 'number' || !near(t, wantTotal))
      r.push(`${tAddr} is ${why(o.sheets, s, tAddr)}, expected the total ${wantTotal}`);
    return r;
  },
});

// ─── excel-read-answer ───────────────────────────────────────────────────────

export const QUARTER_REL = 'nodal-bench/ventes-trimestre.xlsx';

function bestProduct(): { name: string; total: number } {
  return QUARTER.rows
    .map(([name, ...m]) => ({ name, total: m.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.total - a.total)[0]!;
}

const readAnswer = defineScenario<{ hash: string | null }>({
  id: 'excel-read-answer',
  judgedBy: [
    ...JUDGED_COMMON,
    `the final answer names ${bestProduct().name} and gives ${bestProduct().total}`,
    `${QUARTER_REL} is byte for byte the fixture (sha-256)`,
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (xlsx_read) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, XLSX),
  title: 'Read a workbook and answer',
  green: `The answer names "${bestProduct().name}" and its quarter total ${bestProduct().total}, read through xlsx_read (no command in its place), ${QUARTER_REL} is byte for byte the fixture, and nobody was asked anything.`,
  path: 'xlsx_read. A script in its place is red.',
  deliverable: 'The answer, in the conversation',
  productTools: { tools: ['xlsx_read'], writes: [], reads: [QUARTER_REL] },
  set: 'on-demand',
  activity: 'excel',
  sends: 'nothing',
  instruction: `Dans le classeur ${QUARTER_REL} ${SHARED}, quel produit a le plus gros total de ventes sur le trimestre, et quel est ce total ?`,
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/ventes-trimestre.xlsx', to: QUARTER_REL }],
  async observe(_facts, env) {
    const f = installed(env.workspaceRoots, QUARTER_REL, env.startedMs);
    return { hash: f.exists ? fileHash(f.path) : null };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    const best = bestProduct();
    r.push(
      ...missingFacts(
        answerOf(facts),
        [
          matches(new RegExp(best.name.replace(/é/g, '[ée]'), 'i'), `name ${best.name}`),
          hasNumber(best.total, 0, `give ${best.total}`),
        ],
        'the answer',
      ),
    );
    if (o.hash !== fileHash(fixturePath('office/ventes-trimestre.xlsx')))
      r.push(`${QUARTER_REL} was changed or removed`);
    return r;
  },
});

// ─── excel-csv-import ────────────────────────────────────────────────────────

export const CONTACTS_CSV_REL = 'nodal-bench/contacts.csv';
export const CONTACTS_XLSX_REL = 'nodal-bench/contacts.xlsx';
const CONTACTS_SHEET = 'Contacts';

const csvImport = defineScenario<WorkbookObservation>({
  id: 'excel-csv-import',
  judgedBy: [
    ...JUDGED_COMMON,
    `opens ${CONTACTS_XLSX_REL} with exceljs, written during the trial`,
    `sheet "${CONTACTS_SHEET}": every cell equals the CSV's, header first, same order, and nothing outside`,
  ],
  // v2 (catalogue du 17/10) : la règle des outils du produit (xlsx_*) s'applique.
  // v3 (1B) : la liste d'outils fermée de l'essai (scenario-tools.ts).
  version: 3,
  tools: toolList(BASE, FILES, TEAM, XLSX),
  title: 'Convert data faithfully',
  path: 'Read the CSV, then xlsx_create. A script in its place is red.',
  deliverable: CONTACTS_XLSX_REL,
  productTools: {
    tools: ['xlsx_create', 'xlsx_set_range', 'xlsx_append_rows'],
    writes: [CONTACTS_XLSX_REL],
    reads: [],
  },
  green: `${CONTACTS_XLSX_REL} was written during the run through the product's Excel tools (no command in their place) with a sheet "${CONTACTS_SHEET}" whose rows are exactly the CSV's (header first, same order, nothing more), and nobody was asked anything.`,
  set: 'on-demand',
  activity: 'excel',
  sends: 'nothing',
  instruction:
    `Convertis le fichier ${CONTACTS_CSV_REL} ${SHARED} en un classeur Excel ${CONTACTS_XLSX_REL} : ` +
    `une feuille « ${CONTACTS_SHEET} », la ligne d'en-tête du CSV en ligne 1, puis une ligne par ` +
    'contact, dans le même ordre.',
  timeoutMs: 10 * MIN,
  fixtures: [{ from: 'office/contacts.csv', to: CONTACTS_CSV_REL }],
  outputs: [CONTACTS_XLSX_REL],
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, CONTACTS_XLSX_REL, env.startedMs);
    return observeWorkbook(hit?.path ?? null, hit?.fresh ?? false);
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.found) return [...r, `no file ${CONTACTS_XLSX_REL} in any workspace folder`];
    if (!o.found.fresh) r.push(`${CONTACTS_XLSX_REL} was not written during the run`);
    if (!o.sheets)
      return [...r, `${CONTACTS_XLSX_REL} cannot be read as a workbook: ${o.readError}`];
    const sheet = findSheet(o.sheets, CONTACTS_SHEET);
    if (!sheet)
      return [
        ...r,
        `no sheet "${CONTACTS_SHEET}" (sheets: ${o.sheets.map((s) => s.name).join(', ')})`,
      ];
    const want = readFileSync(fixturePath('office/contacts.csv'), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map((l) => l.split(','));
    want.forEach((row, i) =>
      row.forEach((cell, c) => {
        const addr = `${String.fromCharCode(65 + c)}${i + 1}`;
        const got = shown(o.sheets!, sheet.name, addr);
        if (typeof got !== 'string' || got.trim() !== cell)
          r.push(
            `${addr} is ${why(o.sheets!, sheet.name, addr)}, expected ${JSON.stringify(cell)}`,
          );
      }),
    );
    const extra = Object.keys(sheet.cells).filter((a) => {
      const m = /^([A-Z]+)(\d+)$/.exec(a)!;
      return (
        Number(m[2]) > want.length ||
        m[1]!.length > 1 ||
        m[1]!.charCodeAt(0) - 65 >= want[0]!.length
      );
    });
    if (extra.length > 0) r.push(`cells outside the CSV: ${extra.slice(0, 5).join(', ')}`);
    return r;
  },
});

/** Le CSV de la fixture, aussi exporté pour les tests. */
export { CONTACTS_CSV };

export const EXCEL_SCENARIOS: AnyScenario[] = [editColumn, readAnswer, csvImport];
