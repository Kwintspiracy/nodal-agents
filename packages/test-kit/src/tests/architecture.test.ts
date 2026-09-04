// architecture.test.ts — les scanners d'invariants, prouvés sur des arbres
// temporaires plutôt que sur le dépôt (un scanner qui passe parce que le code
// est propre ne prouve pas qu'il détecte).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  scanForAgentSlugs,
  scanForUserFacingStrings,
  scanForDbDriverImports,
  formatViolations,
  scanForProjectKeyCopies,
  scanForMutatingSpawnOutsideIntent,
} from '../index';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'archi-'));
  mkdirSync(join(dir, 'nested'), { recursive: true });
  mkdirSync(join(dir, 'tests'), { recursive: true });

  writeFileSync(join(dir, 'clean.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(dir, 'nested', 'slug.ts'),
    '// route vers tatooine quand dispo\nexport const y = 2;\n',
  );
  writeFileSync(join(dir, 'nested', 'prose.ts'), 'const m = "Sorry, I cannot do that";\n');
  writeFileSync(join(dir, 'driver.ts'), "import pg from 'pg';\n");
  // Un fixture de test cite légitimement un agent — ne doit PAS déclencher.
  writeFileSync(join(dir, 'tests', 'fixture.ts'), 'export const agent = "sherlock";\n');
  // Une copie de la règle d'identité de chemin (lettre de lecteur + slash) —
  // DOIT déclencher, quelle que soit la casse de la classe.
  writeFileSync(
    join(dir, 'nested', 'key-copy.ts'),
    "const isWin = (p: string) => /^[A-Za-z]:\\//i.test(p) || p.startsWith('//');\n",
  );
  // Un test de racine de disque (`[a-z]:$`) n'est PAS une copie de la règle —
  // ne doit pas déclencher.
  writeFileSync(
    join(dir, 'drive-root.ts'),
    'export const root = (s: string) => /^[a-z]:$/i.test(s);\n',
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('scanForAgentSlugs', () => {
  it('détecte un slug, y compris dans un commentaire', () => {
    const v = scanForAgentSlugs({ srcDir: dir });
    expect(v.some((x) => x.rule === 'slug:tatooine')).toBe(true);
  });

  it('ignore le répertoire tests — un fixture nomme légitimement un agent', () => {
    const v = scanForAgentSlugs({ srcDir: dir });
    expect(v.some((x) => x.file.includes('fixture'))).toBe(false);
  });

  it('ne déclenche pas sur un fichier propre', () => {
    const v = scanForAgentSlugs({ srcDir: dir });
    expect(v.some((x) => x.file.endsWith('clean.ts'))).toBe(false);
  });
});

describe('scanForUserFacingStrings', () => {
  it('détecte une phrase mise dans la bouche de l’agent', () => {
    const v = scanForUserFacingStrings({ srcDir: dir });
    expect(v.some((x) => x.file.includes('prose'))).toBe(true);
  });
});

describe('scanForDbDriverImports', () => {
  it('détecte un import de driver hors packages/db', () => {
    const v = scanForDbDriverImports({ srcDir: dir });
    expect(v).toHaveLength(1);
    expect(v[0]?.rule).toBe('db-driver-import');
  });
});

describe('formatViolations', () => {
  it('nomme fichier, ligne et règle — un message actionnable', () => {
    const text = formatViolations('Invariant 1', scanForAgentSlugs({ srcDir: dir }));
    expect(text).toContain('Invariant 1');
    expect(text).toMatch(/slug\.ts:\d+/);
    expect(text).toContain('slug:tatooine');
  });
});

describe('scanForMutatingSpawnOutsideIntent', () => {
  // Arbre à part : cette règle veut des fixtures qui écrivent sur le disque,
  // et les mélanger à celles des autres scanners rendrait leurs comptes exacts
  // (`toHaveLength(1)`) dépendants d'un fichier ajouté pour une autre raison.
  let tree: string;

  beforeAll(() => {
    tree = mkdtempSync(join(tmpdir(), 'archi-spawn-'));
    for (const sub of ['engine', 'bad', 'allowed', 'runtime', 'tests']) {
      mkdirSync(join(tree, sub), { recursive: true });
    }
    // Propre : aucune façon de lancer un enfant.
    writeFileSync(join(tree, 'engine', 'pure.ts'), 'export const pur = (n: number) => n + 1;\n');
    // Fautive : un lanceur recopié à côté du seam d'intention.
    writeFileSync(join(tree, 'bad', 'inline.ts'), "const child = spawn('git', ['status']);\n");
    // Le lanceur légitime, celui que le package héberge et passe en skipFiles.
    writeFileSync(join(tree, 'allowed', 'process.ts'), 'const child = spawn(cli, args);\n');
    // L'autre empreinte, pour prouver que le motif passé est bien celui utilisé.
    writeFileSync(
      join(tree, 'runtime', 'other.ts'),
      'const turn = await binding.run({ prompt });\n',
    );
    // Un test cite légitimement un lanceur — ne doit PAS déclencher.
    writeFileSync(join(tree, 'tests', 'fixture.ts'), "const child = spawn('git', []);\n");
  });

  afterAll(() => rmSync(tree, { recursive: true, force: true }));

  it('détecte un lanceur hors des fichiers épargnés', () => {
    const v = scanForMutatingSpawnOutsideIntent(
      { srcDir: tree, skipFiles: ['allowed/process.ts'] },
      /\bspawn\(/,
    );
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toContain('inline.ts');
    expect(v[0]?.rule).toBe('mutating-spawn-outside-intent');
  });

  it('c’est bien le skipFile qui épargne, pas la chance', () => {
    // Le contrôle du test précédent : sans la liste, le lanceur légitime
    // remonte lui aussi. Un `skipFiles` qui ne servirait à rien passerait
    // sinon inaperçu.
    const v = scanForMutatingSpawnOutsideIntent({ srcDir: tree }, /\bspawn\(/);
    expect(v.map((x) => x.file.split('\\').join('/').split('/').pop()).sort()).toEqual([
      'inline.ts',
      'process.ts',
    ]);
  });

  it('ignore le répertoire tests', () => {
    const v = scanForMutatingSpawnOutsideIntent({ srcDir: tree }, /\bspawn\(/);
    expect(v.some((x) => x.file.includes('fixture'))).toBe(false);
  });

  it('cherche le motif qu’on lui passe, jamais un motif figé', () => {
    const v = scanForMutatingSpawnOutsideIntent({ srcDir: tree }, /binding\.run\(/);
    expect(v).toHaveLength(1);
    expect(v[0]?.file).toContain('other.ts');
  });
});

describe('scanForProjectKeyCopies', () => {
  it('détecte une copie de la règle « lettre de lecteur ⇒ casse repliée »', () => {
    const v = scanForProjectKeyCopies({ srcDir: dir });
    expect(v.map((x) => x.rule)).toEqual(['project-key-copy']);
    expect(v[0]?.file).toContain('key-copy.ts');
  });

  it('laisse passer un test de racine de disque, qui n’est pas une identité', () => {
    const v = scanForProjectKeyCopies({ srcDir: dir });
    expect(v.some((x) => x.file.includes('drive-root'))).toBe(false);
  });

  it('épargne le fichier qui héberge la règle quand il est passé en skipFiles', () => {
    const v = scanForProjectKeyCopies({ srcDir: dir, skipFiles: ['nested/key-copy.ts'] });
    expect(v).toEqual([]);
  });
});
