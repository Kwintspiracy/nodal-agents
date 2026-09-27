// echec-de-commande.test.mjs — une commande en échec dit QUEL test a échoué.
//
// Pourquoi (#512) : `release:check` ne gardait que les 12 dernières lignes d'une
// commande en échec. Pour `pnpm test`, ce sont celles de turbo (« Failed:
// @nodal-agents/web#test »), jamais le nom du test. Pour la 0.9.3, la suite web
// est passée seule juste après et personne n'a pu nommer le test instable. Le
// défaut valait pour toutes les étapes (typecheck, lint, build, pack) : la
// règle est la même pour toutes.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lignesDeLEchec, rapportDEchec, lancerOuRapporter } from '../lib/echec-de-commande.mjs';

// La forme réelle d'une sortie turbo + vitest : chaque ligne préfixée par la tâche.
const sortieTurbo = [
  '@nodal-agents/web:test: ',
  '@nodal-agents/web:test:  RUN  v4.1.6 /repo/apps/web',
  '@nodal-agents/web:test:  ✓ src/lib/a.test.ts (4 tests) 12ms',
  '@nodal-agents/web:test:  ❯ src/components/Composer.test.tsx (9 tests | 1 failed) 812ms',
  '@nodal-agents/web:test:    × keeps the draft when the send fails 88ms',
  '@nodal-agents/web:test:      → expected "hello" to be "" // Object.is equality',
  '@nodal-agents/web:test:  FAIL  src/components/Composer.test.tsx > Composer > keeps the draft when the send fails',
  '@nodal-agents/web:test: AssertionError: expected "hello" to be "" // Object.is equality',
  ...Array.from({ length: 30 }, (_, i) => `@nodal-agents/web:test:  ✓ src/other-${i}.test.ts`),
  '@nodal-agents/web:test:  Test Files  1 failed | 220 passed (221)',
  '@nodal-agents/web:test:       Tests  1 failed | 2912 passed (2913)',
  ' Tasks:    33 successful, 34 total',
  'Cached:    20 cached, 34 total',
  '  Time:    6m12.004s',
  'Failed:    @nodal-agents/web#test',
  ' ERROR  run failed: command  exited (1)',
].join('\n');

describe('lignesDeLEchec', () => {
  it('garde les lignes qui NOMMENT l’échec, même préfixées par turbo et loin de la fin', () => {
    const lignes = lignesDeLEchec(sortieTurbo);
    expect(lignes).toContain(
      '@nodal-agents/web:test:    × keeps the draft when the send fails 88ms',
    );
    expect(lignes).toContain(
      '@nodal-agents/web:test:  FAIL  src/components/Composer.test.tsx > Composer > keeps the draft when the send fails',
    );
    expect(lignes).toContain(
      '@nodal-agents/web:test: AssertionError: expected "hello" to be "" // Object.is equality',
    );
    // Aucune ligne verte.
    expect(lignes.some((l) => l.includes('✓'))).toBe(false);
  });

  it('une erreur de typecheck ou de lint est nommée aussi', () => {
    const tsc = "apps/runner/src/job/execute.ts(3190,7): error TS2304: Cannot find name 'x'.";
    const eslint = "  12:5  error  'y' is assigned a value but never used  no-unused-vars";
    expect(lignesDeLEchec(`noise\n${tsc}\nmore noise\n${eslint}\n`)).toEqual([tsc, eslint]);
  });

  it('borne le nombre de lignes et dit combien il en a tu', () => {
    const beaucoup = Array.from({ length: 100 }, (_, i) => ` FAIL  t${i}.test.ts`).join('\n');
    const lignes = lignesDeLEchec(beaucoup, 40);
    expect(lignes).toHaveLength(41);
    expect(lignes.at(-1)).toBe('… 60 more failure lines in the full log');
  });
});

describe('rapportDEchec', () => {
  let dossier;
  afterEach(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('écrit la sortie ENTIÈRE dans un fichier et le message nomme le test, puis donne le chemin', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const { message, fichier } = rapportDEchec({
      commande: 'pnpm test',
      sortie: sortieTurbo,
      dossier,
    });
    expect(readFileSync(fichier, 'utf8')).toBe(sortieTurbo);
    expect(fichier).toBe(join(dossier, 'pnpm-test.log'));
    expect(message).toContain('`pnpm test` failed');
    expect(message).toContain('× keeps the draft when the send fails');
    expect(message).toContain('Failed:    @nodal-agents/web#test');
    expect(message).toContain(`full output: ${fichier}`);
  });

  it('une sortie sans ligne reconnue garde la fin, et le dit', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const { message } = rapportDEchec({
      commande: 'node scripts/build-pack.mjs',
      sortie: 'step 1\nstep 2\nkilled',
      dossier,
    });
    expect(message).toContain('no line names the failure; last lines:');
    expect(message).toContain('killed');
  });
});

describe('lancerOuRapporter — ce que release:check appelle pour chaque étape', () => {
  let dossier;
  afterEach(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('une vraie commande qui échoue : le message nomme le test, le fichier garde tout', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const script = join(dossier, 'faux-test.mjs');
    writeFileSync(
      script,
      "for (let i = 0; i < 50; i++) console.log(' ✓ ok ' + i);\n" +
        "console.log(' FAIL  src/flaky.test.ts > the one that flakes');\n" +
        "for (let i = 0; i < 50; i++) console.log(' ✓ after ' + i);\n" +
        "console.error('Failed:    @nodal-agents/web#test');\n" +
        'process.exit(1);\n',
    );
    let erreur;
    try {
      lancerOuRapporter(`node ${script}`, { cwd: dossier, dossier: join(dossier, 'logs') });
    } catch (e) {
      erreur = e;
    }
    expect(erreur).toBeInstanceOf(Error);
    // La ligne est au milieu : les 12 dernières lignes, seules, ne la montraient pas.
    expect(erreur.message).toContain('FAIL  src/flaky.test.ts > the one that flakes');
    expect(erreur.message).toContain('Failed:    @nodal-agents/web#test');
    const chemin = erreur.message.match(/full output: (.+)$/)[1];
    expect(readFileSync(chemin, 'utf8')).toContain(' ✓ after 49');
  });

  it('une commande qui réussit rend sa sortie et n’écrit rien', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const sortie = lancerOuRapporter('node -e "console.log(42)"', {
      cwd: dossier,
      dossier: join(dossier, 'logs'),
    });
    expect(sortie.trim()).toBe('42');
    expect(existsSync(join(dossier, 'logs'))).toBe(false);
  });

  it('une sortie qui dépasse le tampon est un échec qui le dit', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    expect(() =>
      lancerOuRapporter('node -e "process.stdout.write(\'x\'.repeat(5000))"', {
        cwd: dossier,
        dossier: join(dossier, 'logs'),
        maxBuffer: 100,
      }),
    ).toThrow(/ENOBUFS/);
  });
});
