// lib/workspace-inventory.ts — shallow listing of the entity's SHARED workspace,
// injected into the system prompt at job start (JobContext.workspaceInventory).
//
// Why: without a live inventory the agent starts every job blind to what
// already exists — so it recreates workflows/scripts it built the day before
// and invents a new folder layout each time (audited 2026-07-20: 3 competing
// workflow dirs, 4 output dirs, ~40 one-shot scripts at the root). The listing
// gives the model what it cannot guess: which folders are there, and that they
// hold something. Factual data only — behavioral conventions live at the agent
// layer (skills), never here.
//
// FOLDERS AND COUNTS, never the names of the files (#638, 01/10). The listing
// showed up to eight names per folder, and those names are yesterday's
// deliverables: asked to "print a recipe of caviar d'aubergines", the root read
// `caviar-aubergines/ (3 files): caviar-aubergines.html, …` in its own prompt,
// opened that file and edited it instead of doing the request (job a22e173f).
// A file NAME never let an agent reuse a workflow or a script anyway — it has
// to read it first, and listing the folder is the same one call. What the
// listing keeps is what stops a recreation: `workflows/ (19 files)` says where
// the means live and that there are some, and the folder names are the
// layout new files go into.
//
// Cost/cache: computed once per job (the built prompt is persisted on the job
// row) and rendered in the VOLATILE half of the system prompt, after
// SYSTEM_PROMPT_CACHE_BOUNDARY — it must never bust the stable-half cache.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

/** Root folders beyond this count are elided (keeps pathological dirs bounded). */
const MAX_ROOT_FOLDERS = 30;
/** Hard cap on the rendered block (chars) — safety net, not a target. */
const MAX_CHARS = 3500;
/** Never descended into nor counted: tooling noise, not agent artifacts. */
const IGNORED = new Set(['node_modules', '.git', '__pycache__']);

async function safeReaddir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Recursive file count, skipping IGNORED and dot-dirs. Bounded by `budget`. */
async function countFiles(dir: string, budget: { n: number }): Promise<number> {
  let count = 0;
  for (const e of await safeReaddir(dir)) {
    if (budget.n <= 0) return count;
    if (IGNORED.has(e.name) || e.name.startsWith('.')) continue;
    if (e.isDirectory()) {
      count += await countFiles(join(dir, e.name), budget);
    } else {
      count++;
      budget.n--;
    }
  }
  return count;
}

/**
 * Ce que le contexte de job doit porter — `undefined` pour ne rien rendre.
 *
 * Le champ commandait DEUX choses à la fois (revue Codex, 26/08) : la présence
 * d'un listing, ET celle du bloc entier. Sur une install neuve, où le partagé
 * est vide, `buildSharedWorkspaceInventory` rend `''` — et l'agent perdait donc
 * aussi la consigne « ce que tu produis pour ton propriétaire va dans ton
 * dossier attaché ». Précisément le moment où rien d'autre ne l'a encore mis
 * sur les rails.
 *
 * Les deux questions sont séparées ici, et la distinction reste honnête :
 * `sharedPath` n'est non-nul que si le `mkdir` a réussi, donc le dossier
 * EXISTE. Un listing vide veut alors dire vide — pas « on n'a pas su
 * regarder », ce qui serait un repli silencieux sur une phrase que l'agent
 * lit avant d'écrire.
 *
 * Et « on n'a pas su regarder » EXISTE quand même (revue Codex, 27/08) : une
 * permission refusée, une erreur d'E/S passagère. `mkdir` prouve que le dossier
 * est là, pas qu'il est lisible. Ce cas-là arrive ici comme `null` et se dit,
 * au lieu de se déguiser en « vide » — sinon l'agent recrée en toute confiance
 * ce qu'il n'a simplement pas pu voir (invariant #4).
 */
export function inventoryForContext(
  sharedPath: string | null,
  listing: string | null,
): string | undefined {
  if (!sharedPath) return undefined;
  if (listing === null) return '(could not be read — assume nothing about what is in there)';
  return listing || '(empty)';
}

/**
 * Render the inventory of `root` (the shared workspace): its folders, each with
 * its recursive file count, then how many files sit at the root.
 *
 * `''` when the directory is empty, `null` when it could NOT be read — les deux
 * ne se confondent pas : le second se dit à l'agent, le premier est un fait.
 * Plain factual text, one line per folder:
 *
 *   - workflows/ (19 files)
 *   - 2 files at the root
 */
export async function buildSharedWorkspaceInventory(root: string): Promise<string | null> {
  let rootEntries;
  try {
    rootEntries = await readdir(root, { withFileTypes: true });
  } catch {
    // La RACINE, elle, ne se rattrape pas en silence : un `[]` ici deviendrait
    // « (empty) » dans le prompt. Plus bas, un sous-dossier illisible reste
    // toléré — il ne condamne pas tout l'inventaire.
    return null;
  }

  const entries = rootEntries.filter((e) => !IGNORED.has(e.name) && !e.name.startsWith('.'));
  const folders = entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));
  const rootFiles = entries.length - folders.length;
  if (entries.length === 0) return '';

  const lines: string[] = [];
  for (const e of folders.slice(0, MAX_ROOT_FOLDERS)) {
    const total = await countFiles(join(root, e.name), { n: 2000 });
    lines.push(`- ${e.name}/ (${total} file${total === 1 ? '' : 's'})`);
  }
  if (folders.length > MAX_ROOT_FOLDERS) {
    lines.push(`- … ${folders.length - MAX_ROOT_FOLDERS} more folders elided`);
  }
  if (rootFiles > 0) {
    lines.push(`- ${rootFiles} file${rootFiles === 1 ? '' : 's'} at the root`);
  }

  const text = lines.join('\n');
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n- … truncated` : text;
}
