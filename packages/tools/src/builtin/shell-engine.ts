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
// garde le sien (protocole d'événements propre au CLI) — le dire ici plutôt que
// de laisser croire qu'il n'en reste qu'un.
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
//     `keep` explicite (tête ou queue).
// Changer l'un de ces points = bumper SHELL_POLICY_VERSION.
//
// Les messages de ce module sont des CODES techniques (invariant #2 : aucun
// texte utilisateur dans une couche que le runner exécute).

import { spawn, type ChildProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { VerifyCommandsSchema, type RunVerdict, type VerifyCommand } from '@nodal-agents/shared';

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

export interface CommandRunResult {
  outcome: CommandOutcome;
  stdout: string;
  stderr: string;
  truncatedStdout: boolean;
  truncatedStderr: boolean;
  durationMs: number;
  cwd: string;
}

/** Ce qu'on lance : une commande shell, ou un exécutable avec ses arguments. */
export type CommandTarget = { command: string } | { file: string; args: readonly string[] };

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
}

export interface CommandRunOptions {
  /** Injectable pour tester la forme d'invocation sans lancer de processus. */
  platform?: NodeJS.Platform;
}

/**
 * Tue tout l'arbre d'un processus enfant.
 *
 * Windows : `taskkill /T` résout l'arbre depuis un instantané VIVANT — tuer le
 * parent d'abord orphelinerait les enfants et taskkill ne trouverait plus
 * rien. Donc taskkill seul (il tue aussi la racine), et `child.kill` seulement
 * en repli si taskkill n'a pas pu démarrer ou a échoué. C'est exactement ce
 * que deux des trois copies faisaient à l'envers.
 *
 * Unix : le pid négatif vise le groupe créé par `detached:true`.
 */
export function killProcessTree(child: ChildProcess, platform: NodeJS.Platform): void {
  const isWindows = platform === 'win32';
  const backstop = (): void => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* déjà mort */
    }
  };
  if (!child.pid) {
    backstop();
    return;
  }
  if (isWindows) {
    try {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      tk.on('close', (code) => {
        if (code !== 0) backstop();
      });
      tk.on('error', backstop);
      return;
    } catch {
      backstop();
      return;
    }
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* déjà mort */
  }
  backstop();
}

/**
 * Lance une commande, capture sa sortie bornée, la tue au timeout, et rend une
 * issue typée. Ne lève JAMAIS pour une panne du processus (elle devient
 * `spawn_error`) ; lève pour un contrat violé par l'appelant (`ENV_REQUIRED`).
 */
export function runShellCommand(
  spec: CommandSpec,
  opts: CommandRunOptions = {},
): Promise<CommandRunResult> {
  if (spec.env === undefined || spec.env === null) {
    throw new Error('ENV_REQUIRED');
  }
  const platform = opts.platform ?? process.platform;
  const isWindows = platform === 'win32';
  const keep = spec.keep ?? 'head';
  const cap = spec.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS;
  const startedAt = Date.now();

  return new Promise<CommandRunResult>((resolve) => {
    const spawnOpts = {
      cwd: spec.cwd,
      detached: !isWindows,
      windowsHide: true,
      env: spec.env as unknown as NodeJS.ProcessEnv,
    };
    const child =
      'command' in spec.target
        ? spawn(spec.target.command, { ...spawnOpts, shell: true })
        : spawn(spec.target.file, [...spec.target.args], { ...spawnOpts, shell: false });

    const out = new StreamCapture(cap, keep);
    const err = new StreamCapture(cap, keep);
    // On continue de drainer le tuyau après le plafond : un enfant dont le
    // tuyau OS est plein se bloque, et le timeout le tuerait pour rien.
    child.stdout?.on('data', (c: Buffer) => out.push(c));
    child.stderr?.on('data', (c: Buffer) => err.push(c));

    let settled = false;
    let timedOut = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve({
        outcome,
        stdout: out.end(),
        stderr: err.end(),
        truncatedStdout: out.truncated,
        truncatedStderr: err.truncated,
        durationMs: Date.now() - startedAt,
        cwd: spec.cwd,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, platform);
      // Un petit-enfant têtu peut garder un tuyau ouvert après le kill : on
      // résout quand même, le kill a été émis.
      graceTimer = setTimeout(() => finish({ kind: 'timeout' }), KILL_GRACE_MS);
    }, spec.timeoutMs);

    child.on('error', (e: Error) => finish({ kind: 'spawn_error', message: e.message }));
    child.on('close', (code: number | null) => {
      if (timedOut) return finish({ kind: 'timeout' });
      // `code === null` sans timeout = tué par un signal externe : pas une
      // sortie propre, on le dit comme tel plutôt que d'inventer un code.
      finish(
        code === null
          ? { kind: 'spawn_error', message: 'KILLED_BY_SIGNAL' }
          : { kind: 'exit', exitCode: code },
      );
    });
  });
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
  platform?: NodeJS.Platform;
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
    const run = await runShellCommand(
      {
        target: { command: entry.command },
        cwd: opts.cwd,
        timeoutMs: entry.timeoutSeconds * 1000,
        env: opts.env,
        keep: opts.keep ?? 'tail',
        ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}),
      },
      opts.platform !== undefined ? { platform: opts.platform } : {},
    );
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
