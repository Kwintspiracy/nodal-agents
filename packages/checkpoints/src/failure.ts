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
 * Ce que le magasin était en train de faire.
 *
 * Deux opérations qui n'échouent pas pour les mêmes raisons et n'appellent pas
 * le même geste : PRENDRE une photo parcourt le dossier de l'utilisateur, la
 * RELIRE ne touche que le magasin. Les confondre ferait dire à un refus de
 * lecture « déplace tes gros dossiers » alors que le dossier n'y est pour rien.
 */
export type CheckpointOperation = 'snapshot' | 'read';

/**
 * Pourquoi l'opération n'a pas abouti. Un code par cause qui appelle un GESTE
 * DIFFÉRENT du propriétaire — c'est le seul critère qui justifie un code de
 * plus. Le nom porte l'opération, parce qu'un `snapshot_timeout` rendu par une
 * LECTURE serait la même approximation que le `checkpoint_failed` que cette
 * série de correctifs supprime (revue #262, passe 2).
 */
export type CheckpointFailureCode =
  /** La borne de temps a été atteinte en photographiant : le dossier est trop gros. */
  | 'snapshot_timeout'
  /** Tout le reste, en photographiant (magasin corrompu, droits, disque plein). */
  | 'snapshot_failed'
  /** La borne de temps a été atteinte en RELISANT le magasin. */
  | 'checkpoint_read_timeout'
  /** Tout le reste, en relisant le magasin. */
  | 'checkpoint_read_failed'
  /** Le binaire `git` est introuvable : ni photo ni relecture ne sont possibles. */
  | 'git_missing';

/** La cause brute, avant qu'on sache pour quelle opération la nommer. */
export type CheckpointFailureCause = 'timeout' | 'git_missing' | 'other';

