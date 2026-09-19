// git-constat.test.ts — CE QUE GIT VOIT D'UN RUN, prouvé sur un VRAI dépôt.
//
// Issue #199. Le dépôt est créé par le test, dans un dossier temporaire, avec
// son propre `git init` : jamais le dépôt du projet — un test qui lit
// `git status` de NodalAI dirait quelque chose de différent à chaque exécution,
// et écrirait dans l'arbre de travail de qui le lance.
//
// Ce que ces cas prouvent, un par un :
//   — le delta liste EXACTEMENT les fichiers écrits, avec leur genre ;
//   — un fichier ignoré (`node_modules/`) n'y est pas ;
//   — un fichier DÉJÀ modifié avant le run et modifié encore pendant y est,
//     ce que le seul code de statut ne pouvait pas voir ;
//   — une RESTAURATION (`git checkout --`) est une écriture, bien qu'elle
//     vide la ligne de statut, et un `git commit` n'en est pas une ;
//   — un dossier qui n'est pas un dépôt ne rend aucune racine, donc le run
//     retombe sur le constat disque.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  constatedGitWrites,
  deltaConstat,
  kindOfStatus,
  parsePorcelainZ,
  repoRootOf,
  snapshotGitAvant,
  snapshotRepo,
} from '../verification/git-constat';

const run = promisify(execFile);

let racine = '';
let depot = '';
let horsDepot = '';

async function git(args: string[], cwd = depot): Promise<void> {
  await run('git', args, { cwd, windowsHide: true });
}

beforeAll(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-git-constat-'));
  depot = join(racine, 'projet');
  horsDepot = join(racine, 'sans-git');
  await mkdir(depot, { recursive: true });
  await mkdir(horsDepot, { recursive: true });
  await git(['init', '--initial-branch=main']);
  await git(['config', 'user.email', 'test@example.invalid']);
  await git(['config', 'user.name', 'Test']);
  // Un dépôt normal ignore ses dépendances ; c'est cette règle-là que le
  // constat hérite, et qu'un des cas ci-dessous vérifie.
  await writeFile(join(depot, '.gitignore'), 'node_modules/\ndist/\n');
  await writeFile(join(depot, 'garde.ts'), 'export const garde = 1;\n');
  await writeFile(join(depot, 'efface.ts'), 'export const efface = 1;\n');
  await git(['add', '.']);
  await git(['commit', '-m', 'depart']);
});

afterAll(async () => {
  await rm(racine, { recursive: true, force: true });
});

