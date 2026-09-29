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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('review of PR #519', () => {
  let dossier;
  afterEach(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('une erreur eslint préfixée par turbo est nommée', () => {
    const ligne =
      "@nodal-agents/web:lint:   12:5  error  'y' is assigned a value but never used  no-unused-vars";
    expect(lignesDeLEchec(`@nodal-agents/web:lint: /repo/apps/web/src/a.ts\n${ligne}\n`)).toEqual([
      ligne,
    ]);
  });

  it('des erreurs écrites par des tests VERTS ne poussent pas hors du message la ligne du test rouge', () => {
    const bruit = Array.from(
      { length: 50 },
      (_, i) => `@nodal-agents/web:test: AssertionError: logged by a passing test ${i}`,
    );
    const rouge = '@nodal-agents/web:test:  FAIL  src/flaky.test.ts > the one that flakes';
    const lignes = lignesDeLEchec([...bruit, rouge].join('\n'), 40);
    expect(lignes[0]).toBe(rouge);
    expect(lignes).toHaveLength(41);
  });

  it('les codes couleur ne cachent pas une ligne FAIL et ne salissent pas le message', () => {
    const colore = '\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m src/a.test.ts > case';
    expect(lignesDeLEchec(colore)).toEqual([' FAIL  src/a.test.ts > case']);
  });

  it('un journal impossible à écrire ne remplace pas l’échec : le message le dit et garde le reste', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    // Un FICHIER là où le dossier des journaux devrait être : mkdir échoue.
    const pasUnDossier = join(dossier, 'occupe');
    writeFileSync(pasUnDossier, 'x');
    const { message } = rapportDEchec({
      commande: 'pnpm test',
      sortie: ' FAIL  src/a.test.ts > case\nFailed:    @nodal-agents/web#test',
      dossier: pasUnDossier,
    });
    expect(message).toContain('FAIL  src/a.test.ts > case');
    expect(message).toMatch(/full output could not be written to .*pnpm-test\.log: E[A-Z]+/);
  });
});

// Une VRAIE sortie de vitest 4.1.6, écrite dans un tube comme `release:check`
// la lit (pas de TTY, donc le reporter non interactif) : deux tests rouges, une
// assertion et une expiration. Seuls les chemins sont ramenés à `/repo`.
// Capturée le 28/09/2026 ; turbo préfixe chaque ligne par sa tâche.
const vitestReel = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'vitest-4-piped-failure.txt'),
  'utf8',
);
const sousTurbo = (sortie, tache) =>
  [
    ...sortie.split('\n').map((l) => `${tache}: ${l}`),
    ' Tasks:    33 successful, 34 total',
    'Failed:    @nodal-agents/web#test',
    ' ERROR  run failed: command  exited (1)',
  ].join('\n');

