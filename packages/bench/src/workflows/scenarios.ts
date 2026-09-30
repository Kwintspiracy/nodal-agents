// workflows/scenarios.ts — les demandes ordinaires, toujours les mêmes.
//
// « Il nous faut un banc de workflows typiques, toujours les mêmes, lancés
// régulièrement et d'une version à l'autre, pour voir quand ils cassent et
// quand ils ralentissent » (Quentin, 30/09). Chaque scénario est une vraie
// demande au root, par le chemin MCP de l'utilisateur, jugée sur des FAITS :
// lignes de la base, fichiers sur le disque, sorties d'outils. Jamais sur ce
// que le modèle dit avoir fait.
//
// Une demande est écrite comme le propriétaire la taperait, en français. Aucun
// nom d'agent, aucun chemin du propriétaire n'y figure (invariants #1 et #6) :
// « déléguer » se lit comme un job enfant, le coffre Obsidian se trouve parmi
// les dossiers de travail de l'espace, l'imprimante parmi ses connecteurs.
//
// FIGÉS une fois fusionnés. Changer une demande ou un juge = monter `version`.

import { existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { TreeFacts } from './facts';
import {
  callsOf,
  commonReasons,
  delegatedJobs,
  parseJson,
  rootJob,
  textHasNumber,
  urlsIn,
  urlsSeenByTools,
} from './judge-kit';
import {
  findInRoots,
  freshFilesUnder,
  readText,
  readXlsxGrid,
  removeBenchFile,
  type CellValue,
  type SheetGrid,
} from './disk';
import { defineScenario, type AnyScenario } from './types';

const MIN = 60_000;

/**
 * Le nom d'un fichier, quel que soit le séparateur : les chemins jugés viennent
 * de Windows (`C:\…`) et le juge tourne aussi sous Linux (la CI), où
 * `path.basename` ne coupe pas sur l'antislash.
 */
export function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

// ─── question ────────────────────────────────────────────────────────────────

const question = defineScenario<null>({
  id: 'question',
  version: 1,
  title: 'A factual question, answered directly',
  green:
    'The answer names Canberra, the root answered itself (no delegation), and nobody was asked anything.',
  set: 'nightly',
  instruction: "Quelle est la capitale de l'Australie ?",
  timeoutMs: 5 * MIN,
  observe: async () => null,
  judge(facts) {
    const r = commonReasons(facts);
    if (!/canberra/i.test(rootJob(facts)?.result ?? ''))
      r.push('the answer does not name Canberra');
    const d = delegatedJobs(facts);
    if (d.length > 0) {
      r.push(
        `delegated a direct question (${d.map((j) => j.agentSlug ?? j.id.slice(0, 8)).join(', ')})`,
      );
    }
    return r;
  },
});

// ─── research ────────────────────────────────────────────────────────────────

/** Le délégué a lu le web : une sortie d'outil d'un job enfant porte au moins une adresse. */
function delegateReadTheWeb(facts: TreeFacts): boolean {
  const kids = new Set(delegatedJobs(facts).map((j) => j.id));
  return facts.toolCalls.some(
    (c) => c.jobId !== null && kids.has(c.jobId) && urlsIn(c.output).length > 0,
  );
}

const research = defineScenario<null>({
  id: 'research',
  version: 1,
  title: 'A research request, handed to the research specialty',
  green:
    'The root delegated, the delegate read web sources, the report came back with at least one source link that a tool really saw, and nobody was asked anything.',
  set: 'nightly',
  instruction:
    'Fais une recherche sur la découverte du fond diffus cosmologique : qui, quand, comment. Donne tes sources.',
  timeoutMs: 20 * MIN,
  observe: async () => null,
  judge(facts) {
    const r = commonReasons(facts);
    if (delegatedJobs(facts).length === 0) r.push('the research was not delegated');
    else if (!delegateReadTheWeb(facts)) r.push('the delegate read no web source');
    const cited = urlsIn(rootJob(facts)?.result ?? null);
    if (cited.length === 0) r.push('no source link in the report');
    else {
      const seen = urlsSeenByTools(facts);
      if (!cited.some((u) => seen.has(u))) {
        r.push(`none of the ${cited.length} source link(s) in the report was seen by a tool`);
      }
    }
    return r;
  },
});

// ─── deep-research-obsidian ──────────────────────────────────────────────────

interface VaultNote {
  readonly vault: string;
  readonly rel: string;
  readonly chars: number;
  readonly urls: string[];
  readonly marked: boolean;
}
interface VaultObservation {
  readonly vaults: string[];
  readonly notes: VaultNote[];
  readonly truncated: boolean;
}

/** Le dossier et l'étiquette que la demande impose, pour retrouver et nettoyer les notes du banc. */
export const BENCH_NOTE_FOLDER = 'Nodal Bench';
export const BENCH_NOTE_TAG = 'nodal-bench';
const NOTE_MIN_CHARS = 1500;
const NOTE_MIN_SOURCES = 3;

/**
 * Un coffre Obsidian EST un dossier qui porte `.obsidian/` : c'est la marque que
 * l'application y pose. Le banc ne connaît aucun chemin ; il cherche cette
 * marque parmi les dossiers de travail que l'espace déclare.
 */
export function obsidianVaults(roots: readonly string[]): string[] {
  return roots.filter((r) => existsSync(join(r, '.obsidian')));
}

function isMarkedNote(rel: string, text: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.includes(BENCH_NOTE_FOLDER)) return true;
  return new RegExp(`(^|[\\s#\\[,'"-])#?${BENCH_NOTE_TAG}\\b`, 'im').test(text);
}