/** Le code d'une cause POUR une opération. La seule table, et elle est ici. */
export function checkpointFailureCode(
  cause: CheckpointFailureCause,
  operation: CheckpointOperation,
): CheckpointFailureCode {
  if (cause === 'git_missing') return 'git_missing';
  if (operation === 'snapshot') return cause === 'timeout' ? 'snapshot_timeout' : 'snapshot_failed';
  return cause === 'timeout' ? 'checkpoint_read_timeout' : 'checkpoint_read_failed';
}

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
 * Ce que l'instantané n'enregistre jamais, et que la mesure ne compte donc pas
 * non plus.
 *
 * UNE SEULE SOURCE pour les deux : `checkpoints.ts` construit ses `EXCLUDES` à
 * partir d'ici. Deux listes auraient dérivé, et la mesure aurait alors annoncé
 * une taille que git n'a jamais eu à enregistrer, envoyant le propriétaire
 * vider un dossier qui n'était pas le problème.
 *
 * DEUX listes et pas une (revue #262, passe 1) : un motif de fichier n'est pas
 * un nom de dossier, et `*.log` ne pouvait pas entrer dans un ensemble de noms
 * de dossiers. Les entrées de la seconde sont des SUFFIXES, pas des globs :
 * c'est tout ce dont la règle a besoin, et ça évite d'écrire un moteur de
 * motifs pour un seul cas.
 */
export const SKIPPED_DIRS: readonly string[] = [
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '__pycache__',
  '.venv',
  'target',
];

/** Fichiers exclus par leur fin de nom. `EXCLUDES` en fait des motifs `*<suffixe>`. */
export const SKIPPED_FILE_SUFFIXES: readonly string[] = ['.log'];

const MEASURE_SKIP: ReadonlySet<string> = new Set(SKIPPED_DIRS);

/** Un fichier que l'instantané n'enregistre pas ne pèse rien dans la mesure. */
function estUnFichierExclu(nom: string): boolean {
  return SKIPPED_FILE_SUFFIXES.some((suffixe) => nom.endsWith(suffixe));
}

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
      if (estUnFichierExclu(entry.name)) continue;
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

/** Les faits d'un échec du magasin, tels qu'ils ont été constatés. */
export interface CheckpointFailureFacts {
  code: CheckpointFailureCode;
  /** Photographier, ou relire ce qui a été photographié. */
  operation: CheckpointOperation;
  /** Le dossier concerné. */
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
  readonly operation: CheckpointOperation;
  readonly workspace: string;
  readonly limitMs: number | null;
  readonly elapsedMs: number | null;
  readonly measure: WorkspaceMeasure | null;
  readonly gitMessage: string;

  constructor(facts: CheckpointFailureFacts) {
    super(describeCheckpointFailure(facts));
    this.name = 'CheckpointError';
    this.code = facts.code;
    this.operation = facts.operation;
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
export function asCheckpointError(
  err: unknown,
  workspace: string,
  operation: CheckpointOperation = 'snapshot',
): CheckpointError {
  if (isCheckpointError(err)) return err;
  const first = err instanceof Error ? err.message.split('\n')[0] : undefined;
  return new CheckpointError({
    code: checkpointFailureCode('other', operation),
    operation,
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
 * Au-delà, un chemin est raccourci PAR LE MILIEU dans la phrase du refus.
 *
 * Deux bouts, jamais un seul : la tête dit où l'on est (le lecteur reconnaît
 * son disque), la queue dit lequel des dossiers c'est. Couper la queue d'un
 * `.../workspaces/<entité>/shared` rendrait tous les dossiers identiques.
 */
export const PATH_MAX_CHARS = 160;

/** Un chemin trop long, raccourci par le milieu et le DISANT (le caractère `…`). */
function shortenPath(path: string): string {
  if (path.length <= PATH_MAX_CHARS) return path;
  const head = Math.ceil((PATH_MAX_CHARS - 1) / 2);
  const tail = PATH_MAX_CHARS - 1 - head;
  return `${path.slice(0, head)}…${path.slice(path.length - tail)}`;
}

/**
 * Au-delà, ce que git a dit est coupé. Une sortie de git peut être longue ;
 * la phrase, elle, doit rester bornée pour que son GESTE survive.
 */
export const GIT_MESSAGE_MAX_CHARS = 200;

/**
 * LA phrase du refus : le code, les chiffres, et le geste à faire.
 *
 * Une seule source pour le message que l'outil rend à l'agent, celui que
 * l'écran affiche dans le fil, et celui que le journal porte. Trois copies
 * auraient divergé au premier correctif, et c'est la copie de l'écran qui
 * serait restée générique.
 *
 * ELLE EST BORNÉE PAR CONSTRUCTION (revue #262, passe 1). L'appelant la
 * coupait à 600 caractères, et sur un chemin profond cette coupe tombait dans
 * la fin de la phrase : elle mangeait « move or ignore the heavy folders »,
 * c'est-à-dire la seule partie sur laquelle quelqu'un peut agir. Ce sont donc
 * les parties VARIABLES qui sont bornées ici, chacune en le disant, et la
 * queue de la phrase ne bouge plus.
 */
export function describeCheckpointFailure(facts: CheckpointFailureFacts): string {
  const where = `the "${basename(facts.workspace)}" workspace (${shortenPath(facts.workspace)})`;
  const limit = facts.limitMs === null ? 'the time limit' : formatDuration(facts.limitMs);
  const said =
    facts.gitMessage.length <= GIT_MESSAGE_MAX_CHARS
      ? facts.gitMessage
      : `${facts.gitMessage.slice(0, GIT_MESSAGE_MAX_CHARS - 1)}…`;

  switch (facts.code) {
    case 'snapshot_timeout': {
      const size =
        facts.measure === null ? 'could not be measured' : describeMeasure(facts.measure);
      return (
        `snapshot_timeout: ${where} ${size}, the safety snapshot cannot finish in ` +
        `${limit}; move or ignore the heavy folders.`
      );
    }
    case 'snapshot_failed':
      return `snapshot_failed: the safety snapshot of ${where} failed: ${said}`;

    // LES DEUX PHRASES DE LECTURE NE PROMETTENT AUCUN GESTE, et c'est délibéré
    // (revue #262, passe 2). Une photo qui dépasse la borne parcourt le dossier
    // de l'utilisateur, donc « déplace les gros dossiers » est vrai et mesuré.
    // Une RELECTURE ne touche que le magasin : y recopier ce geste enverrait le
    // propriétaire vider un dossier qui n'a rien à voir, et compter le magasin
    // pour l'occasion coûterait le prix d'un instantané sur le chemin d'un clic
    // qui a déjà échoué. On dit donc ce qui s'est passé, et rien de plus.
    case 'checkpoint_read_timeout':
      return (
        `checkpoint_read_timeout: reading the checkpoint history of ${where} did not ` +
        `finish in ${limit}, so no history is shown rather than an empty one.`
      );
    case 'checkpoint_read_failed':
      return (
        `checkpoint_read_failed: reading the checkpoint history of ${where} failed, ` +
        `so no history is shown rather than an empty one: ${said}`
      );

    case 'git_missing':
      return facts.operation === 'snapshot'
        ? `git_missing: git is not available, so no safety snapshot can be taken for ${where}.`
        : `git_missing: git is not available, so the checkpoint history of ${where} cannot be read.`;
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
    `operation=${facts.operation}`,
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