describe('le constat par git @cap:travailler-sur-des-fichiers/moteur', () => {
  it('liste EXACTEMENT les fichiers du run, avec leur genre', async () => {
    const avant = await snapshotGitAvant([depot]);
    expect(avant).toHaveLength(1);

    // Le « run » : deux fichiers écrits — un neuf, un existant — et un effacé.
    await writeFile(join(depot, 'neuf.ts'), 'export const neuf = 2;\n');
    await writeFile(join(depot, 'garde.ts'), 'export const garde = 42;\n');
    await unlink(join(depot, 'efface.ts'));

    const constat = await constatedGitWrites(avant);

    // Le CONTENU du constat, pas son cardinal : trois lignes, ces trois-là,
    // chacune sous son genre.
    const lignes = [...constat.writes]
      .map((w) => ({ nom: w.path.slice(w.path.lastIndexOf('/') + 1), kind: w.kind }))
      .sort((a, b) => a.nom.localeCompare(b.nom));
    expect(lignes).toEqual([
      { nom: 'efface.ts', kind: 'deleted' },
      { nom: 'garde.ts', kind: 'modified' },
      { nom: 'neuf.ts', kind: 'added' },
    ]);
    expect(constat.roots).toEqual([await repoRootOf(depot)]);

    // Remise en état pour les cas suivants.
    await writeFile(join(depot, 'efface.ts'), 'export const efface = 1;\n');
    await git(['checkout', '--', '.']);
    await rm(join(depot, 'neuf.ts'), { force: true });
  });

  it('un fichier ÉCRIT SOUS UN CHEMIN IGNORÉ n’est pas livré', async () => {
    const avant = await snapshotGitAvant([depot]);

    await mkdir(join(depot, 'node_modules', 'paquet'), { recursive: true });
    await writeFile(join(depot, 'node_modules', 'paquet', 'index.js'), 'module.exports = 1;\n');
    await writeFile(join(depot, 'vu.ts'), 'export const vu = 1;\n');

    const constat = await constatedGitWrites(avant);

    const noms = constat.writes.map((w) => w.path);
    expect(noms.some((p) => p.endsWith('/vu.ts'))).toBe(true);
    expect(noms.some((p) => p.includes('node_modules'))).toBe(false);

    await rm(join(depot, 'node_modules'), { recursive: true, force: true });
    await rm(join(depot, 'vu.ts'), { force: true });
  });

  it('un fichier DÉJÀ modifié avant le run, modifié encore pendant, est constaté', async () => {
    // Le cas que les seuls codes de statut ne voient pas : ` M` avant, ` M`
    // après. Seules les empreintes le distinguent.
    await writeFile(join(depot, 'garde.ts'), 'export const garde = 7;\n');
    const avant = await snapshotGitAvant([depot]);

    await writeFile(join(depot, 'garde.ts'), 'export const garde = 8;\n');
    const constat = await constatedGitWrites(avant);

    expect(constat.writes.map((w) => w.path.slice(w.path.lastIndexOf('/') + 1))).toEqual([
      'garde.ts',
    ]);

    await git(['checkout', '--', '.']);
  });

  it('une RESTAURATION pendant le run est une écriture, bien qu’elle vide le statut', async () => {
    // Le geste que le statut seul ne sait pas voir : `git checkout --` remet
    // le contenu d'avant et RETIRE la ligne. Sans relecture du disque, cette
    // écriture-là ne se voyait nulle part — un fichier rendu à son état
    // d'origine n'est pas un fichier qui n'a pas bougé.
    await writeFile(join(depot, 'garde.ts'), 'export const garde = 99;\n');
    const avant = await snapshotGitAvant([depot]);

    await git(['checkout', '--', 'garde.ts']);
    const constat = await constatedGitWrites(avant);

    expect(
      constat.writes.map((w) => ({ nom: w.path.slice(w.path.lastIndexOf('/') + 1), kind: w.kind })),
    ).toEqual([{ nom: 'garde.ts', kind: 'modified' }]);
  });

  it('un COMMIT pendant le run n’invente aucune écriture', async () => {
    // `git commit` vide `git status` sans toucher un octet du disque. Sans la
    // relecture du contenu, tout ce qu'il committe passerait pour écrit.
    await writeFile(join(depot, 'commite.ts'), 'export const c = 1;\n');
    await git(['add', 'commite.ts']);
    const avant = await snapshotGitAvant([depot]);

    await git(['commit', '-m', 'pendant le run']);
    const constat = await constatedGitWrites(avant);

    expect(constat.writes).toEqual([]);
  });

  it('un dossier SANS dépôt ne rend aucune racine — le run retombe sur le disque', async () => {
    // TROUVÉ PAR CE TEST, AU PREMIER PASSAGE. `git rev-parse --show-toplevel`
    // REMONTE : sur la machine qui l'a écrit, `C:/Users/<qui>` est elle-même un
    // dépôt, et ce dossier temporaire « sans git » s'en voyait attribuer la
    // racine. Le constat aurait porté sur tout le profil de la personne. La
    // racine n'est donc retenue que si elle tombe dans le périmètre du run.
    const avant = await snapshotGitAvant([horsDepot]);
    expect(avant).toEqual([]);

    await writeFile(join(horsDepot, 'ecrit.ts'), 'export const e = 1;\n');
    const constat = await constatedGitWrites(avant);
    expect(constat).toEqual({ writes: [], roots: [], indecis: [] });
  });

  it('un dépôt AU-DESSUS du périmètre du run n’est pas retenu', async () => {
    // Un sous-dossier d'un dépôt, donné SEUL : la racine est au-dessus de tout
    // ce que le run vise, donc elle n'est pas prise. Le même sous-dossier donné
    // AVEC sa racine, lui, est constaté — c'est le cas du `cwd` d'un shell.
    const sous = join(depot, 'coin');
    await mkdir(sous, { recursive: true });
    expect(await repoRootOf(sous)).toBe(await repoRootOf(depot));
    expect(await snapshotGitAvant([sous])).toEqual([]);
    expect(await snapshotGitAvant([sous, depot])).toHaveLength(1);
    await rm(sous, { recursive: true, force: true });
  });

  it('un dossier PROFOND rend la racine du dépôt, une seule fois', async () => {
    const sous = join(depot, 'src', 'a', 'b');
    await mkdir(sous, { recursive: true });
    const avant = await snapshotGitAvant([sous, depot]);
    expect(avant).toHaveLength(1);
    expect(avant[0]?.root).toBe(await repoRootOf(depot));
    await rm(join(depot, 'src'), { recursive: true, force: true });
  });
});

