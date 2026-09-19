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
//     retombe sur le constat disque ;
//   — le périmètre du run se compare sur les chemins RÉELS, sans quoi une
//     forme courte 8.3 ou un lien faisait refuser le dépôt du run lui-même.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, mkdir, rm, stat, symlink, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath } from '@nodal-agents/shared';
import {
  constatedGitWrites,
  deltaConstat,
  kindOfStatus,
  parsePorcelainZ,
  perimetreGit,
  repoRootOf,
  resolveGitBinary,
  snapshotGitAvant,
  snapshotRepo,
  _resetGitBinaryCache,
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

async function estUnFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

/**
 * Un faux `git` VRAIMENT exécutable, posé dans le dossier du projet.
 *
 * Sous Windows il faut un `.exe` — un `.cmd` ne serait pas lancé par
 * `execFile` sans shell, donc ne prouverait rien. On recopie un petit
 * exécutable du système ; appelé avec les arguments de `git status` il sortira
 * en erreur, ce qui suffit : s'il était choisi, l'instantané serait nul.
 *
 * Rend `false` quand la machine ne permet pas d'en fabriquer un — le cas se
 * saute alors EN LE DISANT.
 */
async function poserUnFauxGit(chemin: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') {
      const source = join(process.env['SystemRoot'] ?? 'C:/Windows', 'System32', 'whoami.exe');
      if (!(await estUnFichier(source))) return false;
      await copyFile(source, chemin);
      return true;
    }
    await writeFile(chemin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    return true;
  } catch {
    return false;
  }
}

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

  it('un RENOMMAGE fait UNE ligne, pas un ajout plus une suppression', async () => {
    // Revue C de la PR #227, constat 4. Le nom d'avant n'a pas sa propre ligne
    // dans le statut d'après : il voyage dans celle du nom d'après. La
    // relecture du disque le prenait pour une ligne disparue, le trouvait
    // absent, et en faisait un `deleted` — le bloc Files montrait deux fois le
    // même déplacement, sous deux noms.
    //
    // Le fichier est modifié AVANT d'être renommé : c'est ce qui lui donne une
    // ligne dans le statut d'avant, donc ce qui déclenchait la relecture.
    await writeFile(join(depot, 'garde.ts'), 'export const garde = 5;\n');
    const avant = await snapshotGitAvant([depot]);

    await git(['mv', 'garde.ts', 'renomme.ts']);
    const constat = await constatedGitWrites(avant);

    expect(
      constat.writes.map((w) => ({ nom: w.path.slice(w.path.lastIndexOf('/') + 1), kind: w.kind })),
    ).toEqual([{ nom: 'renomme.ts', kind: 'renamed' }]);
    // Et le nom d'avant est porté par la ligne, pas perdu.
    expect(constat.writes[0]?.renamedFrom?.endsWith('/garde.ts')).toBe(true);

    await git(['mv', 'renomme.ts', 'garde.ts']);
    await git(['checkout', '--', '.']);
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

  it('le périmètre est comparé sur les chemins RÉELS, pas sur leur graphie', async () => {
    // TROUVÉ PAR LA CI WINDOWS, PREMIER PASSAGE DE LA PR. `git rev-parse` rend
    // toujours la forme longue et suivie ; le dossier visé, lui, peut arriver
    // en forme courte 8.3 (`C:/Users/RUNNER~1/…`, ce que donne `os.tmpdir()`
    // sur un agent GitHub) ou à travers un lien. Les deux désignent le même
    // dossier et ne se ressemblent pas — la garde de périmètre refusait alors
    // le dépôt du run lui-même, et TOUT le constat par git tombait en silence
    // sur le repli disque.
    //
    // Le lien est la forme portable de ce désaccord. Quand la machine ne
    // permet pas d'en créer un (Windows sans mode développeur), le cas se
    // saute EN LE DISANT plutôt que de passer pour vert.
    const lien = join(racine, 'alias-depot');
    try {
      await symlink(depot, lien, 'junction');
    } catch (err) {
      console.warn(
        `[tests] CAS SAUTÉ — impossible de créer un lien vers le dépôt : ${String(err)}\n` +
          '        La règle reste prouvée par la CI Windows, qui a trouvé le défaut.',
      );
      return;
    }

    const avant = await snapshotGitAvant([lien]);

    expect(avant).toHaveLength(1);
    expect(avant[0]?.root).toBe(await repoRootOf(depot));
    await rm(lien, { recursive: true, force: true });
  });

  it('le DOSSIER DU PROJET borne, et un cwd en dessous de lui est couvert', async () => {
    // Revue C de la PR #227, constat 1. Le périmètre est le dossier du projet,
    // que l'appelant passe TOUJOURS (`execute.ts` ajoute les dossiers attachés
    // aux cibles de l'outil). Un `cwd` en dessous est alors couvert par
    // construction, et c'est le cas le plus banal : le dépôt est à la racine du
    // projet, la commande tourne dans `src/`.
    const sous = join(depot, 'coin');
    await mkdir(sous, { recursive: true });
    expect(await repoRootOf(sous)).toBe(await repoRootOf(depot));

    const avant = await snapshotGitAvant([sous, depot]);
    expect(avant).toHaveLength(1);
    expect(avant[0]?.root).toBe(await repoRootOf(depot));

    await rm(sous, { recursive: true, force: true });
  });

  it('le périmètre d’un appel PORTE les dossiers de l’agent, pas seulement la cible', async () => {
    // Revue C de la PR #227, constat 1. C'est le cas de `code_task`, qui ne
    // déclare que son `cwd` : sans les dossiers attachés, la racine de son
    // propre dépôt est au-dessus de tout ce qu'il a nommé, et le run entier
    // retombe en silence sur le constat disque.
    const sous = join(depot, 'src');
    await mkdir(sous, { recursive: true });

    // Ce qu'un outil comme `code_task` déclare, seul : rien n'est constaté.
    expect(await snapshotGitAvant(perimetreGit([sous], []))).toEqual([]);
    // Le même appel, avec le dossier de l'agent : son dépôt est constaté.
    const avant = await snapshotGitAvant(perimetreGit([sous], [depot]));
    expect(avant).toHaveLength(1);
    expect(avant[0]?.root).toBe(await repoRootOf(depot));

    await rm(sous, { recursive: true, force: true });
  });

  it('un dépôt IMBRIQUÉ est constaté avec celui qui le contient', async () => {
    // Revue C de la PR #227, passe 2. Comportement tenu mais jamais dit : un
    // sous-dossier qui a son propre `.git` met DEUX racines dans le périmètre,
    // la sienne (par le `cwd`) et celle du projet (par le dossier attaché).
    // Les deux sont sondées, et c'est voulu — un `npm install` qui écrit dans
    // le sous-dépôt et un script qui écrit à côté sont deux écritures du même
    // run, et n'en montrer qu'une serait le trou que #199 ferme.
    const sous = join(depot, 'vendor');
    await mkdir(sous, { recursive: true });
    await run('git', ['init', '--initial-branch=main'], { cwd: sous, windowsHide: true });

    const avant = await snapshotGitAvant(perimetreGit([sous], [depot]));
    expect(avant.map((s) => s.root).sort()).toEqual(
      [await repoRootOf(depot), await repoRootOf(sous)].sort(),
    );

    // Une écriture DANS le sous-dépôt et une écriture à côté : les deux sont
    // constatées, chacune par le dépôt qui la voit.
    await writeFile(join(sous, 'dedans.ts'), 'export const d = 1;\n');
    await writeFile(join(depot, 'a-cote.ts'), 'export const c = 1;\n');
    const constat = await constatedGitWrites(avant);

    const noms = constat.writes.map((w) => w.path);
    expect(noms.some((p) => p.endsWith('/vendor/dedans.ts'))).toBe(true);
    expect(noms.some((p) => p.endsWith('/a-cote.ts'))).toBe(true);

    await rm(sous, { recursive: true, force: true });
    await rm(join(depot, 'a-cote.ts'), { force: true });
  });

  it('un dépôt au-dessus de TOUT ce qui est passé n’est pas retenu', async () => {
    // Ce que la garde refuse vraiment : une racine qui n'est ni l'un des
    // dossiers passés, ni sous l'un d'eux. Sans elle, un projet posé sous un
    // répertoire personnel versionné faisait constater tout le profil.
    const sous = join(depot, 'coin-seul');
    await mkdir(sous, { recursive: true });
    expect(await snapshotGitAvant([sous])).toEqual([]);
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

  it('une fusion non résolue qui AJOUTE un fichier est un ajout, des deux côtés', () => {
    // Revue C de la PR #227, constat 5. Les états de fusion mettent la lettre
    // tantôt à gauche, tantôt à droite : `AU` ajouté par nous, `UA` ajouté par
    // eux, `AA` par les deux. Ne lire que la gauche faisait dire « modified »
    // d'un fichier que ce run venait de créer.
    expect(kindOfStatus('AU')).toBe('added');
    expect(kindOfStatus('UA')).toBe('added');
    expect(kindOfStatus('AA')).toBe('added');
    expect(kindOfStatus('AM')).toBe('added');
    // Et les états de fusion qui SUPPRIMENT restent des suppressions.
    expect(kindOfStatus('DU')).toBe('deleted');
    expect(kindOfStatus('UD')).toBe('deleted');
    expect(kindOfStatus('UU')).toBe('modified');
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

describe('quel git est lancé @cap:travailler-sur-des-fichiers/moteur', () => {
  // Revue C de la PR #227, constat 3, et ce qui en est RÉELLEMENT vrai ici.
  //
  // La crainte : `execFile('git', …, { cwd: <dossier du projet> })` laisse le
  // système chercher le programme, et la recherche de `CreateProcess` a
  // longtemps regardé le répertoire courant avant le PATH — un `git.exe` déposé
  // dans le dossier d'un projet aurait tourné à la place du git du système.
  //
  // MESURÉ : ce n'est pas ce qui se passe sur ce runtime. Le cas du faux git
  // ci-dessous reste VERT quand on remet la résolution au nom nu, sous Windows
  // avec Node 26.4.0 : libuv ne cherche plus le répertoire courant pour le
  // programme. La résolution absolue est donc un DURCISSEMENT, et c'est le
  // premier cas qui la prouve. Le second garde le mécanisme sous les yeux pour
  // un runtime qui chercherait encore.

  it('le binaire est un chemin ABSOLU pris dans le PATH du processus', async () => {
    const binaire = await resolveGitBinary();
    expect(binaire).not.toBeNull();
    // Absolu : `execFile` n'a plus rien à chercher, donc plus de dossier
    // courant dans la recherche.
    expect(binaire === null || /^([A-Za-z]:\/|\/)/.test(binaire)).toBe(true);
    expect(binaire === null || (await estUnFichier(binaire))).toBe(true);
  });

  it('un faux git POSÉ DANS LE PROJET n’est ni résolu ni appelé', async () => {
    const faux = join(depot, process.platform === 'win32' ? 'git.exe' : 'git');
    const posé = await poserUnFauxGit(faux);
    if (!posé) {
      console.warn(
        '[tests] CAS SAUTÉ — impossible de fabriquer un faux exécutable ici.\n' +
          '        La résolution absolue reste prouvée par le cas au-dessus.',
      );
      return;
    }

    _resetGitBinaryCache();
    const binaire = await resolveGitBinary();
    expect(binaire).not.toBe(normalizePath(faux));

    // ET le constat marche encore : si le faux avait été lancé, sa sortie
    // n'aurait rien d'un `git status`, l'instantané serait nul, et le run
    // entier retomberait en silence sur le constat disque.
    const avant = await snapshotGitAvant([depot]);
    expect(avant).toHaveLength(1);
    expect(avant[0]?.root).toBe(await repoRootOf(depot));

    await rm(faux, { force: true });
    _resetGitBinaryCache();
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
