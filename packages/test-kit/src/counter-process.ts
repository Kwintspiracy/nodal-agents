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

import { readFileSync } from 'node:fs';

/** Ce que le démon de comptage écrit avant de sortir sur une exception. */
export const crashRecordOf = (counter: string): string => `${counter}.crash`;

/**
 * Le démon : `node <script> <compteur> [<fichier du pid>]`. Il écrit son pid,
 * puis un compteur qui monte toutes les 100 ms. Une exception (une écriture
 * refusée) est écrite dans `<compteur>.crash` avant qu'il sorte : sans elle,
 * un démon qui se plante ne se distinguerait pas d'un démon tué.
 */
export const COUNTER_DAEMON_SOURCE = [
  "const fs = require('fs');",
  'const counter = process.argv[2];',
  'const pidFile = process.argv[3];',
  "process.on('uncaughtException', (e) => {",
  "  try { fs.writeFileSync(counter + '.crash', String((e && e.stack) || e)); } catch {}",
  '  process.exit(70);',
  '});',
  'if (pidFile) fs.writeFileSync(pidFile, String(process.pid));',
  'let n = 0;',
  'setInterval(() => fs.writeFileSync(counter, String(++n)), 100);',
  '',
].join('\n');

/**
 * Lit le nombre qu'un processus écrit dans `file`. `writeFileSync` vide le
 * fichier avant de l'écrire : une lecture qui tombe entre les deux lit `''`
 * (vu en CI Linux : « expected 0 to be greater than 1 »). On relit, borné,
 * jusqu'à un entier.
 */
export function readCounter(file: string): number {
  for (let i = 0; i < 200; i++) {
    const text = readFileSync(file, 'utf8').trim();
    if (/^\d+$/.test(text)) return Number(text);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  throw new Error(`no number in ${file}`);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
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
 * `pid`, l'attente s'arrête dès que le démon est mort : il ne comptera plus.
 * À passer à `expect(rise.value, rise.why).toBeGreaterThan(floor)`.
 */
export async function counterRise(
  file: string,
  floor: number,
  opts: { pid?: number; timeoutMs?: number } = {},
): Promise<CounterRise> {
  const timeoutMs = opts.timeoutMs ?? COUNTER_RISE_TIMEOUT_MS;
  const started = Date.now();
  for (;;) {
    const dead = opts.pid !== undefined && !alive(opts.pid);
    // Lu APRÈS l'état du démon : une dernière écriture avant sa mort compte.
    const value = readCounter(file);
    if (value > floor) return { value, why: '' };
    const waited = Date.now() - started;
    if (dead || waited >= timeoutMs) {
      const crash = crashOf(file);
      const daemon = opts.pid === undefined ? 'the daemon' : `the daemon (pid ${String(opts.pid)})`;
      const state =
        crash !== null
          ? `${daemon} crashed by itself: ${crash}`
          : opts.pid === undefined
            ? 'its pid is unknown'
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
