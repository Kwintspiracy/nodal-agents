// counter-process.ts — un processus de test qui prouve qu'il VIT en comptant,
// et la lecture de son compteur (#834).
//
// Les tests de durée de vie des processus (job-owns-processes, process-scopes)
// lancent un démon qui réécrit un compteur toutes les 100 ms, puis vérifient
// qu'il monte : vivant ET au travail, pas seulement présent. Ils le
// vérifiaient sur une fenêtre FIXE (400 ou 500 ms). Sur la CI Windows (turbo
// lance trois paquets à la fois sur quatre cœurs), la vérification a rougi une
// fois : « expected 1 to be greater than 1 » (run 39742684349). Le démon avait
// écrit 1, puis plus rien pendant 400 ms, et rien ne disait pourquoi.
//
// Une fenêtre fixe ne prouve rien de plus qu'une attente bornée : un démon
// mort ne compte plus jamais, qu'on attende 400 ms ou 10 s. Elle ajoute
// seulement une dépendance à la vitesse de la machine. D'où `counterRise`, qui
// attend la hausse, bornée, et rend sa raison quand elle ne vient pas :
//   - le démon vit, mais n'a pas compté pendant toute l'attente ;
//   - il s'est planté lui-même : sa trace est dans `<compteur>.crash`, que
//     `COUNTER_DAEMON_SOURCE` écrit avant de sortir ;
//   - il est mort sans trace : tué du dehors.
// Le jour où l'échec revient, le message dit lequel.
//
// Un compteur n'est jamais VIDE (#843, run 39781190881) : `writeFileSync` vide
// le fichier avant d'y écrire, et un démon tué entre les deux — la fermeture du
// périmètre le tue, c'est le test — laisse un fichier vide pour toujours. Les
// tests qui relisent le compteur APRÈS la mort du démon (« le compteur cesse de
// monter ») levaient « no number in … » : la relecture bornée de `readCounter`
// attend un écrivain qui n'existe plus. Le démon écrit donc ailleurs puis
// RENOMME sur le compteur : le fichier du compteur a toujours une valeur entière
// complète, quel que soit l'instant de la mort.

import { readFileSync } from 'node:fs';
import type { ProcessWatch } from './process-watch';

/** Ce que le démon de comptage écrit avant de sortir sur une exception. */
export const crashRecordOf = (counter: string): string => `${counter}.crash`;

/**
 * Les erreurs d'un fichier qu'un autre processus tient un instant (un
 * antivirus, un lecteur) : sous Windows, renommer sur un fichier ouvert sans
 * partage de suppression, ou l'ouvrir pendant qu'il est remplacé, les rend.
 * Elles passent ; toute autre erreur est une vraie erreur.
 */
const TRANSIENT_FILE_ERRORS = ['EPERM', 'EBUSY', 'EACCES'];

/**
 * Le démon : `node <script> <compteur> [<fichier du pid> [<période en ms>]]`. Il
 * écrit son pid, puis un compteur qui monte toutes les 100 ms (la période, si
 * elle est donnée). Chaque valeur est écrite dans `<compteur>.next` puis
 * RENOMMÉE sur le compteur : celui-ci n'est jamais vide, même si le démon est
 * tué en pleine écriture. Un renommage que le système refuse un instant
 * (EPERM/EBUSY/EACCES), ou une écriture refusée de même, est retenté à la période suivante, sans compter : le
 * compteur ne monte que de ce qui est écrit. Toute autre exception est écrite
 * dans `<compteur>.crash` avant qu'il sorte : sans elle, un démon qui se plante
 * ne se distinguerait pas d'un démon tué.
 */
export const COUNTER_DAEMON_SOURCE = [
  "const fs = require('fs');",
  'const counter = process.argv[2];',
  'const pidFile = process.argv[3];',
  'const every = Number(process.argv[4]) || 100;',
  "const staging = counter + '.next';",
  `const transient = ${JSON.stringify(TRANSIENT_FILE_ERRORS)};`,
  "process.on('uncaughtException', (e) => {",
  "  try { fs.writeFileSync(counter + '.crash', String((e && e.stack) || e)); } catch {}",
  '  process.exit(70);',
  '});',
  'if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
  'let n = 0;',
  'setInterval(() => {',
  '  try {',
  '    fs.writeFileSync(staging, String(n + 1));',
  '    fs.renameSync(staging, counter);',
  '  } catch (e) {',
  '    if (transient.includes(e && e.code)) return;',
  '    throw e;',
  '  }',
  '  n += 1;',
  '}, every);',
  '',
].join('\n');

/**
 * Lit le nombre qu'un processus écrit dans `file`. Un fichier qu'un autre
 * processus tient un instant (EPERM/EBUSY/EACCES, sous Windows pendant le
 * remplacement du compteur) est relu : on relit, borné, jusqu'à un entier. Un
 * fichier qui ne contient pas d'entier à la fin de l'attente est une erreur
 * dite, avec ce qu'il contenait.
 */
export function readCounter(file: string): number {
  let seen = 'nothing read';
  for (let i = 0; i < 200; i++) {
    try {
      const text = readFileSync(file, 'utf8').trim();
      if (/^\d+$/.test(text)) return Number(text);
      seen = `content ${JSON.stringify(text)}`;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === undefined || !TRANSIENT_FILE_ERRORS.includes(code)) throw e;
      seen = `read refused (${code})`;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`no number in ${file} (${seen})`);
}

function crashOf(counter: string): string | null {
  try {
    return readFileSync(crashRecordOf(counter), 'utf8').trim();
  } catch {
    return null;
  }
}

export interface CounterRise {
  /** La dernière valeur lue : plus grande que `floor` quand le compteur a monté. */
  value: number;
  /** Vide quand il a monté ; sinon, ce qu'est devenu le démon. */
  why: string;
}

/** Ce qu'on attend au plus d'un démon qui compte toutes les 100 ms. */
export const COUNTER_RISE_TIMEOUT_MS = 10_000;

/**
 * Attend que le compteur `file` dépasse `floor`, au plus `timeoutMs`. Avec
 * `watch` (process-watch.ts : jamais trompé par un pid redonné), l'attente
 * s'arrête dès que le démon est mort : il ne comptera plus.
 * À passer à `expect(rise.value, rise.why).toBeGreaterThan(floor)`.
 */
export async function counterRise(
  file: string,
  floor: number,
  opts: { watch?: ProcessWatch; timeoutMs?: number } = {},
): Promise<CounterRise> {
  const timeoutMs = opts.timeoutMs ?? COUNTER_RISE_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    const dead = opts.watch !== undefined && !opts.watch.alive();
    // Lu APRÈS l'état du démon : une dernière écriture avant sa mort compte.
    const value = readCounter(file);
    if (value > floor) return { value, why: '' };
    const waited = Date.now() - started;
    if (dead || waited >= timeoutMs) {
      const crash = crashOf(file);
      const daemon =
        opts.watch === undefined ? 'the daemon' : `the daemon (pid ${String(opts.watch.pid)})`;
      const state =
        crash !== null
          ? `${daemon} crashed by itself: ${crash}`
          : opts.watch === undefined
            ? 'it is not watched'
            : dead
              ? `${daemon} is dead and left no crash record: it was killed from outside`
              : `${daemon} is alive but did not count`;
      return {
        value,
        why: `the counter stayed at ${String(value)} for ${String(waited)} ms; ${state}`,
      };
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}
