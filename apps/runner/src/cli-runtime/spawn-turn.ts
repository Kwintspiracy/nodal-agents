// cli-runtime/spawn-turn.ts — la MÉCANIQUE de processus d'un tour de runtime,
// partagée par les deux CLI.
//
// Elle vivait entière dans `claude-turn.ts`. Quand le runtime Codex est arrivé
// (27/08), il fallait choisir : la recopier, ou la sortir. Recopiée, elle aurait
// dérivé — c'est déjà arrivé sur cette base avec les deux dérivations de projets,
// où deux vues du même fait ont fini par se contredire sans que rien ne le
// montre. Ici, l'écart aurait porté sur l'arbre de processus tué sous Windows et
// sur le garde anti-boucle : deux choses qu'on ne veut pas voir diverger.
//
// Ce que ce fichier connaît : lancer, écrire le message sur stdin puis le
// FERMER, découper stdout en lignes, compter les appels d'outils, tuer l'arbre,
// et rendre la main. Ce qu'il ne connaît pas : ce que les lignes veulent dire.
// C'est l'appelant qui parse — un CLI, un parseur.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export interface SpawnTurnOptions<TResult> {
  /** argv complet, binaire en tête (sortie de `buildSpawnArgv`). */
  argv: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Écrit sur stdin puis fermé — le texte libre n'entre JAMAIS dans argv. */
  stdin: string;
  timeoutMs: number;
  /**
   * Garde anti-boucle (invariant #8) : au-delà de ce nombre d'appels d'outils
   * dans un tour, la CLI est tuée. Le compteur du loop Nodal ne voit pas la
   * boucle INTERNE d'une CLI ; c'est son équivalent à cette couture.
   */
  maxToolCalls?: number;
  /**
   * Une ligne complète de stdout. Rend le NOMBRE d'appels d'outils qu'elle
   * ouvre — c'est ce qui alimente le compteur ci-dessus.
   *
   * Un nombre, pas un booléen (revue Codex, 27/08). Claude groupe ses appels
   * PARALLÈLES dans un seul événement de flux : la première version rendait
   * `true` pour la ligne entière, donc six appels simultanés n'en comptaient
   * qu'un. Un tour pouvait dépasser largement le plafond de l'invariant #8
   * sans jamais être tué — et plus il paralléllise, moins il compte.
   */
  onLine: (line: string) => number;
  /** Réduit l'issue du processus en résultat de tour. */
  finish: (outcome: {
    exitCode: number | null;
    timedOut: boolean;
    durationMs: number;
    stderr: string;
    /** La valeur du plafond quand le garde a tiré, sinon undefined. */
    toolCapExceeded?: number;
  }) => TResult;
}

/** Délai laissé au processus tué pour mourir avant qu'on conclue sans lui. */
const KILL_GRACE_MS = 3000;
/** Au-delà, stderr n'est plus accumulé : on veut un extrait, pas un journal. */
const STDERR_CAP = 50_000;

export function spawnCliTurn<TResult>(opts: SpawnTurnOptions<TResult>): Promise<TResult> {
  const [command, ...rest] = opts.argv;
  const isWindows = process.platform === 'win32';
  const startedAt = Date.now();

  return new Promise<TResult>((resolve) => {
    const child = spawn(command as string, rest, {
      cwd: opts.cwd,
      shell: false,
      detached: !isWindows,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: opts.env,
    });

    // Le message est écrit puis FERMÉ — un stdin branché mais laissé ouvert fait
    // attendre la CLI indéfiniment (étape-A, constat 1). EPIPE (l'enfant est
    // mort avant) n'est pas notre échec.
    child.stdin?.on('error', () => {});
    child.stdin?.end(opts.stdin);

    let stdoutBuffer = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let toolCalls = 0;
    let toolCapExceeded: number | undefined;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // Un décodeur par flux : les frontières de morceaux ne tombent pas sur les
    // frontières de caractères UTF-8, et un toString() par morceau abîme les
    // caractères coupés en deux.
    const outDecoder = new StringDecoder('utf8');
    const errDecoder = new StringDecoder('utf8');

    const consume = (line: string): void => {
      let opened = 0;
      try {
        opened = opts.onLine(line);
      } catch (err) {
        console.warn('[cli-runtime] stream line handling failed:', err);
        return;
      }
      if (opened <= 0 || opts.maxToolCalls === undefined || toolCapExceeded !== undefined) return;
      toolCalls += opened;
      if (toolCalls > opts.maxToolCalls) {
        toolCapExceeded = opts.maxToolCalls;
        killTree();
        graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
      }
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += outDecoder.write(chunk);
      let nl: number;
      while ((nl = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        consume(line);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < STDERR_CAP) stderr += errDecoder.write(chunk);
    });

    const killTree = (): void => {
      if (child.pid) {
        if (isWindows) {
          // taskkill /T résout l'arbre depuis un instantané vivant — tuer le
          // parent d'abord orpheline les enfants. taskkill seul (il tue aussi la
          // racine) ; child.kill uniquement si taskkill a échoué.
          try {
            const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true,
            });
            tk.on('close', (code) => {
              if (code !== 0) {
                try {
                  child.kill('SIGKILL');
                } catch {
                  /* déjà mort */
                }
              }
            });
            tk.on('error', () => {
              try {
                child.kill('SIGKILL');
              } catch {
                /* déjà mort */
              }
            });
            return;
          } catch {
            /* taskkill indisponible — on continue */
          }
        } else {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            /* déjà mort */
          }
        }
      }
      try {
        child.kill('SIGKILL');
      } catch {
        /* déjà mort */
      }
    };

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      // Vider une dernière ligne non terminée : la ligne de résultat finit
      // d'ordinaire par \n, mais on ne le suppose jamais.
      if (stdoutBuffer.trim() !== '') consume(stdoutBuffer);
      resolve(
        opts.finish({
          exitCode,
          timedOut,
          durationMs: Date.now() - startedAt,
          stderr,
          ...(toolCapExceeded !== undefined ? { toolCapExceeded } : {}),
        }),
      );
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      graceTimer = setTimeout(() => finish(null), KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.on('error', (err: Error) => {
      stderr += `\nspawn_error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}