describe('la lecture de git status @cap:travailler-sur-des-fichiers/moteur', () => {
  it('lit un renommage avec son nom d’avant', () => {
    const lignes = parsePorcelainZ('R  apres.ts\0avant.ts\0 M autre.ts\0');
    expect(lignes).toEqual([
      { status: 'R ', path: 'apres.ts', renamedFrom: 'avant.ts' },
      { status: ' M', path: 'autre.ts' },
    ]);
  });

  it('lit un chemin à espaces sans le citer', () => {
    expect(parsePorcelainZ('?? mon dossier/mon fichier.ts\0')).toEqual([
      { status: '??', path: 'mon dossier/mon fichier.ts' },
    ]);
  });

  it('AD est une SUPPRESSION, pas un ajout', () => {
    expect(kindOfStatus('AD')).toBe('deleted');
    expect(kindOfStatus('A ')).toBe('added');
    expect(kindOfStatus('??')).toBe('added');
    expect(kindOfStatus('R ')).toBe('renamed');
    expect(kindOfStatus(' M')).toBe('modified');
    expect(kindOfStatus(' D')).toBe('deleted');
  });
});

describe('le delta lui-même @cap:travailler-sur-des-fichiers/moteur', () => {
  const empreinte = (sha: string) => ({ kind: 'file', size: 10n, sha256: sha }) as const;

  it('un git add ne compte pas : la lettre bouge, le contenu non', () => {
    const avant = {
      root: '/r',
      entries: new Map([['/r/a.ts', { status: '??', fingerprint: empreinte('aa') }]]),
    };
    const apres = {
      root: '/r',
      entries: new Map([['/r/a.ts', { status: 'A ', fingerprint: empreinte('aa') }]]),
    };
    expect(deltaConstat(avant, apres).writes).toEqual([]);
  });

  it('une empreinte illisible d’un côté n’est PAS créditée, elle est dite', () => {
    const avant = {
      root: '/r',
      entries: new Map([['/r/a.ts', { status: ' M', fingerprint: empreinte('aa') }]]),
    };
    const apres = {
      root: '/r',
      entries: new Map([
        ['/r/a.ts', { status: ' M', fingerprint: { kind: 'unreadable', size: null } as const }],
      ]),
    };
    const delta = deltaConstat(avant, apres);
    expect(delta.writes).toEqual([]);
    expect(delta.indecis).toEqual(['/r/a.ts']);
  });
});

describe('les bornes du constat @cap:travailler-sur-des-fichiers/moteur', () => {
  it('un arbre plus sale que la borne fait DÉCLINER le constat, il ne l’approxime pas', async () => {
    const sale = join(racine, 'tres-sale');
    await mkdir(sale, { recursive: true });
    await run('git', ['init', '--initial-branch=main'], { cwd: sale, windowsHide: true });
    // Une ligne de plus que la borne : mille et un fichiers non suivis.
    await Promise.all(
      Array.from({ length: 1001 }, (_, i) => writeFile(join(sale, `f${i}.txt`), `${i}\n`)),
    );
    expect(await snapshotRepo(sale)).toBeNull();
    await rm(sale, { recursive: true, force: true });
  });
});