const deepResearchObsidian = defineScenario<VaultObservation>({
  id: 'deep-research-obsidian',
  version: 1,
  title: 'An in-depth research, written as a note in the Obsidian vault',
  green: `The research was delegated, a note was written in the vault during the run (in the "${BENCH_NOTE_FOLDER}" folder or tagged #${BENCH_NOTE_TAG}), it holds at least ${NOTE_MIN_CHARS} characters and ${NOTE_MIN_SOURCES} source links, and nobody was asked anything.`,
  set: 'nightly',
  instruction:
    'Fais une recherche approfondie sur le déchiffrement des hiéroglyphes égyptiens par Champollion ' +
    '(les étapes, les sources utilisées, les rivalités). Écris le rapport complet comme une note dans ' +
    `mon coffre Obsidian, dans le dossier « ${BENCH_NOTE_FOLDER} », avec le tag #${BENCH_NOTE_TAG}, ` +
    'et cite au moins trois sources avec leurs liens.',
  timeoutMs: 30 * MIN,
  async observe(_facts, env) {
    const vaults = obsidianVaults(env.workspaceRoots);
    const notes: VaultNote[] = [];
    let truncated = false;
    for (const vault of vaults) {
      const found = freshFilesUnder(vault, ['.md'], env.startedMs);
      truncated ||= found.truncated;
      for (const f of found.files) {
        const text = readText(f.path);
        notes.push({
          vault,
          rel: f.rel,
          chars: text.length,
          urls: urlsIn(text),
          marked: isMarkedNote(f.rel, text),
        });
      }
    }
    return { vaults, notes, truncated };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (delegatedJobs(facts).length === 0) r.push('the research was not delegated');
    if (o.vaults.length === 0) {
      r.push(
        'no Obsidian vault is configured: no workspace folder of this workspace holds a .obsidian folder',
      );
      return r;
    }
    if (o.notes.length === 0) {
      r.push(
        `no note was written or updated in the vault during the run${o.truncated ? ' (vault scan truncated)' : ''}`,
      );
      return r;
    }
    // La meilleure note : celle qui porte le plus de sources, puis la plus longue.
    const best = [...o.notes].sort(
      (a, b) => b.urls.length - a.urls.length || b.chars - a.chars,
    )[0]!;
    if (!best.marked)
      r.push(
        `the note ${best.rel} is neither in "${BENCH_NOTE_FOLDER}" nor tagged #${BENCH_NOTE_TAG}`,
      );
    if (best.chars < NOTE_MIN_CHARS)
      r.push(`the note holds ${best.chars} characters, fewer than ${NOTE_MIN_CHARS}`);
    if (best.urls.length < NOTE_MIN_SOURCES) {
      r.push(`the note cites ${best.urls.length} source link(s), fewer than ${NOTE_MIN_SOURCES}`);
    } else {
      const seen = urlsSeenByTools(facts);
      const grounded = best.urls.filter((u) => seen.has(u)).length;
      if (grounded === 0)
        r.push(`none of the ${best.urls.length} source links of the note was seen by a tool`);
    }
    return r;
  },
});

