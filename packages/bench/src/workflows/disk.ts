// workflows/disk.ts — ce qu'un essai a laissé sur le disque.
//
// Quand un scénario promet un fichier, le juge lit LE FICHIER : il existe, il a
// été écrit pendant l'essai (sa date le dit), et son contenu est le bon, lu avec
// la bibliothèque que le produit utilise lui-même (exceljs pour un classeur,
// comme les outils xlsx_* de @nodal-agents/tools).

import { existsSync, readdirSync, readFileSync, statSync, unlinkSync, type Dirent } from 'node:fs';
import { extname, join, relative } from 'node:path';
import ExcelJS from 'exceljs';

export interface FoundFile {
  readonly path: string;
  readonly root: string;
  readonly mtimeMs: number;
  /** Écrit pendant l'essai (date de modification postérieure à son début). */
  readonly fresh: boolean;
}

/** Cherche `rel` sous chaque dossier de travail ; le plus récent d'abord. */
export function findInRoots(roots: readonly string[], rel: string, sinceMs: number): FoundFile[] {
  const out: FoundFile[] = [];
  for (const root of roots) {
    const path = join(root, rel);
    if (!existsSync(path)) continue;
    const st = statSync(path);
    if (!st.isFile()) continue;
    out.push({ path, root, mtimeMs: st.mtimeMs, fresh: st.mtimeMs >= sinceMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * Retire, avant un essai, le fichier qu'un essai précédent du banc a laissé au
 * même endroit. Seulement ce chemin exact, relatif à un dossier de travail et
 * sous le dossier du banc : un fichier resté là ferait juger l'essai du jour sur
 * le travail de la veille, ou pousserait l'agent à refuser d'écraser.
 */
export function removeBenchFile(roots: readonly string[], rel: string): string[] {
  if (!rel.startsWith('nodal-bench/')) {
    throw new Error(`workflow_refuses_delete: ${rel} is outside the bench folder nodal-bench/`);
  }
  const removed: string[] = [];
  for (const root of roots) {
    const path = join(root, rel);
    if (existsSync(path) && statSync(path).isFile()) {
      unlinkSync(path);
      removed.push(path);
    }
  }
  return removed;
}

const SKIP_DIRS = new Set(['.obsidian', '.git', '.trash', 'node_modules']);

/**
 * Les fichiers d'extension donnée (toutes quand `exts` est null) modifiés
 * depuis `sinceMs` sous `root`.
 * Parcours borné (`maxEntries`) : un coffre ou un dossier énorme ne doit pas
 * faire durer le jugement ; la borne atteinte est dite, pas tue.
 */
export function freshFilesUnder(
  root: string,
  exts: readonly string[] | null,
  sinceMs: number,
  maxEntries = 200_000,
): { files: Array<{ path: string; rel: string; mtimeMs: number }>; truncated: boolean } {
  const files: Array<{ path: string; rel: string; mtimeMs: number }> = [];
  let seen = 0;
  let truncated = false;
  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > maxEntries) {
        truncated = true;
        return;
      }
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(p);
      } else if (e.isFile() && (exts === null || exts.includes(extname(e.name).toLowerCase()))) {
        const m = statSync(p).mtimeMs;
        if (m >= sinceMs) files.push({ path: p, rel: relative(root, p), mtimeMs: m });
      }
    }
  };
  if (existsSync(root)) walk(root);
  return { files, truncated };
}

/** Le dossier du banc, sous chaque dossier de travail : tout ce qu'un scénario fait écrire y vit. */
export const BENCH_DIR = 'nodal-bench';
const MAX_DELIVERABLES = 50;

/**
 * Ce que l'essai a laissé dans `nodal-bench/` de chaque dossier de travail,
 * écrit depuis `sinceMs` : chemin relatif au dossier de travail (en barres
 * obliques) et taille. `node_modules` et `.git` ne sont pas parcourus. Au-delà
 * de cinquante fichiers, la liste s'arrête et le dernier élément le dit.
 */
export function benchDeliverables(
  roots: readonly string[],
  sinceMs: number,
): Array<{ path: string; bytes: number }> {
  const out: Array<{ path: string; bytes: number }> = [];
  let more = 0;
  for (const root of roots) {
    const dir = join(root, BENCH_DIR);
    for (const f of freshFilesUnder(dir, null, sinceMs, 20_000).files) {
      if (out.length >= MAX_DELIVERABLES) {
        more++;
        continue;
      }
      out.push({
        path: `${BENCH_DIR}/${f.rel.split(/[\\/]/).join('/')}`,
        bytes: statSync(f.path).size,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  if (more > 0) out.push({ path: `… and ${more} more file(s)`, bytes: 0 });
  return out;
}

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

/** Une cellule telle qu'un juge la compare : une valeur, ou une formule et son résultat en cache. */
export type CellValue =
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'formula'; formula: string; result: number | string | null }
  | { kind: 'other'; value: string };

export interface SheetGrid {
  readonly name: string;
  readonly cells: Record<string, CellValue>;
}

/** Lit un classeur avec exceljs, la bibliothèque des outils xlsx_* du produit. */
export async function readXlsxGrid(path: string): Promise<SheetGrid[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const sheets: SheetGrid[] = [];
  wb.eachSheet((ws) => {
    const cells: Record<string, CellValue> = {};
    ws.eachRow({ includeEmpty: false }, (row) => {
      row.eachCell({ includeEmpty: false }, (cell) => {
        // Une formule PARTAGÉE (recopiée vers le bas dans Excel) n'a pas de
        // `formula` dans sa valeur : `cell.formula` la rend traduite à sa cellule.
        cells[cell.address] =
          cell.type === ExcelJS.ValueType.Formula
            ? toCellValue({ formula: cell.formula, result: cell.result } as ExcelJS.CellValue)
            : toCellValue(cell.value);
      });
    });
    sheets.push({ name: ws.name, cells });
  });
  return sheets;
}

function toCellValue(v: ExcelJS.CellValue): CellValue {
  if (typeof v === 'number') return { kind: 'number', value: v };
  if (typeof v === 'string') return { kind: 'text', value: v };
  if (v && typeof v === 'object') {
    if ('formula' in v && typeof v.formula === 'string') {
      const r = (v as { result?: unknown }).result;
      return {
        kind: 'formula',
        formula: v.formula,
        result: typeof r === 'number' || typeof r === 'string' ? r : null,
      };
    }
    if ('richText' in v && Array.isArray(v.richText)) {
      return { kind: 'text', value: v.richText.map((t) => t.text).join('') };
    }
    // Un lien (une adresse e-mail le devient souvent) : son texte affiché.
    if ('hyperlink' in v && 'text' in v && typeof v.text === 'string') {
      return { kind: 'text', value: v.text };
    }
  }
  return { kind: 'other', value: JSON.stringify(v) };
}
