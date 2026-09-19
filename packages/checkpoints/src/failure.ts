// failure.ts — pourquoi un instantané a échoué, dit avec des CHIFFRES.
//
// ## Pourquoi ce fichier existe (issue #245)
//
// Le 19/09/2026, la session d'orchestration avait déballé 83 paquets de
// relecture dans le workspace partagé des agents : 3,3 Go. `git add -A` ne
// terminait plus dans la borne de temps de l'instantané, donc CHAQUE commande
// mutante était refusée — et c'est le bon comportement, un filet qui échoue en
// silence est pire que pas de filet. Ce qui n'était pas bon, c'est ce que le
// refus DISAIT : `checkpoint_failed: ... Cause: git add timed out after 30000
// ms`. Les agents délégués ont lu ça comme une panne du workspace et sont
// partis en chasse à la réparation, pour finir sur un `ask_user` demandant au
// propriétaire de réparer à la main. Personne n'a su que la cause tenait en
// une phrase : le dossier est trop gros.
//
// Un refus doit donc porter DEUX choses que le lecteur ne peut pas deviner :
//
//   1. un CODE typé (`snapshot_timeout` n'est pas `git_missing` n'est pas
//      `snapshot_failed`) — un agent peut brancher dessus, un humain peut le
//      chercher dans les journaux ;
//   2. les FAITS MESURÉS au moment du refus : la taille du dossier, le nombre
//      de fichiers, la borne de temps. Mesurés, jamais estimés (invariant #4).
//
// ## Pourquoi la mesure est BORNÉE
//
// Compter un arbre de 3,3 Go coûte exactement ce que coûtait l'instantané qui
// vient d'échouer. Une mesure qui fait attendre une minute de plus sur le
// chemin d'un refus transforme un diagnostic en seconde panne. Le compteur
// s'arrête donc à un plafond de fichiers ET à une borne de temps, et quand il
// s'arrête il le DIT : « more than 50,000 files » n'est pas « 50,000 files ».
// Un chiffre plancher honnête vaut mieux qu'un total exact qu'on n'a pas.

import { readdir, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

/**
 * Pourquoi l'instantané n'a pas pu être pris. Un code par cause qui appelle un
 * GESTE DIFFÉRENT du propriétaire — c'est le seul critère qui justifie un code
 * de plus.
 */
export type CheckpointFailureCode =
  /** La borne de temps a été atteinte : le dossier est trop gros pour le filet. */
  | 'snapshot_timeout'
  /** Le binaire `git` est introuvable : aucun instantané n'est possible ici. */
  | 'git_missing'
  /** Tout le reste (magasin corrompu, droits, disque plein). */
  | 'snapshot_failed';

/**
 * Ce que pèse un dossier, tel qu'il a été COMPTÉ — jamais estimé.
 *
 * `capped` vrai = le comptage s'est arrêté avant la fin. `bytes` et `files`
 * sont alors des PLANCHERS, et toute phrase qui les rend doit le dire.
 */
export interface WorkspaceMeasure {
  /** Octets additionnés des fichiers comptés. */
  bytes: number;
  /** Fichiers comptés. */
  files: number;
  /** Le comptage s'est arrêté au plafond : les deux chiffres sont des minorants. */
  capped: boolean;
}

/** Au-delà, on arrête de compter et on le dit. */
export const MEASURE_MAX_FILES = 50_000;

/** Et au-delà de ce temps aussi : un diagnostic ne doit pas devenir l'attente. */
export const MEASURE_MAX_MS = 3_000;

/**
 * Dossiers jamais descendus par la mesure — les mêmes que ceux que
 * l'instantané exclut (`EXCLUDES` dans checkpoints.ts). Les compter donnerait
 * un chiffre qui ne correspond à rien de ce que git a eu à faire, et enverrait
 * le propriétaire vider un `node_modules` qui n'était pas le problème.
 */
const MEASURE_SKIP: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'target',
]);

/**
 * Compte les fichiers et les octets d'un dossier, en s'arrêtant au plafond.
 *
 * Les liens (jonctions Windows comprises) ne sont JAMAIS suivis : une jonction
 * `node_modules` vers le dépôt principal ferait compter le monorepo entier, et
 * la boucle d'un lien vers un parent ne finirait jamais.
 *
 * Ce que la mesure voit est le DISQUE, pas l'index git : un dossier que le
 * `.gitignore` du workspace exclut est compté ici alors que l'instantané ne le
 * photographie pas. C'est voulu — le geste qu'on demande au propriétaire est
 * « déplace ou ignore les gros dossiers », et pour le faire il doit savoir ce
 * qu'il y a sur son disque.
 */
