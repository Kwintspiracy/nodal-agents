// builtin/shell-engine.ts — LE moteur d'exécution de processus enfants, une fois.
//
// Jusqu'au 03/09 il existait en trois copies : run-command.ts (shell:true),
// run-skill-script.ts (shell:false, interprète + argv) et code-task/process.ts
// (le CLI de code). Trois `spawn`, trois captures, trois tree-kill — et deux
// des trois tuaient cmd.exe AVANT que taskkill énumère l'arbre, si bien que le
// petit-enfant survivait au timeout (sonde du 03/09 : vivant 3 fois sur 3).
//
// Le plan « Vérifier & Corriger » a besoin d'un moteur PUR pour lancer les
// commandes de preuve d'un projet : sans dépendance au contexte d'outil, à la
// base ou au workspace, testable seul, avec une issue TYPÉE (exit / timeout /
// spawn_error) au lieu d'un `exitCode: null` qui voulait dire deux choses.
// run_command et run_skill_script s'en servent désormais ; code-task/process.ts
// garde sa capture (protocole d'événements propre au CLI) — le dire ici plutôt
// que de laisser croire qu'il n'en reste qu'une. Le LANCEMENT et le tree-kill,
// eux, n'existent plus qu'une fois pour tous : le périmètre du job
// (@nodal-agents/sandbox job-scope.ts, #750).
//
// POLITIQUE SHELL (SHELL_POLICY_VERSION, @nodal-agents/shared) : la version
// sous laquelle une commande de preuve a été approuvée. Elle couvre tout ce qui
// change ce qu'une commande FAIT :
//   - shell:true ⇒ `cmd.exe /d /s /c "<commande>"` sur Windows (pour que `&&`
//     marche — PowerShell s'y casserait), `/bin/sh -c "<commande>"` ailleurs ;
//   - shell:false ⇒ argv littéral, aucune interpolation ;
//   - `windowsHide`, `detached` sur Unix (leader de groupe ⇒ kill du groupe) ;
//   - tree-kill au timeout, 3 s de grâce puis résolution forcée ;
//   - capture bornée par flux, décodage UTF-8 par StringDecoder, politique
//     `keep` explicite (tête ou queue) ;
//   - (v2, #628) le bac à sable quand il est disponible, les variables de
//     cache d'outils, le périmètre de processus du job. Que ce périmètre
//     tienne AUSSI les descendants détachés hors bac à sable (#755 : Job
//     Object sous Windows, étiquette d'environnement sous Unix) est la
//     promesse de v2 enfin tenue, pas un changement de ce que la commande
//     fait : la ligne de commande Windows est celle que Node produisait
//     (command-line.ts), mot pour mot.
// Changer l'un de ces points = bumper SHELL_POLICY_VERSION.
//
// BAC À SABLE (#628, étape 1) : chaque commande passe par
// `@nodal-agents/sandbox`. Quand le bac à sable est disponible, elle ne peut
// écrire que dans les dossiers que l'APPELANT déclare (`confinement`), son
// temporaire et les caches d'outils ; un démarrage refusé par le bac à sable
// refuse la commande (spawn_error `SANDBOX_START_FAILED`), jamais un repli
// sans confinement. Quand il n'est pas disponible, la commande tourne comme
// avant, et la raison est journalisée une fois par processus avec un code
// (`getSandboxStatus()` la rend au bandeau). Un seul chemin pour les trois
// appelants : `run_command`, `run_skill_script`, les commandes de preuve.
//
// DURÉE DE VIE (décision du 14/10) : chaque commande tourne dans le PÉRIMÈTRE
// de son job (`scope`, @nodal-agents/sandbox job-scope.ts), confinée
// (`scope.container`) ou non (`scope.startOwned` : sous Windows dans le Job
// Object du job, sous Unix cheffe de son groupe et étiquetée). Ce qu'elle
// laisse tourner en arrière-plan vit jusqu'à la fin du job — la commande
// suivante joint le serveur que la précédente a lancé — et meurt quand le
// runner ferme le périmètre, détaché ou non. La fin d'une commande est la fin
// de son processus racine, ses flux vidés au plus DRAIN_MS : un processus
// d'arrière-plan qui garde le tuyau de sortie ne retient pas la commande
// jusqu'à son timeout. Le Stop (`signal`) tue la commande comme le timeout,
// par le même geste (`StartedProcess.kill`, un seul tree-kill dans le dépôt :
// @nodal-agents/sandbox process-tree.ts).
//
// Les messages de ce module sont des CODES techniques (invariant #2 : aucun
// texte utilisateur dans une couche que le runner exécute).

import { statSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { VerifyCommandsSchema, type RunVerdict, type VerifyCommand } from '@nodal-agents/shared';
import {
  SandboxStartError,
  extractRefusedWrites,
  resolveWritableRoots,
  toolCacheEnv,
  type ConfinementPolicy,
  type JobProcessScope,
  type LaunchTarget,
  type ProcessEnd,
  type RefusedWrite,
  type StartedProcess,
} from '@nodal-agents/sandbox';

export { SHELL_POLICY_VERSION } from '@nodal-agents/shared';

/** Plafond de capture par flux, en caractères. Au-delà on draine sans stocker. */
export const DEFAULT_MAX_OUTPUT_CHARS = 100_000;

/** Délai de grâce après le tree-kill avant de résoudre quand même. */
const KILL_GRACE_MS = 3_000;

/** Ce qui est arrivé au processus — trois issues, jamais confondues. */
export type CommandOutcome =
  | { kind: 'exit'; exitCode: number }
  | { kind: 'timeout' }
  | { kind: 'spawn_error'; message: string };

/**
 * Sous quel régime la commande a tourné — dit dans le résultat, pour que
 * l'appelant (et l'agent) sache où elle pouvait écrire.
 */
export type CommandConfinement =
  | {
      kind: 'confined';
      /** Le backend qui a confiné (`mxc-processcontainer`). */
      backend: string;
      /** Où la commande pouvait écrire, chemins résolus — hors son temporaire. */
      writableRoots: readonly string[];
      /** Les écritures refusées que la sortie laisse voir, la ligne de l'OS citée. */
      refusedWrites: readonly RefusedWrite[];
    }
  | {
      kind: 'unconfined';
      /** Pourquoi : le code stable de `getSandboxStatus()`. */
      code: string;
    };

export interface CommandRunResult {
  outcome: CommandOutcome;
  stdout: string;
  stderr: string;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number;
  cwd: string;
  confinement: CommandConfinement;
}

/**
 * Ce que le résultat de TOUTE commande passée par ce moteur dit de son
 * régime (#628) — invariant #4 : une commande qui a tourné sans bac à sable
 * le dit elle-même, dans son tool_result, et pas seulement dans un journal.
 *   - confinée : où elle pouvait écrire, et les écritures refusées (la ligne
 *     de l'OS citée, le chemin quand la ligne le nomme) — la liste n'est
 *     présente que si elle n'est pas vide ;
 *   - non confinée : le code stable de `getSandboxStatus()`, rien de plus —
 *     chaque commande le paie en jetons, sous macOS et Linux toutes.
 */
export type SandboxReport =
  | { confined: true; writableRoots: readonly string[]; refusedWrites?: readonly RefusedWrite[] }
  | { confined: false; code: string };

/**
 * La phrase de description, pour le modèle, des outils dont les commandes
 * passent par ce moteur (`run_command`, `run_skill_script`). Une seule copie.
 */
export const SANDBOX_RESULT_RULE =
  "The result's `sandbox` says whether Nodal's sandbox confined the process: `confined: false` " +
  '(with a `code`) means its writes were not limited, `confined: true` means it could write only ' +
  'inside `sandbox.writableRoots` and its temp folder, and a refused write is listed in ' +
  '`sandbox.refusedWrites` (OS error, path when known), so write inside those folders instead of ' +
  'retrying the same path.';

/** Le rapport de bac à sable d'un résultat — toujours présent, confiné ou non. */
export function sandboxReport(run: CommandRunResult): SandboxReport {
  const c = run.confinement;
  if (c.kind === 'unconfined') return { confined: false, code: c.code };
  return {
    confined: true,
    writableRoots: c.writableRoots,
    ...(c.refusedWrites.length > 0 ? { refusedWrites: c.refusedWrites } : {}),
  };
}

/**
 * Le même fait, en un mot, pour ce qui le CONSERVE (`verification_runs.sandbox`) :
 * `confined`, ou le code stable de la raison pour laquelle la commande ne
 * l'a pas été.
 */
export function sandboxFact(confinement: CommandConfinement): string {
  return confinement.kind === 'confined' ? 'confined' : confinement.code;
}

/**
 * Ce qu'on lance : une commande shell, ou un exécutable avec ses arguments.
 *
 * `windowsVerbatimArguments` (Windows) : passer argv TEL QUEL, sans le
 * requotage de Node. Un seul appelant le pose — `run_command` sous liste
 * blanche, pour lancer un `.cmd` via `cmd.exe /d /s /c "<ligne>"`, la seule
 * forme mesurée qui marche (sans verbatim Node échappe les guillemets en \"
 * que cmd ne lit pas). Absent partout ailleurs : ce que fait une commande de
 * preuve déjà approuvée n'en dépend pas.
 */
export type CommandTarget = LaunchTarget;

export interface CommandSpec {
  target: CommandTarget;
  cwd: string;
  timeoutMs: number;
  /**
   * OBLIGATOIRE. Le moteur refuse de tomber sur `process.env` : un enfant qui
   * hérite de l'environnement du runner lit DATABASE_URL et les clés LLM.
   * Passer `buildChildEnv(process.env, …)`.
   */
  env: Record<string, string | undefined>;
  /**
   * `head` (défaut) : les premiers caractères — ce que l'agent lit dans un
   * tool_result. `tail` : les DERNIERS — ce qu'une preuve garde, parce que
   * l'erreur d'un test est à la fin.
   */
  keep?: 'head' | 'tail';
  maxChars?: number;
  /**
   * OBLIGATOIRE, comme `env`. Les dossiers du job où la commande peut écrire
   * quand le bac à sable est disponible : ses workspaces et le dossier
   * attaché à la demande. L'appelant les donne — le moteur ne devine aucune
   * racine. Une liste vide est permise et veut dire « nulle part » ;
   * l'absence est une erreur d'appelant (`CONFINEMENT_REQUIRED`).
   */
  confinement: ConfinementPolicy;
  /**
   * OBLIGATOIRE. Le périmètre du job (`jobProcessScope(ctx.jobId)`) : ce que
   * la commande laisse tourner y vit jusqu'à la fin du job, et meurt quand le
   * runner le ferme. Il porte aussi le bac à sable sous lequel elle tourne.
   * L'absence est une erreur d'appelant (`SCOPE_REQUIRED`).
   */
  scope: JobProcessScope;
  /**
   * Le Stop du job : quand il tombe, la commande est tuée comme au timeout
   * (outcome `spawn_error` / `ABORTED`). Ce qu'elle a lancé en arrière-plan
   * meurt avec le périmètre, que le runner ferme à la fin du job.
   */
  signal?: AbortSignal;
}

/**
 * Lance une commande, capture sa sortie bornée, la tue au timeout ou au Stop,
 * et rend une issue typée. Ne lève JAMAIS pour une panne du processus (elle
 * devient `spawn_error`) ; lève pour un contrat violé par l'appelant
 * (`ENV_REQUIRED`, `CONFINEMENT_REQUIRED`, `SCOPE_REQUIRED`).
 */
export function runShellCommand(spec: CommandSpec): Promise<CommandRunResult> {
  if (spec.env === undefined || spec.env === null) {
    throw new Error('ENV_REQUIRED');
  }
  if (spec.confinement === undefined || spec.confinement === null) {
    throw new Error('CONFINEMENT_REQUIRED');
  }
  if (spec.scope === undefined || spec.scope === null) {
    throw new Error('SCOPE_REQUIRED');
  }
  return runInScope(spec);
}

async function runInScope(spec: CommandSpec): Promise<CommandRunResult> {
  const keep = spec.keep ?? 'head';
  const cap = spec.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const sandbox = spec.scope.sandbox;
  const status = await sandbox.status();
  // Les caches d'outils, désignés pour TOUTE commande (policy.ts du paquet
  // sandbox dit lesquels et pourquoi) : confinée ou non, une commande garde
  // le même cache.
  const env: Record<string, string | undefined> = { ...spec.env, ...toolCacheEnv() };
  const startedAt = Date.now();

  const confinement: CommandConfinement =
    status.state === 'available' && sandbox.backend
      ? {
          kind: 'confined',
          backend: status.backend,
          writableRoots: resolveWritableRoots(spec.confinement),
          refusedWrites: [],
        }
      : {
          kind: 'unconfined',
          code: status.state === 'unavailable' ? status.code : 'SANDBOX_NOT_IMPLEMENTED',
        };
  const notStarted = (message: string): CommandRunResult => ({
    outcome: { kind: 'spawn_error', message },
    stdout: '',
    stderr: '',
    truncatedStdout: false,
    truncatedStderr: false,
    durationMs: Date.now() - startedAt,
    cwd: spec.cwd,
    confinement,
  });

  // Un job arrêté ne lance plus rien.
  if (spec.signal?.aborted) return notStarted('ABORTED');
  // Un dossier de départ absent est dit par son nom, sous les deux régimes :
  // Node répondait `spawn cmd.exe ENOENT` (le shell accusé à tort), et MXC
  // lance la commande quand même, ailleurs.
  if (!isExistingDirectory(spec.cwd)) return notStarted(`CWD_NOT_FOUND: ${spec.cwd}`);

  let proc: StartedProcess;
  try {
    const launch = { target: spec.target, cwd: spec.cwd, env };
    proc =
      confinement.kind === 'confined'
        ? await (await spec.scope.container(confinement.writableRoots, env)).start(launch)
        : await spec.scope.startOwned(launch);
  } catch (e) {
    if (!(e instanceof SandboxStartError)) throw e;
    // Le bac à sable est là mais n'a pas pu démarrer CETTE commande, ou le job
    // ne peut pas la tenir (son Job Object, sous Windows) : elle est refusée,
    // avec la raison. Jamais lancée sans confinement, ni hors de son job.
    return notStarted(e.message);
  }

  const out = new StreamCapture(cap, keep);
  const err = new StreamCapture(cap, keep);
  // On continue de drainer le tuyau après le plafond : un enfant dont le
  // tuyau OS est plein se bloque, et le timeout le tuerait pour rien.
  proc.stdout?.on('data', (c: Buffer) => out.push(c));
  proc.stderr?.on('data', (c: Buffer) => err.push(c));

  return new Promise<CommandRunResult>((resolve) => {
    let settled = false;
    let cut: 'timeout' | 'aborted' | null = null;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;
    const cutOutcome = (): CommandOutcome =>
      cut === 'aborted' ? { kind: 'spawn_error', message: 'ABORTED' } : { kind: 'timeout' };

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      spec.signal?.removeEventListener('abort', onAbort);
      const stdout = out.end();
      const stderr = err.end();
      resolve({
        outcome,
        stdout,
        stderr,
        truncatedStdout: out.truncated,
        truncatedStderr: err.truncated,
        durationMs: Date.now() - startedAt,
        cwd: spec.cwd,
        confinement:
          confinement.kind === 'confined'
            ? {
                ...confinement,
                refusedWrites: extractRefusedWrites(
                  `${stderr}\n${stdout}`,
                  confinement.writableRoots,
                  spec.cwd,
                ),
              }
            : confinement,
      });
    };

    const cutNow = (why: 'timeout' | 'aborted'): void => {
      if (cut !== null || settled) return;
      cut = why;
      proc.kill();
      // Un petit-enfant têtu peut garder un tuyau ouvert après le kill : on
      // résout quand même, le kill a été émis.
      graceTimer = setTimeout(() => finish(cutOutcome()), KILL_GRACE_MS);
    };
    const onAbort = (): void => cutNow('aborted');
    const timer = setTimeout(() => cutNow('timeout'), spec.timeoutMs);
    spec.signal?.addEventListener('abort', onAbort, { once: true });

    void proc.done.then((end: ProcessEnd) => {
      if (cut !== null) return finish(cutOutcome());
      if (end.kind === 'exit') return finish({ kind: 'exit', exitCode: end.exitCode });
      // `signal` sans coupure de notre part = tué par un signal externe : pas
      // une sortie propre, on le dit comme tel plutôt que d'inventer un code.
      finish({
        kind: 'spawn_error',
        message: end.kind === 'error' ? end.message : 'KILLED_BY_SIGNAL',
      });
    });
  });
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Capture bornée d'un flux, décodée par StringDecoder : les frontières de
 * chunks ne tombent pas sur des frontières UTF-8, et `chunk.toString()` par
 * morceau corrompait les caractères multi-octets (é → �).
 */
class StreamCapture {
  private text = '';
  private readonly decoder = new StringDecoder('utf8');
  truncated = false;

  constructor(
    private readonly cap: number,
    private readonly keep: 'head' | 'tail',
  ) {}

  push(chunk: Buffer): void {
    const piece = this.decoder.write(chunk);
    if (piece.length === 0) return;
    if (this.keep === 'head') {
      if (this.text.length >= this.cap) {
        this.truncated = true;
        return;
      }
      const room = this.cap - this.text.length;
      if (piece.length <= room) {
        this.text += piece;
      } else {
        this.truncated = true;
        this.text += piece.slice(0, room);
      }
      return;
    }
    // tail : on garde la FIN. Concaténer puis couper devant.
    this.text += piece;
    if (this.text.length > this.cap) {
      this.truncated = true;
      this.text = this.text.slice(this.text.length - this.cap);
    }
  }

  end(): string {
    const rest = this.decoder.end();
    if (rest.length > 0) this.push(Buffer.from(rest, 'utf8'));
    return this.text;
  }
}

// ─── Séquence de preuve (v5-A) ────────────────────────────────────────────────

export interface SequenceStepResult extends CommandRunResult {
  rank: number;
  command: string;
}

export interface SequenceResult {
  /** `green` ssi toutes vertes ; premier exit ≠ 0 ⇒ `red` ; premier timeout/spawn_error ⇒ `infra_error`. */
  verdict: RunVerdict;
  /** Un résultat par commande LANCÉE — celles qui suivent un rouge n'existent pas. */
  results: SequenceStepResult[];
  /** Rang de la commande qui a arrêté la séquence, absent si tout est vert. */
  stoppedAtRank?: number;
}

export interface SequenceOptions {
  cwd: string;
  env: Record<string, string | undefined>;
  /** Les dossiers du job où chaque commande peut écrire (voir `CommandSpec`). */
  confinement: ConfinementPolicy;
  /** Le périmètre du job (voir `CommandSpec`). */
  scope: JobProcessScope;
  /** Le Stop du job : la commande en cours est tuée, les suivantes ne partent pas. */
  signal?: AbortSignal;
  keep?: 'head' | 'tail';
  maxChars?: number;
  /**
   * Appelé ET attendu après CHAQUE commande, avant la suivante : l'appelant y
   * écrit sa ligne `verification_runs` par rang, si bien qu'un crash pendant la
   * 2e commande ne perd pas la 1re. Un callback qui rejette interrompt la
   * séquence et propage — la persistance prime (principe 3 du plan).
   */
  onCommandDone: (result: SequenceStepResult) => Promise<void>;
}

/**
 * Exécute une liste ORDONNÉE de commandes de preuve, arrêt au premier non-vert.
 * La liste est validée à l'entrée : vide ou trop longue ⇒ `VERIFY_COMMANDS_INVALID`
 * — une séquence vide « verte » serait un faux vert.
 */
export async function runCommandSequence(
  entries: readonly VerifyCommand[],
  opts: SequenceOptions,
): Promise<SequenceResult> {
  const parsed = VerifyCommandsSchema.safeParse(entries);
  if (!parsed.success) {
    throw new Error(
      `VERIFY_COMMANDS_INVALID: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }
  const results: SequenceStepResult[] = [];
  for (const [rank, entry] of parsed.data.entries()) {
    const run = await runShellCommand({
      target: { command: entry.command },
      cwd: opts.cwd,
      timeoutMs: entry.timeoutSeconds * 1000,
      env: opts.env,
      confinement: opts.confinement,
      scope: opts.scope,
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      keep: opts.keep ?? 'tail',
      ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
    });
    const step: SequenceStepResult = { ...run, rank, command: entry.command };
    results.push(step);
    await opts.onCommandDone(step);
    if (!isGreen(run.outcome)) {
      return {
        verdict: run.outcome.kind === 'exit' ? 'red' : 'infra_error',
        results,
        stoppedAtRank: rank,
      };
    }
  }
  return { verdict: 'green', results };
}

/** Le prédicat « vert » : une sortie propre à code 0 — jamais `exitCode === null`. */
export function isGreen(outcome: CommandOutcome): boolean {
  return outcome.kind === 'exit' && outcome.exitCode === 0;
}
