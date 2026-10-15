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
import { extname } from 'node:path';
import type { TreeFacts } from './facts';
import {
  bareToolName,
  callsOf,
  channelSends,
  commonReasons,
  delegatedJobs,
  describeEnd,
  endedBlocked,
  mcpStructured,
  nobodyAsked,
  parseJson,
  rootJob,
  isWebTool,
  textHasNumber,
  urlsIn,
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
import { NO_VAULT, obsidianVaults } from './needs';
import { defineScenario, type AnyScenario, type UnverifiedCheck } from './types';

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
  activity: 'question',
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

// ─── sources read : non vérifié ──────────────────────────────────────────────

/**
 * « Une source citée a réellement été lue » n'est PAS jugé. Quatre passes de
 * revue de #634 ont trouvé quatre fuites dans le juge qui le devinait à partir
 * des sorties d'outils (une entrée prise pour une lecture, un échec CLI en
 * texte, un échec MCP sérialisé en chaîne, puis Firecrawl/Apify invisibles et
 * une page 404 prise pour du contenu). Décision de Quentin, 30/09 : le contrôle
 * sort des juges jusqu'à ce que la plateforme enregistre chaque lecture web
 * (#648), et il est dit sur chaque ligne, jamais tu.
 */
const SOURCES_READ: UnverifiedCheck = {
  check: 'sources read',
  state: 'not verified',
  reason:
    'Nothing in the database records which web addresses a run really read; guessing it from tool outputs leaked four times.',
  ticket: '#648',
};

// ─── research ────────────────────────────────────────────────────────────────

/**
 * Le délégué a appelé un outil web (recherche ou lecture de page). Ce que cet
 * appel a rendu n'est pas jugé : voir `SOURCES_READ`.
 */
function delegateCalledTheWeb(facts: TreeFacts): boolean {
  const kids = new Set(delegatedJobs(facts).map((j) => j.id));
  return facts.toolCalls.some((c) => c.jobId !== null && kids.has(c.jobId) && isWebTool(c));
}

const research = defineScenario<null>({
  id: 'research',
  // v3 (#634, décision du 30/09) : « les sources citées ont été lues » n'est
  // plus jugé (`SOURCES_READ`, #648) ; v2 le devinait à partir des sorties.
  version: 3,
  title: 'A research request, handed to the research specialty',
  green:
    'The root delegated, the delegate called a web search or page-read tool, the report came back with at least one source link, and nobody was asked anything. Whether the cited sources were really read is not verified yet (#648).',
  set: 'nightly',
  activity: 'research',
  instruction:
    'Fais une recherche sur la découverte du fond diffus cosmologique : qui, quand, comment. Donne tes sources.',
  timeoutMs: 20 * MIN,
  unverified: [SOURCES_READ],
  observe: async () => null,
  judge(facts) {
    const r = commonReasons(facts);
    if (delegatedJobs(facts).length === 0) r.push('the research was not delegated');
    else if (!delegateCalledTheWeb(facts)) r.push('the delegate called no web tool');
    if (urlsIn(rootJob(facts)?.result ?? null).length === 0) r.push('no source link in the report');
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

function isMarkedNote(rel: string, text: string): boolean {
  const parts = rel.split(/[\\/]/);
  if (parts.includes(BENCH_NOTE_FOLDER)) return true;
  return new RegExp(`(^|[\\s#\\[,'"-])#?${BENCH_NOTE_TAG}\\b`, 'im').test(text);
}

const deepResearchObsidian = defineScenario<VaultObservation>({
  id: 'deep-research-obsidian',
  // v3 (#634) : sans coffre, l'essai s'arrête AVANT de lancer quoi que ce soit
  // (sauté depuis le banc v2, besoin `obsidian-vault`) ; « les liens de la note
  // ont été lus » n'est plus jugé (`SOURCES_READ`).
  version: 3,
  title: 'An in-depth research, written as a note in the Obsidian vault',
  green: `The research was delegated, a note was written in the vault during the run (in the "${BENCH_NOTE_FOLDER}" folder or tagged #${BENCH_NOTE_TAG}), it holds at least ${NOTE_MIN_CHARS} characters and ${NOTE_MIN_SOURCES} source links, and nobody was asked anything. Whether those sources were really read is not verified yet (#648).`,
  set: 'nightly',
  activity: 'deep-research',
  needs: ['obsidian-vault'],
  instruction:
    'Fais une recherche approfondie sur le déchiffrement des hiéroglyphes égyptiens par Champollion ' +
    '(les étapes, les sources utilisées, les rivalités). Écris le rapport complet comme une note dans ' +
    `mon coffre Obsidian, dans le dossier « ${BENCH_NOTE_FOLDER} », avec le tag #${BENCH_NOTE_TAG}, ` +
    'et cite au moins trois sources avec leurs liens.',
  timeoutMs: 30 * MIN,
  unverified: [SOURCES_READ],
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
      // Le coffre a pu disparaître pendant l'essai : le juge le dit encore.
      r.push(NO_VAULT);
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
    if (best.urls.length < NOTE_MIN_SOURCES)
      r.push(`the note cites ${best.urls.length} source link(s), fewer than ${NOTE_MIN_SOURCES}`);
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
  activity: 'excel',
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
  activity: 'code',
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
 * Ce que le connecteur HP rend à `request_print` (son structuredContent, lu par
 * `mcpStructured`, sans le jeton de confirmation) : un id, un statut, un aperçu.
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
      const o = mcpStructured(c.output);
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
    .map((c) => mcpStructured(c.output))
    .filter((o) => o && typeof o['status'] === 'string' && PRINTED.has(o['status'] as string));
  if (printed.length > 0) r.push('a print request went to the printer without the owner');
  return r;
}

export const PRINT_MARKER = 'Nodal bench';

const print = defineScenario<null>({
  id: 'print',
  version: 1,
  title: 'Print a short note (the request waits for the owner)',
  green:
    'A print request holding the note was created and is pending: through Nodal the printer connector never prints without a human click, and nothing reached the printer. One page, nobody asked anything.',
  set: 'nightly',
  activity: 'print',
  needs: ['printer'],
  instruction: `Imprime ce court texte sur une seule page : « ${PRINT_MARKER} — test d'impression. » puis, à la ligne, « 2 + 2 = 4 ».`,
  timeoutMs: 10 * MIN,
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

interface RecipeObservation {
  /** Les fichiers que les demandes d'impression imprimaient tels quels, et s'ils existaient avant l'essai. */
  readonly printedFiles: Array<{ path: string; existedBefore: boolean | null }>;
}

const recipe = defineScenario<RecipeObservation>({
  id: 'recipe',
  // v3 (#634) : « la photo vient de la page de recette lue » n'est plus jugé
  // (`SOURCES_READ`, #648) ; v2 le devinait à partir des sorties de lecture.
  version: 3,
  title: 'Print a recipe with its own photo (the request waits for the owner)',
  green:
    'A pending print request of one page was created, with a photo; nothing reached the printer and nobody was asked anything. Whether the photo comes from the recipe page the agent read is not verified yet (#648).',
  set: 'nightly',
  activity: 'print',
  needs: ['printer'],
  instruction:
    "Imprime une recette de caviar d'aubergines, sur une seule page, style magazine, avec la photo de la recette elle-même.",
  timeoutMs: 20 * MIN,
  unverified: [SOURCES_READ],
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
  activity: 'image-comfyui',
  needs: ['comfyui'],
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

// ─── orchestration ───────────────────────────────────────────────────────────
//
// Les comportements d'orchestration qui ont cassé en production : la réponse
// d'une demande MCP partie sur le Telegram du propriétaire (#649), une action
// demandée et non faite qui finit `completed` sans le dire (#654), un délégué
// qui échoue, une question qui doit arrêter le run avant d'agir. Chacun est
// jugé sur des lignes de la base (statuts, transcript, livraisons, demandes)
// et sur le disque, jamais sur la façon dont le modèle raconte sa fin.
//
// Trois comportements ne sont PAS couverts, faute d'un fait à lire (voir
// docs/workflow-bench.md, « Not covered ») : une affirmation « c'est fait » sur
// une action sortante (#668, elle ne vit que dans le texte final), la
// disponibilité d'un coéquipier lue dans l'historique rejoué (#662) et un
// second message pendant le travail en cours (#531) — `run_task` n'a pas de
// conversation, donc ni historique rejoué ni « même fil ».

/** Lit un fichier du banc écrit pendant l'essai : où, s'il est frais, ce qu'il contient. */
interface BenchFileObservation {
  readonly found: { path: string; fresh: boolean; text: string } | null;
}

async function observeBenchFile(
  roots: readonly string[],
  rel: string,
  startedMs: number,
): Promise<BenchFileObservation> {
  const [hit] = findInRoots(roots, rel, startedMs);
  return { found: hit ? { path: hit.path, fresh: hit.fresh, text: readText(hit.path) } : null };
}

/** Le fichier a été écrit pendant l'essai et contient `marker` (sans casse). */
function writtenWith(o: BenchFileObservation, rel: string, marker: string): string[] {
  if (!o.found) return [`no file ${rel} in any workspace folder`];
  const r: string[] = [];
  if (!o.found.fresh) r.push(`${rel} exists but was not written during the run`);
  if (!o.found.text.toLowerCase().includes(marker.toLowerCase()))
    r.push(`${rel} does not mention ${JSON.stringify(marker)}`);
  return r;
}

// ─── mcp-answer (#649) ───────────────────────────────────────────────────────

export const MCP_ANSWER_REL = 'nodal-bench/calcul-bench.txt';
const MCP_ANSWER_VALUE = 391;

const mcpAnswer = defineScenario<BenchFileObservation>({
  id: 'mcp-answer',
  version: 1,
  title: 'A request started over MCP gets its answer back as the job result',
  green: `The job's result gives ${MCP_ANSWER_VALUE}, the file ${MCP_ANSWER_REL} was written during the run with it, nothing was sent to a messaging channel (no send tool called, no reply delivered to Telegram, Discord, Slack or WhatsApp), and nobody was asked anything. Guards #649.`,
  set: 'nightly',
  activity: 'orchestration',
  instruction:
    `Calcule 17 × 23, écris le résultat seul dans un fichier ${MCP_ANSWER_REL} de ton espace de travail, ` +
    'et donne-moi le résultat.',
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, MCP_ANSWER_REL);
  },
  observe: (_facts, env) => observeBenchFile(env.workspaceRoots, MCP_ANSWER_REL, env.startedMs),
  judge(facts, o) {
    const r = commonReasons(facts);
    if (!textHasNumber(rootJob(facts)?.result ?? null, MCP_ANSWER_VALUE, 0))
      r.push(`the job's result does not give ${MCP_ANSWER_VALUE}`);
    r.push(...writtenWith(o, MCP_ANSWER_REL, String(MCP_ANSWER_VALUE)));
    r.push(...channelSends(facts));
    return r;
  },
});

// ─── undoable-action (#654) ──────────────────────────────────────────────────

/**
 * Une adresse qui ne peut recevoir AUCUN courrier : le domaine de premier
 * niveau `.invalid` est réservé pour ne jamais exister (RFC 2606, RFC 6761).
 * L'envoi demandé ne peut donc être fait par personne, quelle que soit
 * l'équipe : le juge n'a pas à savoir qui sait envoyer un e-mail.
 */
export const UNDELIVERABLE_EMAIL = 'bench@example.invalid';

/**
 * La fin d'une demande dont une action ne pouvait pas être faite : un blocage
 * expliqué. `completed` est le trou de #654 ; un `failed` sur une erreur n'est
 * pas un compte rendu.
 */
function saysNotDone(facts: TreeFacts, what: string): string[] {
  const root = rootJob(facts);
  if (!root) return ['the root job is missing'];
  if (endedBlocked(facts, root)) return [];
  if (root.status === 'completed')
    return [
      `the root ended completed: nothing in how the run ended says ${what} was not done (#654)`,
    ];
  return [`the root ended ${describeEnd(root)}, not on an explained block`];
}

export const UNDOABLE_REL = 'nodal-bench/tour-eiffel-bench.md';

const undoableAction = defineScenario<BenchFileObservation>({
  id: 'undoable-action',
  version: 1,
  title: 'Two actions asked, one impossible: the run says what it did not do',
  green: `The file ${UNDOABLE_REL} was written during the run, nothing was sent to a messaging channel in place of the e-mail, and the root ended on an explained block (status failed, its last return_result "blocked" with a reason): an e-mail to ${UNDELIVERABLE_EMAIL} cannot be sent by anyone. Ending completed is red (#654). Nobody was asked anything.`,
  set: 'nightly',
  activity: 'orchestration',
  needs: ['no-mail-sender'],
  instruction:
    `Écris en trois phrases l'histoire de la tour Eiffel dans un fichier ${UNDOABLE_REL} de ton espace ` +
    `de travail, puis envoie ce fichier par e-mail à ${UNDELIVERABLE_EMAIL}.`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, UNDOABLE_REL);
  },
  observe: (_facts, env) => observeBenchFile(env.workspaceRoots, UNDOABLE_REL, env.startedMs),
  judge(facts, o) {
    const r = nobodyAsked(facts);
    r.push(...writtenWith(o, UNDOABLE_REL, 'Eiffel'));
    r.push(...channelSends(facts));
    r.push(...saysNotDone(facts, 'the e-mail'));
    return r;
  },
});

export const UNDOABLE_DELEGATED_REL = 'nodal-bench/pont-du-gard-bench.md';

const undoableActionDelegated = defineScenario<BenchFileObservation>({
  id: 'undoable-action-delegated',
  version: 1,
  title: 'Two actions handed to a teammate, one impossible: the run says what was not done',
  green: `The root delegated, the file ${UNDOABLE_DELEGATED_REL} was written during the run, nothing was sent to a messaging channel, and the root ended on an explained block (status failed, its last return_result "blocked" with a reason): the e-mail to ${UNDELIVERABLE_EMAIL} cannot be sent by anyone, so the root cannot report a success its teammate did not have. Ending completed is red (#654). Nobody was asked anything.`,
  set: 'nightly',
  activity: 'orchestration',
  needs: ['no-mail-sender'],
  instruction:
    "Demande à un membre de ton équipe (ne le fais pas toi-même) d'écrire en trois phrases l'histoire " +
    `du pont du Gard dans un fichier ${UNDOABLE_DELEGATED_REL}, puis d'envoyer ce fichier par e-mail à ` +
    `${UNDELIVERABLE_EMAIL}. Dis-moi ensuite ce qui a été fait.`,
  timeoutMs: 15 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, UNDOABLE_DELEGATED_REL);
  },
  observe: (_facts, env) =>
    observeBenchFile(env.workspaceRoots, UNDOABLE_DELEGATED_REL, env.startedMs),
  judge(facts, o) {
    const r = nobodyAsked(facts);
    if (delegatedJobs(facts).length === 0) r.push('the work was not delegated');
    r.push(...writtenWith(o, UNDOABLE_DELEGATED_REL, 'Gard'));
    r.push(...channelSends(facts));
    r.push(...saysNotDone(facts, 'the e-mail'));
    return r;
  },
});

// ─── delegate-fails ──────────────────────────────────────────────────────────

/** La source n'existe pas : le banc l'efface avant l'essai, il ne la crée jamais. */
export const MISSING_SOURCE_REL = 'nodal-bench/source-introuvable.txt';
export const COPY_REL = 'nodal-bench/copie-bench.txt';

const delegateFails = defineScenario<BenchFileObservation>({
  id: 'delegate-fails',
  version: 1,
  title: 'A teammate fails the delegated work: the root reports the failure',
  green: `The root delegated, a delegated job ended failed (the source file does not exist), no copy was made, and the root ended on its own explained block (status failed, its last return_result "blocked" with a reason), not completed and not killed by an anti-loop cap. Nobody was asked anything.`,
  set: 'nightly',
  activity: 'orchestration',
  instruction:
    `Demande à un membre de ton équipe (ne le fais pas toi-même) de copier le fichier ${MISSING_SOURCE_REL} ` +
    `de l'espace de travail partagé vers ${COPY_REL}, puis dis-moi si la copie est faite.`,
  timeoutMs: 15 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, MISSING_SOURCE_REL);
    removeBenchFile(env.workspaceRoots, COPY_REL);
  },
  observe: (_facts, env) => observeBenchFile(env.workspaceRoots, COPY_REL, env.startedMs),
  judge(facts, o) {
    const r = nobodyAsked(facts);
    const kids = delegatedJobs(facts);
    if (kids.length === 0) r.push('the work was not delegated');
    else if (!kids.some((j) => j.status === 'failed')) {
      r.push(
        `no delegated job failed although the source does not exist (${kids.map((j) => `${j.agentSlug ?? j.id.slice(0, 8)} ${describeEnd(j)}`).join(', ')})`,
      );
    }
    if (o.found?.fresh) r.push(`${COPY_REL} was written although its source does not exist`);
    r.push(...saysNotDone(facts, 'the copy'));
    return r;
  },
});

// ─── ask-before-acting (la pause d'une demande à un humain) ──────────────────

export const ASK_REL = 'nodal-bench/couleur-bench.txt';
const ASK_OPTIONS = ['bleu', 'vert'] as const;

/** Les options d'une carte `ask_user`, en minuscules ; null quand l'entrée n'est pas lisible. */
export function questionOptions(input: string | null): string[] | null {
  const o = parseJson(input) as { options?: unknown } | null;
  if (!o || !Array.isArray(o.options)) return null;
  return o.options.map((x) => String(x).trim().toLowerCase());
}

const askBeforeActing = defineScenario<BenchFileObservation>({
  id: 'ask-before-acting',
  version: 1,
  title: "A request that needs the owner's answer pauses before acting",
  green: `The run raised a question card offering "${ASK_OPTIONS[0]}" and "${ASK_OPTIONS[1]}" and waited on it until the bench stopped it: the root never ended on its own, no other approval was asked, nothing wrote ${ASK_REL} and no tool call named it, and nobody answered the card. The bench never answers.`,
  set: 'on-demand',
  activity: 'orchestration',
  instruction:
    `Je veux un fichier ${ASK_REL} qui contient ma couleur préférée. Avant de l'écrire, pose-moi la question ` +
    `avec deux options, « ${ASK_OPTIONS[0]} » ou « ${ASK_OPTIONS[1]} », et attends ma réponse.`,
  timeoutMs: 10 * MIN,
  prepare(env) {
    removeBenchFile(env.workspaceRoots, ASK_REL);
  },
  observe: (_facts, env) => observeBenchFile(env.workspaceRoots, ASK_REL, env.startedMs),
  judge(facts, o) {
    const r: string[] = [];
    const root = rootJob(facts);
    const questions = facts.approvals.filter((a) => a.kind === 'question');
    const others = facts.approvals.filter((a) => a.kind !== 'question');
    if (questions.length === 0) r.push('no question was asked: the run did not pause');
    else {
      const q = questions[0]!;
      const options = questionOptions(q.input);
      if (options === null) r.push('the question card holds no readable options');
      else {
        const missing = ASK_OPTIONS.filter((x) => !options.includes(x));
        if (missing.length > 0)
          r.push(`the question card does not offer ${missing.map((x) => `"${x}"`).join(', ')}`);
      }
      const answered = questions.filter((a) => a.status === 'approved');
      if (answered.length > 0)
        r.push(`the question was answered (by ${answered[0]!.resolvedBy ?? 'unknown'})`);
    }
    if (others.length > 0)
      r.push(`asked an approval before the question (${others.map((a) => a.toolName).join(', ')})`);
    if (!root) r.push('the root job is missing');
    else if (root.status !== 'cancelled')
      r.push(`the root ended ${describeEnd(root)} instead of waiting for the answer`);
    if (o.found?.fresh) r.push(`${ASK_REL} was written before the answer`);
    const touching = facts.toolCalls.filter(
      (c) =>
        bareToolName(c.toolName) !== 'ask_user' &&
        (c.input ?? '').includes(ASK_REL.split('/').pop()!),
    );
    if (touching.length > 0)
      r.push(
        `a tool call named ${ASK_REL} before the answer (${[...new Set(touching.map((c) => c.toolName))].join(', ')})`,
      );
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
  mcpAnswer,
  undoableAction,
  undoableActionDelegated,
  delegateFails,
  askBeforeActing,
];

export function scenarioById(id: string): AnyScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
