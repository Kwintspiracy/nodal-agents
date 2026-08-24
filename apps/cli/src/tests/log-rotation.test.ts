// log-rotation.test.ts — la rotation par taille, prouvée sur de VRAIS fichiers.
//
// Constat d'origine (24/08) : les logs de service ne tournaient jamais
// (59 Mo + 21 Mo en deux mois sur l'install de référence). Chaque assertion
// ici relit le disque — pas de mock du fs.

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rotateLogIfNeeded } from '../lib/log-rotation.ts';

const dir = mkdtempSync(join(tmpdir(), 'nodalai-logrot-'));
let logFile: string;
let n = 0;

beforeEach(() => {
  logFile = join(dir, `svc-${n++}.log`);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('rotateLogIfNeeded', () => {
  it('ne touche pas un fichier sous le plafond', () => {
    writeFileSync(logFile, 'petit log\n');
    const rotated = rotateLogIfNeeded(logFile, 1024);
    expect(rotated).toBe(false);
    expect(readFileSync(logFile, 'utf8')).toBe('petit log\n');
    expect(existsSync(`${logFile}.1`)).toBe(false);
  });

  it('ne fait rien quand le fichier n’existe pas encore (premier boot)', () => {
    expect(rotateLogIfNeeded(logFile, 1024)).toBe(false);
    expect(existsSync(logFile)).toBe(false);
  });

  it('archive en .1 au-delà du plafond — le contenu est PRÉSERVÉ, pas détruit', () => {
    const gros = 'x'.repeat(2048);
    writeFileSync(logFile, gros);
    const rotated = rotateLogIfNeeded(logFile, 1024);
    expect(rotated).toBe(true);
    // L'original a disparu (le prochain open 'a' repart à zéro)…
    expect(existsSync(logFile)).toBe(false);
    // …et l'archive porte l'intégralité du contenu.
    expect(readFileSync(`${logFile}.1`, 'utf8')).toBe(gros);
  });

  it('remplace l’archive précédente au lieu d’empiler des générations', () => {
    writeFileSync(`${logFile}.1`, 'vieille archive');
    writeFileSync(logFile, 'y'.repeat(2048));
    const rotated = rotateLogIfNeeded(logFile, 1024);
    expect(rotated).toBe(true);
    const archived = readFileSync(`${logFile}.1`, 'utf8');
    expect(archived).not.toBe('vieille archive');
    expect(statSync(`${logFile}.1`).size).toBe(2048);
  });

  it('pile au plafond : tourne (>= et non >)', () => {
    writeFileSync(logFile, 'z'.repeat(1024));
    expect(rotateLogIfNeeded(logFile, 1024)).toBe(true);
  });
});