describe('un test rouge est suivi de sa CAUSE (#512, sortie réelle de vitest)', () => {
  let dossier;
  afterEach(() => {
    if (dossier) rmSync(dossier, { recursive: true, force: true });
  });

  it('chaque FAIL garde la ligne qui suit : l’assertion, et l’expiration qu’aucun motif ne reconnaît', () => {
    const lignes = lignesDeLEchec(sousTurbo(vitestReel, '@nodal-agents/web:test'));
    const p = '@nodal-agents/web:test: ';
    const assertion = lignes.indexOf(
      `${p} FAIL  |unit| src/components/Composer.test.tsx > Composer > keeps the draft when the send fails`,
    );
    expect(assertion).toBeGreaterThanOrEqual(0);
    expect(lignes[assertion + 1]).toBe(
      `${p}AssertionError: expected 'hello' to be '' // Object.is equality`,
    );
    const expiration = lignes.indexOf(
      `${p} FAIL  |unit| src/components/Composer.test.tsx > Composer > times out`,
    );
    expect(expiration).toBeGreaterThanOrEqual(0);
    expect(lignes[expiration + 1]).toBe(`${p}Error: Test timed out in 50ms.`);
    // Les deux lignes `×` du résumé par fichier, et aucune ligne vide de turbo.
    expect(lignes.filter((l) => l.includes(' × '))).toEqual([
      `${p}     × keeps the draft when the send fails 3ms`,
      `${p}     × times out 65ms`,
    ]);
    expect(lignes.some((l) => l.replace(/^\S+:\S+: ?/, '').trim() === '')).toBe(false);
  });

  it('sans turbo aussi (vitest lancé seul) : le test et sa cause, collés', () => {
    const lignes = lignesDeLEchec(vitestReel);
    const i = lignes.indexOf(
      ' FAIL  |unit| src/components/Composer.test.tsx > Composer > times out',
    );
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lignes[i + 1]).toBe('Error: Test timed out in 50ms.');
  });

  it('la flèche du reporter détaillé sous `×` est gardée avec lui', () => {
    const sortie = [
      '@nodal-agents/web:test:    × keeps the draft when the send fails 88ms',
      '@nodal-agents/web:test:      → expected "hello" to be "" // Object.is equality',
      '@nodal-agents/web:test:    ✓ passes 1ms',
    ].join('\n');
    expect(lignesDeLEchec(sortie)).toEqual([
      '@nodal-agents/web:test:    × keeps the draft when the send fails 88ms',
      '@nodal-agents/web:test:      → expected "hello" to be "" // Object.is equality',
    ]);
  });

  it('deux `×` qui se suivent : chacun garde SA cause, aucun ne passe pour celle de l’autre', () => {
    const sortie = [
      '@nodal-agents/web:test:    × first 3ms',
      '@nodal-agents/web:test:    × second 65ms',
      '@nodal-agents/web:test:      → Test timed out in 5000ms.',
    ].join('\n');
    expect(lignesDeLEchec(sortie)).toEqual([
      '@nodal-agents/web:test:    × first 3ms',
      '@nodal-agents/web:test:    × second 65ms',
      '@nodal-agents/web:test:      → Test timed out in 5000ms.',
    ]);
  });

  it('le message de release:check nomme le fichier, le test ET la cause, et le journal garde tout', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const sortie = sousTurbo(vitestReel, '@nodal-agents/web:test');
    const { message, fichier } = rapportDEchec({ commande: 'pnpm test', sortie, dossier });
    expect(message).toContain(
      ' FAIL  |unit| src/components/Composer.test.tsx > Composer > times out\n' +
        '    @nodal-agents/web:test: Error: Test timed out in 50ms.',
    );
    expect(message).toContain('Failed:    @nodal-agents/web#test');
    expect(message).toContain(`full output: ${fichier}`);
    // Le journal garde aussi ce que le message ne montre pas : le cadre du code.
    expect(readFileSync(fichier, 'utf8')).toContain("expect('hello').toBe('');");
  });

  it('une étape rouge dont la sortie ne nomme aucun test le dit et renvoie au journal', () => {
    dossier = mkdtempSync(join(tmpdir(), 'release-check-'));
    const { message, fichier } = rapportDEchec({
      commande: 'node scripts/smoke-pack.mjs',
      sortie: 'installing tarball\nbooting\nrunner did not answer on :3001 within 60s',
      dossier,
    });
    expect(message).toContain('no line names the failure; last lines:');
    expect(message).toContain('runner did not answer on :3001 within 60s');
    expect(message).toContain(`full output: ${fichier}`);
    expect(readFileSync(fichier, 'utf8')).toContain('installing tarball');
  });
});

// Revue Codex de #557 : la VOISINE d'un test rouge n'est pas sa cause, et la
// limite ne sépare jamais un test de sa cause.
describe('review of PR #557: only a cause is a cause, and a cause stays with its test', () => {
  it('a passing `✓` right after a `×` is not taken as its cause', () => {
    const lignes = lignesDeLEchec(['     × fails 3ms', '     ✓ passes 1ms', ''].join('\n'));
    expect(lignes).toEqual(['     × fails 3ms']);
  });

  it('a line from ANOTHER turbo task, interleaved, is not taken as the cause', () => {
    const sortie = [
      '@nodal-agents/web:test:  FAIL  |unit| src/a.test.ts > fails',
      '@nodal-agents/runner:test: Error: connect ECONNREFUSED 127.0.0.1:3001',
      '@nodal-agents/web:test: AssertionError: expected 1 to be 2',
    ].join('\n');
    const lignes = lignesDeLEchec(sortie);
    const i = lignes.indexOf('@nodal-agents/web:test:  FAIL  |unit| src/a.test.ts > fails');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lignes[i + 1]).not.toBe(
      '@nodal-agents/runner:test: Error: connect ECONNREFUSED 127.0.0.1:3001',
    );
    expect(lignes).not.toContain(
      '@nodal-agents/runner:test: Error: connect ECONNREFUSED 127.0.0.1:3001',
    );
  });

  it('the limit never keeps a test and drops its cause', () => {
    const resume = Array.from({ length: 39 }, (_, n) => `     × summary ${n} 1ms`);
    const sortie = [
      ...resume,
      '',
      ' FAIL  |unit| src/a.test.ts > times out',
      'Error: Test timed out in 50ms.',
    ].join('\n');
    const lignes = lignesDeLEchec(sortie, 40);
    const i = lignes.indexOf(' FAIL  |unit| src/a.test.ts > times out');
    // Either the pair is kept whole, or neither line is: never the name alone.
    if (i >= 0) expect(lignes[i + 1]).toBe('Error: Test timed out in 50ms.');
    else expect(lignes).not.toContain('Error: Test timed out in 50ms.');
    expect(lignes.at(-1)).toMatch(/more failure lines in the full log$/);
  });
});