// ─── file ────────────────────────────────────────────────────────────────────

export const FILE_REL = 'nodal-bench/ventes-bench.xlsx';
const FILE_SHEET = 'Ventes';
const FILE_EXPECTED: ReadonlyArray<[string, string | number]> = [
  ['A1', 'Mois'],
  ['B1', 'Unités'],
  ['A2', 'Janvier'],
  ['B2', 12],
  ['A3', 'Février'],
  ['B3', 30],
  ['A4', 'Mars'],
  ['B4', 58],
];
const FILE_TOTAL = 100;

interface FileObservation {
  readonly found: { path: string; fresh: boolean } | null;
  readonly sheets: SheetGrid[] | null;
  readonly readError: string | null;
}

function cellMatches(cell: CellValue | undefined, want: string | number): boolean {
  if (!cell) return false;
  if (typeof want === 'number') return cell.kind === 'number' && cell.value === want;
  return cell.kind === 'text' && cell.value.trim().toLowerCase() === want.toLowerCase();
}

function showCell(cell: CellValue | undefined): string {
  if (!cell) return 'empty';
  if (cell.kind === 'formula') return `=${cell.formula}`;
  return cell.kind === 'text' ? JSON.stringify(cell.value) : String(cell.value);
}

/** Le total en B5 : le nombre 100, ou une somme de B2:B4 (les valeurs lues, pas le cache). */
export function totalIsRight(cells: Record<string, CellValue>): boolean {
  const b5 = cells['B5'];
  if (!b5) return false;
  if (b5.kind === 'number') return b5.value === FILE_TOTAL;
  if (b5.kind !== 'formula') return false;
  if (typeof b5.result === 'number') return b5.result === FILE_TOTAL;
  const f = b5.formula.replace(/\s+/g, '').replace(/^=/, '').toUpperCase();
  const refs =
    f === 'SUM(B2:B4)' ? ['B2', 'B3', 'B4'] : f === 'B2+B3+B4' ? ['B2', 'B3', 'B4'] : null;
  if (!refs) return false;
  const sum = refs.reduce((s, a) => {
    const c = cells[a];
    return s + (c?.kind === 'number' ? c.value : Number.NaN);
  }, 0);
  return sum === FILE_TOTAL;
}