export async function measureWorkspace(
  workspace: string,
  limits: { maxFiles?: number; maxMs?: number } = {},
): Promise<WorkspaceMeasure> {
  const maxFiles = limits.maxFiles ?? MEASURE_MAX_FILES;
  const maxMs = limits.maxMs ?? MEASURE_MAX_MS;
  const deadline = Date.now() + maxMs;

  let bytes = 0;
  let files = 0;
  let capped = false;
  const pending: string[] = [workspace];

  while (pending.length > 0) {
    if (files >= maxFiles || Date.now() >= deadline) {
      capped = true;
      break;
    }
    const dir = pending.pop();
    if (dir === undefined) break;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Un dossier illisible ne fait pas échouer un diagnostic : il manque au
      // total, et le total est déjà annoncé comme un plancher quand il compte.
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!MEASURE_SKIP.has(entry.name)) pending.push(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      if (files >= maxFiles || Date.now() >= deadline) {
        capped = true;
        break;
      }
      files++;
      try {
        bytes += (await stat(join(dir, entry.name))).size;
      } catch {
        // Fichier disparu entre le `readdir` et le `stat` : compté, non pesé.
      }
    }
    if (capped) break;
  }

  return { bytes, files, capped };
}

/** Les faits d'un échec d'instantané, tels qu'ils ont été constatés. */
export interface CheckpointFailureFacts {
  code: CheckpointFailureCode;
  /** Le dossier qu'on n'a pas pu photographier. */
  workspace: string;
  /**
   * La borne de temps en vigueur, en millisecondes — `null` quand l'échec n'est
   * pas venu du chemin de l'instantané et qu'aucune borne n'était en jeu. Zéro
   * mentirait : il se lirait comme une borne mesurée (invariant #4).
   */
  limitMs: number | null;
  /** Ce que la tentative a réellement pris, en millisecondes. Même règle. */
  elapsedMs: number | null;
  /** Mesuré sur un `snapshot_timeout`, absent sinon (rien à mesurer). */
  measure: WorkspaceMeasure | null;
  /** La première ligne de ce que git a dit, pour le journal. */
  gitMessage: string;
}

/**
 * Un échec d'instantané, avec ses faits.
 *
 * Une `Error` et pas un objet de retour : les deux points d'appel (le seam de
 * `packages/tools` et le harnais CLI du runner) entourent déjà `snapshot`
 * d'un `try`, et un refus doit rester un refus même pour un appelant qui
 * n'aurait pas lu ce fichier.
 */
export class CheckpointError extends Error {
  readonly code: CheckpointFailureCode;
  readonly workspace: string;
  readonly limitMs: number | null;
  readonly elapsedMs: number | null;
  readonly measure: WorkspaceMeasure | null;
  readonly gitMessage: string;

  constructor(facts: CheckpointFailureFacts) {
    super(describeCheckpointFailure(facts));
    this.name = 'CheckpointError';
    this.code = facts.code;
    this.workspace = facts.workspace;
    this.limitMs = facts.limitMs;
    this.elapsedMs = facts.elapsedMs;
    this.measure = facts.measure;
    this.gitMessage = facts.gitMessage;
  }
}

/** Vrai si cette erreur porte déjà ses faits — sinon il faut les qualifier. */
export function isCheckpointError(err: unknown): err is CheckpointError {
  return err instanceof CheckpointError;
}

/**
 * Une erreur quelconque rendue comme un échec de checkpoint.
 *
 * `snapshot` lève toujours une `CheckpointError`, mais les deux points de refus
 * entourent aussi d'autres lectures (`headCheckpoint`, par exemple) : celles-là
 * n'ont pas de borne de temps en jeu, d'où `limitMs` et `elapsedMs` à `null`.
 * Une seule fonction pour les deux appelants, sinon le repli serait recopié —
 * et une copie finirait par dire autre chose que l'autre.
 */
export function asCheckpointError(err: unknown, workspace: string): CheckpointError {
  if (isCheckpointError(err)) return err;
  const first = err instanceof Error ? err.message.split('\n')[0] : undefined;
  return new CheckpointError({
    code: 'snapshot_failed',
    workspace,
    limitMs: null,
    elapsedMs: null,
    measure: null,
    gitMessage: first ?? String(err),
  });
}

