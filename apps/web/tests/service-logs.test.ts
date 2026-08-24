// @vitest-environment node
/**
 * service-logs.ts — lecture/effacement des logs de service, prouvés sur de
 * VRAIS fichiers (aucun mock du fs). La sécurité de la surface tient à deux
 * choses épinglées ici : les chemins sont dérivés d'un enum fermé (jamais du
 * client), et la lecture ne charge jamais plus que la fenêtre de tail.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readServiceLogTail, clearServiceLog, serviceLogPath } from '../src/lib/service-logs.ts';

const dir = mkdtempSync(join(tmpdir(), 'nodalai-svclogs-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('serviceLogPath', () => {
  it('dérive les chemins de l’enum, générations comprises', () => {
    expect(serviceLogPath('runner', 'current', dir)).toBe(join(dir, 'runner.log'));
    expect(serviceLogPath('web', 'archive', dir)).toBe(join(dir, 'web.log.1'));
  });
});

describe('readServiceLogTail', () => {
  it('fichier absent : exists=false, jamais d’erreur', () => {
    const r = readServiceLogTail('runner', 'current', dir);
    expect(r).toEqual({ exists: false, sizeBytes: 0, tail: '', truncated: false });
  });

  it('petit fichier : contenu intégral, non tronqué', () => {
    writeFileSync(join(dir, 'runner.log'), 'ligne 1\nligne 2\n');
    const r = readServiceLogTail('runner', 'current', dir);
    expect(r.exists).toBe(true);
    expect(r.tail).toBe('ligne 1\nligne 2\n');
    expect(r.truncated).toBe(false);
    expect(r.sizeBytes).toBe(16);
  });

  it('gros fichier : seule la FIN est lue, truncated=true, taille réelle annoncée', () => {
    const debut = 'DEBUT-QUI-NE-DOIT-PAS-APPARAITRE\n';
    const fin = 'FIN-VISIBLE\n';
    writeFileSync(join(dir, 'web.log'), debut + 'x'.repeat(5000) + fin);
    const r = readServiceLogTail('web', 'current', dir, 100);
    expect(r.truncated).toBe(true);
    expect(r.tail.endsWith(fin)).toBe(true);
    expect(r.tail).not.toContain('DEBUT');
    expect(r.tail.length).toBe(100);
    expect(r.sizeBytes).toBe(debut.length + 5000 + fin.length);
  });

  it('lit aussi l’archive .1', () => {
    writeFileSync(join(dir, 'web.log.1'), 'archive de rotation\n');
    const r = readServiceLogTail('web', 'archive', dir);
    expect(r.exists).toBe(true);
    expect(r.tail).toBe('archive de rotation\n');
  });
});

describe('clearServiceLog', () => {
  it('tronque le courant, supprime l’archive, annonce les octets libérés', () => {
    writeFileSync(join(dir, 'runner.log'), 'a'.repeat(300));
    writeFileSync(join(dir, 'runner.log.1'), 'b'.repeat(200));
    const { freedBytes } = clearServiceLog('runner', dir);
    expect(freedBytes).toBe(500);
    // Le courant existe toujours (le service tient son fd) mais est vide…
    expect(readFileSync(join(dir, 'runner.log'), 'utf8')).toBe('');
    // …l'archive est partie.
    expect(existsSync(join(dir, 'runner.log.1'))).toBe(false);
  });

  it('sans aucun fichier : 0 octet libéré, pas d’erreur', () => {
    const sous = mkdtempSync(join(tmpdir(), 'nodalai-svclogs-vide-'));
    try {
      expect(clearServiceLog('web', sous).freedBytes).toBe(0);
    } finally {
      rmSync(sous, { recursive: true, force: true });
    }
  });
});