const file = defineScenario<FileObservation>({
  id: 'file',
  version: 1,
  title: 'An Excel file written in the workspace',
  green: `The file ${FILE_REL} was written during the run, and its sheet "${FILE_SHEET}" holds exactly the requested cells (numbers as numbers) with the total 100 in B5, read back with exceljs like the product does.`,
  set: 'nightly',
  instruction:
    `Crée un fichier Excel ${FILE_REL} dans ton espace de travail : une feuille « ${FILE_SHEET} », ` +
    'avec « Mois » en A1 et « Unités » en B1, puis Janvier 12, Février 30 et Mars 58 sur les lignes 2 à 4, ' +
    'et le total des unités en B5.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, FILE_REL);
  },
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, FILE_REL, env.startedMs);
    if (!hit) return { found: null, sheets: null, readError: null };
    try {
      return {
        found: { path: hit.path, fresh: hit.fresh },
        sheets: await readXlsxGrid(hit.path),
        readError: null,
      };
    } catch (e) {
      return { found: { path: hit.path, fresh: hit.fresh }, sheets: null, readError: String(e) };
    }
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.found) {
      r.push(`no file ${FILE_REL} in any workspace folder`);
      return r;
    }
    if (!o.found.fresh) r.push(`${FILE_REL} exists but was not written during the run`);
    if (o.readError || !o.sheets) {
      r.push(`the file cannot be read as a workbook: ${o.readError ?? 'unknown'}`);
      return r;
    }
    const sheet = o.sheets.find((s) => s.name.trim().toLowerCase() === FILE_SHEET.toLowerCase());
    if (!sheet) {
      r.push(`no sheet "${FILE_SHEET}" (sheets: ${o.sheets.map((s) => s.name).join(', ')})`);
      return r;
    }
    const wrong = FILE_EXPECTED.filter(([a, v]) => !cellMatches(sheet.cells[a], v)).map(
      ([a, v]) => `${a} is ${showCell(sheet.cells[a])}, expected ${JSON.stringify(v)}`,
    );
    r.push(...wrong);
    if (!totalIsRight(sheet.cells))
      r.push(`B5 is ${showCell(sheet.cells['B5'])}, expected a total of ${FILE_TOTAL}`);
    return r;
  },
});

// ─── code ────────────────────────────────────────────────────────────────────

/** Un fichier public figé par son commit : son contenu ne peut plus changer. */
export const CODE_URL =
  'https://raw.githubusercontent.com/mwaskom/seaborn-data/8504c04d4b02ac56527949baafb416e5864698b6/iris.csv';
export const CODE_REL = 'nodal-bench/iris.csv';
/** Somme de petal_length pour virginica dans ce fichier (50 lignes). */
export const CODE_VALUE = 277.6;
const CODE_ROWS = 150;

interface CodeObservation {
  readonly found: { path: string; fresh: boolean } | null;
  /** Lignes de données lues dans le fichier téléchargé (en-tête exclu). */
  readonly dataRows: number | null;
  /** La somme recalculée par le banc sur le fichier téléchargé. */
  readonly recomputed: number | null;
}

/** Recalcule la valeur attendue sur le CSV réellement téléchargé. */
export function virginicaPetalSum(csv: string): { rows: number; sum: number } {
  const lines = csv.replace(/\r\n/g, '\n').trim().split('\n');
  const header = (lines[0] ?? '').split(',').map((h) => h.trim());
  const len = header.indexOf('petal_length');
  const sp = header.indexOf('species');
  let sum = 0;
  for (const l of lines.slice(1)) {
    const f = l.split(',');
    if ((f[sp] ?? '').trim() === 'virginica') sum += Number(f[len]);
  }
  return { rows: lines.length - 1, sum: Math.round(sum * 10) / 10 };
}

/** Un outil qui exécute une commande, quel que soit le runtime (produit, CLI). */
const COMMAND_TOOL = /(^|__)(run_command|run_skill_script|bash|shell|execute_command)$/i;
const SCRIPT_RUNNER = /\b(python3?|py|node|deno|bun)\b/i;