/**
 * Des octets en une unité lisible.
 *
 * Base 1024 et étiquettes courtes, comme `du -sh` : c'est la commande par
 * laquelle le propriétaire vérifiera le chiffre, et deux réponses différentes
 * pour le même dossier coûteraient plus que la rigueur des préfixes.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rendered = value >= 100 ? value.toFixed(0) : value.toFixed(1);
  return `${rendered.replace(/\.0$/, '')} ${units[unit]}`;
}

/**
 * Un entier avec ses milliers séparés, SANS `toLocaleString` : la sortie doit
 * être la même dans un test, dans un journal et sur un écran, quelle que soit
 * la locale du processus.
 */
export function formatCount(n: number): string {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Une durée en millisecondes, dite en secondes dès qu'elle en vaut une. */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = ms / 1000;
  return `${(seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)).replace(/\.0$/, '')} s`;
}

/** `holds 3.3 GB / 200,000 files`, ou le même avec « more than » si on a arrêté de compter. */
function describeMeasure(measure: WorkspaceMeasure): string {
  const size = formatBytes(measure.bytes);
  const files = `${formatCount(measure.files)} file${measure.files === 1 ? '' : 's'}`;
  return measure.capped
    ? `holds more than ${size} / more than ${files}`
    : `holds ${size} / ${files}`;
}

/**
 * LA phrase du refus : le code, les chiffres, et le geste à faire.
 *
 * Une seule source pour le message que l'outil rend à l'agent, celui que
 * l'écran affiche dans le fil, et celui que le journal porte. Trois copies
 * auraient divergé au premier correctif, et c'est la copie de l'écran qui
 * serait restée générique.
 */
export function describeCheckpointFailure(facts: CheckpointFailureFacts): string {
  const where = `the "${basename(facts.workspace)}" workspace (${facts.workspace})`;
  switch (facts.code) {
    case 'snapshot_timeout': {
      const size =
        facts.measure === null ? 'could not be measured' : describeMeasure(facts.measure);
      const limit = facts.limitMs === null ? 'the time limit' : formatDuration(facts.limitMs);
      return (
        `snapshot_timeout: ${where} ${size}, the safety snapshot cannot finish in ` +
        `${limit}; move or ignore the heavy folders.`
      );
    }
    case 'git_missing':
      return `git_missing: git is not available, so no safety snapshot can be taken for ${where}.`;
    case 'snapshot_failed':
      return `snapshot_failed: the safety snapshot of ${where} failed: ${facts.gitMessage}`;
  }
}

/**
 * Le message rendu à l'appelant qui a REFUSÉ une écriture à cause de cet échec.
 *
 * `refused` nomme ce qui n'a pas eu lieu — le nom d'un outil, ou le tour d'un
 * harnais. Le reste de la phrase est celui de `describeCheckpointFailure` : on
 * ajoute la conséquence, jamais une deuxième version de la cause.
 */
export function checkpointRefusalMessage(facts: CheckpointFailureFacts, refused: string): string {
  return (
    `${describeCheckpointFailure(facts)} ` +
    `${refused} was refused rather than run without a way back.`
  );
}

/**
 * LA ligne de journal d'un refus — une seule, faite de paires `clé=valeur`.
 *
 * Elle existe pour que l'incident de #245 soit diagnosticable sans deviner :
 * quatre heures y sont passées faute d'un chiffre écrit quelque part. Le format
 * est grepable (`CHECKPOINT_REFUSED`) et chaque fait y est nommé, y compris
 * `files_capped`, sans lequel un plancher se lirait comme un total.
 */
export function checkpointFailureLogLine(
  facts: CheckpointFailureFacts,
  context: Readonly<Record<string, string | number | undefined>> = {},
): string {
  const fields: string[] = [
    `code=${facts.code}`,
    `workspace=${JSON.stringify(facts.workspace)}`,
    `limit_ms=${facts.limitMs ?? 'unknown'}`,
    `elapsed_ms=${facts.elapsedMs ?? 'unknown'}`,
    `bytes=${facts.measure?.bytes ?? 'unmeasured'}`,
    `files=${facts.measure?.files ?? 'unmeasured'}`,
    `files_capped=${facts.measure?.capped ?? 'unmeasured'}`,
  ];
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined) fields.push(`${key}=${value}`);
  }
  return `[checkpoints] CHECKPOINT_REFUSED ${fields.join(' ')}`;
}
