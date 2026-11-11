// wait-for-file.ts — attendre qu'un fichier apparaisse, et le DIRE quand il ne
// vient pas (#1042).
//
// Les tests de processus attendent un fichier qu'un enfant écrit (son pid, un
// signal « prêt »). Ils l'attendaient avec `for (i < 400 && !existsSync(f))`,
// qui RENVOIE sans rien dire quand la boucle s'épuise : le test lisait alors un
// fichier absent, et l'erreur rapportée (`ENOENT … server-<job>.pid`, CI Windows)
// cachait le vrai fait : l'enfant n'avait pas écrit son fichier dans le temps
// imparti, soit qu'il fût lent, soit qu'il n'eût jamais démarré. Le journal ne
// permettait pas de savoir lequel (invariant #4 : un helper de test échoue fort
// lui aussi).
//
// Deux fins, et une seule est un succès :
//   - le fichier existe : on rend le temps attendu ;
//   - sinon on LÈVE, en disant le fichier, le temps attendu et POURQUOI l'attente
//     s'arrête : le délai est écoulé, ou le processus qui devait l'écrire a fini
//     avant (`settled`) — auquel cas il est inutile d'attendre davantage : le
//     fichier ne viendra plus, et l'attente ne dépend alors d'aucune horloge.
//
// `explain` ajoute à l'erreur ce que le test sait de l'échec (le tool_result de
// la commande qui devait démarrer le serveur, par exemple).

import { existsSync } from 'node:fs';

export interface WaitForFileOptions {
  /** Au plus combien de temps attendre. Il borne aussi le message : mettre moins que le délai du test. */
  timeoutMs: number;
  /**
   * La promesse de ce qui doit écrire le fichier (le job, le processus). Si elle
   * se termine, résolue ou rejetée, avant le fichier, l'attente s'arrête aussitôt.
   */
  settled?: Promise<unknown>;
  /** Ce que le test sait de l'échec, ajouté au message. Appelé seulement quand on lève. */
  explain?: () => string | Promise<string>;
  /** Intervalle de relecture, en ms. */
  pollMs?: number;
}

/** Attend que `file` existe ; lève, en le disant, s'il n'est pas apparu. Rend le temps attendu, en ms. */
export async function waitForFile(file: string, opts: WaitForFileOptions): Promise<number> {
  const started = Date.now();
  const pollMs = opts.pollMs ?? 50;
  let ended: string | null = null;
  void opts.settled?.then(
    () => {
      ended = 'resolved';
    },
    (e: unknown) => {
      ended = `rejected: ${e instanceof Error ? e.message : String(e)}`;
    },
  );
  for (;;) {
    if (existsSync(file)) return Date.now() - started;
    const waited = Date.now() - started;
    if (ended !== null || waited >= opts.timeoutMs) {
      const why =
        ended !== null
          ? `the process that should write it ended first (${ended})`
          : `the ${String(opts.timeoutMs)} ms limit passed`;
      const more = opts.explain === undefined ? '' : `\n${await opts.explain()}`;
      throw new Error(`${file} did not appear after ${String(waited)} ms: ${why}.${more}`);
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