const code = defineScenario<CodeObservation>({
  id: 'code',
  version: 1,
  title: 'Download a public file and run a script on it',
  green: `The CSV was downloaded into ${CODE_REL} during the run, a Python or Node script ran on it and printed ${CODE_VALUE}, the answer gives ${CODE_VALUE}, and zero approval was asked.`,
  set: 'nightly',
  instruction:
    `Télécharge ${CODE_URL} dans ton espace de travail, sous ${CODE_REL}. Puis écris et exécute un script ` +
    'Python (ou Node) qui calcule la somme de la colonne petal_length pour l’espèce virginica, et donne-moi le résultat.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, CODE_REL);
  },
  async observe(_facts, env) {
    const [hit] = findInRoots(env.workspaceRoots, CODE_REL, env.startedMs);
    if (!hit) return { found: null, dataRows: null, recomputed: null };
    const { rows, sum } = virginicaPetalSum(readText(hit.path));
    return { found: { path: hit.path, fresh: hit.fresh }, dataRows: rows, recomputed: sum };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!o.found) r.push(`the CSV was not downloaded into ${CODE_REL}`);
    else {
      if (!o.found.fresh) r.push(`${CODE_REL} exists but was not written during the run`);
      if (o.dataRows !== CODE_ROWS || o.recomputed !== CODE_VALUE) {
        r.push(
          `the downloaded file is not the expected one (${o.dataRows} rows, sum ${o.recomputed})`,
        );
      }
    }
    const ran = facts.toolCalls.filter(
      (c) =>
        COMMAND_TOOL.test(c.toolName) &&
        SCRIPT_RUNNER.test(c.input ?? '') &&
        textHasNumber(c.output, CODE_VALUE, 1),
    );
    if (ran.length === 0) r.push(`no Python or Node run printed ${CODE_VALUE}`);
    if (!textHasNumber(rootJob(facts)?.result ?? null, CODE_VALUE, 1))
      r.push(`the answer does not give ${CODE_VALUE}`);
    return r;
  },
});

// ─── print & recipe (connecteur d'imprimante) ────────────────────────────────

/**
 * Ce que le connecteur HP rend à `request_print` (structuredContent, sans le
 * jeton de confirmation) : un id, un statut, un aperçu.
 */
interface PrintRequestView {
  readonly id: string;
  readonly status: string;
  readonly pages: number | null;
  /** Les images que le connecteur a intégrées ; null quand il n'en dit rien (un fichier imprimé tel quel). */
  readonly images: Array<{ origin: string }> | null;
}

function printRequests(facts: TreeFacts): Array<{ input: string; view: PrintRequestView }> {
  return callsOf(facts, 'request_print')
    .map((c) => {
      const o = parseJson(c.output) as Record<string, unknown> | null;
      if (!o || typeof o['id'] !== 'string' || typeof o['status'] !== 'string') return null;
      const preview = (o['preview'] ?? {}) as Record<string, unknown>;
      const embedded = (o['images'] as Record<string, unknown> | undefined)?.['embedded'];
      const images = Array.isArray(embedded) ? (embedded as Array<{ origin?: unknown }>) : null;
      return {
        input: c.input ?? '',
        view: {
          id: o['id'],
          status: o['status'],
          pages: typeof preview['pages'] === 'number' ? preview['pages'] : null,
          images: images === null ? null : images.map((i) => ({ origin: String(i.origin ?? '') })),
        },
      };
    })
    .filter((x): x is { input: string; view: PrintRequestView } => x !== null);
}

/** Statuts où du papier est sorti, ou part. Le banc ne doit jamais en voir. */
const PRINTED = new Set(['submitted', 'completed', 'printing', 'stuck']);

function neverPrinted(facts: TreeFacts): string[] {
  const r: string[] = [];
  if (callsOf(facts, 'confirm_print').length > 0) r.push('the agent called confirm_print');
  const printed = [...callsOf(facts, 'request_print'), ...callsOf(facts, 'get_print_request')]
    .map((c) => parseJson(c.output) as Record<string, unknown> | null)
    .filter((o) => o && typeof o['status'] === 'string' && PRINTED.has(o['status'] as string));
  if (printed.length > 0) r.push('a print request went to the printer without the owner');
  return r;
}

function needsPrinter(env: { connectorTools: readonly string[] }): string[] {
  return env.connectorTools.includes('request_print')
    ? []
    : [
        'no active connector of this workspace offers request_print (no printer connector configured)',
      ];
}

export const PRINT_MARKER = 'Nodal bench';

