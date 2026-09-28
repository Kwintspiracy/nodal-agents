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
   * Le Stop de la personne (#456) : déclenché, il tue l'arbre de processus
   * comme l'expiration le fait, sans attendre le délai. Le tour se termine
   * sur l'issue du processus tué ; c'est l'appelant qui sait que c'était un Stop.
   */
  abortSignal?: AbortSignal;
  /**
   * Garde anti-boucle (invariant #8) : au-delà de ce nombre d'appels d'outils
   * dans un tour, la CLI est tuée. Le compteur du loop Nodal ne voit pas la
   * boucle INTERNE d'une CLI ; c'est son équivalent à cette couture.
   *
   * Ce qu'il garantit, et ce qu'il ne garantit pas (revue Codex de #568). La
   * boucle Nodal refuse un tour trop gros ENTIER, avant d'en exécuter un seul
   * appel (#564), parce qu'elle connaît sa taille dès la réponse. Ici, non :
   * la CLI exécute ses outils dans son propre processus, le runner ne voit
   * chaque appel qu'au moment où le flux l'annonce, et le total n'existe
   * jamais d'avance. Donc :
   *   - les appels sous le budget ont TOUS pu s'exécuter, mutations comprises ;
   *   - l'arbre est tué sur la ligne qui OUVRE l'appel au-delà du budget
   *     (`tool_use` chez Claude, `item.started` chez Codex). Cet appel n'est
   *     jamais remis à l'appelant, ni son ouverture ni son résultat, et après
   *     cette ligne rien de NOUVEAU ne l'est (aucune ouverture, aucune fin de
   *     tour) ; seuls passent encore les résultats des appels ADMIS, ouverts
   *     avant et finis après, pour que l'audit garde leur ligne (revue Codex de
   *     #568, passes 2 et 3 ; voir `ToolCallGate`) ;
   *   - cet appel-là a pu COMMENCER : la CLI l'exécute dès qu'elle l'annonce,
   *     et le kill arrive après la ligne. Un `file_change` Codex n'a même pas
   *     de ligne d'ouverture : il n'est compté qu'une fois appliqué.
   * Empêcher vraiment le 51e appel demanderait un point d'arrêt DANS chaque
   * CLI, avant chaque outil : les deux binaires installés ont des hooks
   * (`--settings` chez Claude 2.1.283, `--dangerously-bypass-hook-trust` chez
   * codex-cli 0.153.4), mais qu'un hook Codex puisse refuser un outil avant
   * son exécution n'est pas vérifié. Tant que ça ne l'est pas pour les deux,
   * ce garde reste la règle commune.
   */
  maxToolCalls?: number;
  /**
   * Une ligne complète de stdout. Le parseur appelle `gate.admit()` pour
   * CHAQUE appel d'outil que la ligne ouvre, dans l'ordre du flux : c'est ce
   * qui alimente le compteur ci-dessus, et la réponse dit si l'appel est
   * admis. Voir `ToolCallGate` pour ce que le parseur remet ensuite.
   *
   * Un appel par appel, pas un par ligne (revue Codex, 27/08). Claude groupe
   * ses appels PARALLÈLES dans un seul événement de flux : compter la ligne
   * écrasait six appels simultanés en un seul.
   */
  onLine: (line: string, gate: ToolCallGate) => void;
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

/**
 * Le budget d'appels vu par un parseur de flux (invariant #8).
 *
 * Un appel est ADMIS quand il tient dans le budget ; au-delà, le parseur ne
 * le remet jamais à l'appelant. Une fois le budget dépassé (`capped`, à partir
 * de la ligne qui suit), le parseur ne remet plus que les résultats des appels
 * admis : ouverts avant le cap, ils ont pu agir, et l'audit n'écrit sa ligne
 * qu'au résultat (revue Codex de #568, passe 3). Tout le reste (ouvertures,
 * texte, fin de tour) n'est plus lu.
 */
export interface ToolCallGate {
  /** Un appel que la ligne ouvre : vrai s'il tient dans le budget. */
  admit(): boolean;
  /** Le budget a tiré sur une ligne précédente. */
  readonly capped: boolean;
}

/** La porte d'un parseur appelé hors d'un tour borné : tout est admis. */
export const OPEN_GATE: ToolCallGate = { admit: () => true, capped: false };

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

    // Le kill est asynchrone : après le cap, les lignes déjà reçues (le même
    // paquet, ce qui arrive pendant le taskkill) passent encore par le
    // parseur, qui n'en remet que les résultats des appels admis.
    const gate: ToolCallGate = {
      admit: () => {
        toolCalls += 1;
        return opts.maxToolCalls === undefined || toolCalls <= opts.maxToolCalls;
      },
      get capped() {
        return toolCapExceeded !== undefined;
      },
    };

    const consume = (line: string): void => {
      try {
        opts.onLine(line, gate);
      } catch (err) {
        console.warn('[cli-runtime] stream line handling failed:', err);
      }
      if (
        toolCapExceeded === undefined &&
        opts.maxToolCalls !== undefined &&
        toolCalls > opts.maxToolCalls
      ) {
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
      opts.abortSignal?.removeEventListener('abort', onStop);
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

    // Stop : le même geste que l'expiration, tout de suite.
    const onStop = (): void => {
      if (settled) return;
      killTree();
      graceTimer ??= setTimeout(() => finish(null), KILL_GRACE_MS);
    };
    if (opts.abortSignal?.aborted) onStop();
    else opts.abortSignal?.addEventListener('abort', onStop, { once: true });

    child.on('error', (err: Error) => {
      stderr += `\nspawn_error: ${err.message}`;
      finish(null);
    });
    child.on('close', (code: number | null) => finish(code));
  });
}
