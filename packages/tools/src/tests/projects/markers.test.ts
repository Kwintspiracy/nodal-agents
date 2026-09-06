// markers.test.ts — les gestes de disque de la règle d'appartenance (P5b).
//
// `realPathOf` compare, il ne nomme pas : ce qu'il doit garantir, c'est qu'un
// chemin sous un alias (forme courte 8.3, jonction) tombe sous la même racine
// réelle que la racine attachée — y compris quand sa feuille n'existe PLUS
// (un fichier écrit puis supprimé dans le tour, revue Codex passe 33).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath } from '@nodal-agents/shared';
import { hasMarker, realPathOf } from '../../projects/markers';

let brut = '';
let reel = '';

beforeEach(async () => {
  // `brut` est ce que `tmpdir()` rend — sur un runner Windows, la forme courte
  // (`RUNNER~1`) ; `reel` la forme longue. Sur une machine sans alias, les deux
  // sont égaux et le test prouve seulement l'ancêtre existant.
  brut = normalizePath(await mkdtemp(join(tmpdir(), 'nodal-markers-')));
  reel = normalizePath(realpathSync.native(brut));
});

afterEach(async () => {
  try {
    await rm(brut, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

describe('realPathOf', () => {
  it('un chemin existant : sa forme réelle', async () => {
    await mkdir(`${brut}/app/src`, { recursive: true });
    await writeFile(`${brut}/app/src/a.ts`, '');
    expect(realPathOf(`${brut}/app/src/a.ts`)).toBe(`${reel}/app/src/a.ts`);
  });

  it('une feuille DISPARUE : l’ancêtre existant résolu, le reste rappendu', async () => {
    await mkdir(`${brut}/app/src`, { recursive: true });
    expect(realPathOf(`${brut}/app/src/gone.ts`)).toBe(`${reel}/app/src/gone.ts`);
    // Plusieurs segments absents : on remonte jusqu'à ce qui existe.
    expect(realPathOf(`${brut}/app/nope/deeper/gone.ts`)).toBe(`${reel}/app/nope/deeper/gone.ts`);
  });

  it('un `..` sous un ancêtre existant se résout comme le disque le fait', async () => {
    await mkdir(`${brut}/app/src`, { recursive: true });
    await mkdir(`${brut}/beta`, { recursive: true });
    expect(realPathOf(`${brut}/beta/../app/src/gone.ts`)).toBe(`${reel}/app/src/gone.ts`);
  });

  it('rien n’existe sur le chemin : rendu normalisé, tel quel', () => {
    const p = process.platform === 'win32' ? 'Q:/nulle/part/x.ts' : '/nulle/part/x.ts';
    expect(realPathOf(p)).toBe(p);
  });
});

describe('hasMarker', () => {
  it('lit le manifeste sur le disque, et rend faux sans lui', async () => {
    await mkdir(`${brut}/app`, { recursive: true });
    expect(hasMarker(`${brut}/app`)).toBe(false);
    await writeFile(`${brut}/app/package.json`, '{}');
    expect(hasMarker(`${brut}/app`)).toBe(true);
    expect(hasMarker(`${brut}/absent`)).toBe(false);
  });
});