const print = defineScenario<null>({
  id: 'print',
  version: 1,
  title: 'Print a short note (the request waits for the owner)',
  green:
    'A print request holding the note was created and is pending: through Nodal the printer connector never prints without a human click, and nothing reached the printer. One page, nobody asked anything.',
  set: 'nightly',
  instruction: `Imprime ce court texte sur une seule page : « ${PRINT_MARKER} — test d'impression. » puis, à la ligne, « 2 + 2 = 4 ».`,
  timeoutMs: 10 * MIN,
  requires: needsPrinter,
  observe: async () => null,
  judge(facts) {
    const r = commonReasons(facts);
    const reqs = printRequests(facts);
    const mine = reqs.filter((q) => q.input.toLowerCase().includes(PRINT_MARKER.toLowerCase()));
    if (reqs.length === 0) r.push('no print request was created');
    else if (mine.length === 0) r.push(`no print request holds the text "${PRINT_MARKER}"`);
    else {
      const last = mine[mine.length - 1]!.view;
      if (last.status !== 'pending') r.push(`the print request is ${last.status}, not pending`);
      if (last.pages !== null && last.pages !== 1) r.push(`${last.pages} pages, not one`);
    }
    r.push(...neverPrinted(facts));
    return r;
  },
});

const PAGE_READERS = /read_web_page|get_page_images|fetch|scrape|extract/i;

interface RecipeObservation {
  /** Les fichiers que les demandes d'impression imprimaient tels quels, et s'ils existaient avant l'essai. */
  readonly printedFiles: Array<{ path: string; existedBefore: boolean | null }>;
}

const recipe = defineScenario<RecipeObservation>({
  id: 'recipe',
  version: 1,
  title: 'Print a recipe with its own photo (the request waits for the owner)',
  green:
    'A pending print request of one page was created, with a photo that comes from the recipe site the agent read; nothing reached the printer and nobody was asked anything.',
  set: 'nightly',
  instruction:
    "Imprime une recette de caviar d'aubergines, sur une seule page, style magazine, avec la photo de la recette elle-même.",
  timeoutMs: 20 * MIN,
  requires: needsPrinter,
  async observe(facts, env) {
    const printedFiles = callsOf(facts, 'request_print')
      .map((c) => (parseJson(c.input) as { filePath?: unknown } | null)?.filePath)
      .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
      .map((path) => ({
        path,
        existedBefore: existsSync(path) ? statSync(path).birthtimeMs < env.startedMs : null,
      }));
    return { printedFiles };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    const reqs = printRequests(facts);
    if (reqs.length === 0) {
      r.push('no print request was created');
      return [...r, ...neverPrinted(facts)];
    }
    const lastReq = reqs[reqs.length - 1]!;
    const last = lastReq.view;
    if (last.status !== 'pending') r.push(`the print request is ${last.status}, not pending`);
    if (last.pages !== null && last.pages !== 1) r.push(`${last.pages} pages, not one`);
    if (last.images === null) {
      // Un fichier imprimé tel quel : le connecteur ne dit pas ce qu'il contient.
      // Le juge ne peut pas voir la photo, et le dit, plutôt qu'affirmer qu'elle manque.
      // Le fichier est celui de LA demande retenue, pas d'un appel refusé à côté.
      const path = (parseJson(lastReq.input) as { filePath?: unknown } | null)?.filePath;
      const f = o.printedFiles.find((x) => x.path === path);
      r.push(
        f
          ? `the request prints an existing file (${fileName(f.path)}${f.existedBefore ? ', made before this run' : ''}), whose pictures the connector does not report: the photo cannot be checked`
          : 'the connector reports no pictures for this request: the photo cannot be checked',
      );
    } else if (last.images.length === 0) r.push('no photo in the printed page');
    else {
      const hosts = facts.toolCalls
        .filter((c) => PAGE_READERS.test(c.toolName))
        .map((c) => (parseJson(c.input) as { url?: unknown } | null)?.url)
        .filter((u): u is string => typeof u === 'string')
        .map((u) => {
          try {
            return new URL(u).hostname.replace(/^www\./, '');
          } catch {
            return null;
          }
        })
        .filter((h): h is string => h !== null);
      const site = (h: string): string => h.split('.').slice(-2).join('.');
      const fromSource = last.images.some((i) => {
        const o = i.origin.replace(/^www\./, '');
        return hosts.some((h) => site(h) === site(o));
      });
      if (!fromSource) {
        r.push(
          `the photo does not come from the recipe site (${last.images.map((i) => i.origin).join(', ')} vs ${[...new Set(hosts)].join(', ') || 'no page read'})`,
        );
      }
    }
    r.push(...neverPrinted(facts));
    return r;
  },
});

// ─── comfyui-telegram ────────────────────────────────────────────────────────

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ABS_IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\/)(?:[^"'\n\r<>|*?]+?)\.(?:png|jpe?g|webp)\b/gi;

interface ImageObservation {
  /** Images citées par les outils de l'arbre, avec ce que le disque en dit. */
  readonly images: Array<{ path: string; exists: boolean; fresh: boolean }>;
}

function imagePathsIn(text: string | null): string[] {
  if (!text) return [];
  const plain = text.replace(/\\\\/g, '\\').replace(/\\\//g, '/');
  return [...new Set([...plain.matchAll(ABS_IMAGE_PATH)].map((m) => m[0]))];
}

const comfyTelegram = defineScenario<ImageObservation>({
  id: 'comfyui-telegram',
  version: 1,
  title: 'Generate an image with ComfyUI and send it on Telegram',
  green:
    'An image file was written during the run, a send of THAT image returned ok (the delivery fact from the tool, not the model), and nobody was asked anything.',
  set: 'on-demand',
  instruction:
    "Génère avec ComfyUI une image d'un phare sur une falaise au coucher du soleil, style aquarelle, puis envoie-la-moi sur Telegram.",
  timeoutMs: 40 * MIN,
  async observe(facts, env) {
    const paths = new Set<string>();
    for (const c of facts.toolCalls)
      for (const p of [...imagePathsIn(c.input), ...imagePathsIn(c.output)]) paths.add(p);
    const images = [...paths]
      .filter((p) => IMAGE_EXT.has(extname(p).toLowerCase()))
      .map((p) => {
        const exists = existsSync(p);
        return { path: p, exists, fresh: exists && statSync(p).mtimeMs >= env.startedMs };
      });
    return { images };
  },
  judge(facts, o) {
    const r = commonReasons(facts);
    const fresh = o.images.filter((i) => i.exists && i.fresh);
    if (fresh.length === 0) r.push('no image file was written during the run');
    const sends = [...callsOf(facts, 'send_image'), ...callsOf(facts, 'send_file')];
    const ok = sends.filter((c) => (parseJson(c.output) as { ok?: unknown } | null)?.ok === true);
    if (ok.length === 0) {
      r.push(
        sends.length === 0
          ? 'nothing was sent on Telegram'
          : 'no send was confirmed (the tool never returned ok)',
      );
    } else if (fresh.length > 0) {
      const names = new Set(fresh.map((i) => fileName(i.path).toLowerCase()));
      const sentFresh = ok.some((c) => {
        const src = String((parseJson(c.input) as { source?: unknown } | null)?.source ?? '');
        const name = fileName(src.split('?filename=').pop()?.split('&')[0] ?? src).toLowerCase();
        return names.has(name);
      });
      if (!sentFresh) r.push('the image sent is not one written during the run');
    }
    return r;
  },
});

/** Le jeu figé. L'ordre est celui des lignes du portail. */
export const SCENARIOS: readonly AnyScenario[] = [
  question,
  research,
  deepResearchObsidian,
  file,
  code,
  print,
  recipe,
  comfyTelegram,
];

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
