// failure-timeout.test.ts — ce qui se passe quand la borne de temps TOMBE.
//
// ## Pourquoi ces cas ont leur propre fichier (revue #262, CI du 20/09)
//
// Ils vivaient dans `failure.test.ts` et forçaient le dépassement en posant la
// borne à 1 ms sur un vrai `git`. C'était une COURSE, et la CI l'a gagnée :
// verte sous Windows, où lancer git coûte des dizaines de millisecondes, rouge
// sous Linux, où `rev-parse` rend la main avant que le minuteur d'`execFile`
// ne se déclenche. Le rapport disait « l'instantané a réussi alors que le test
// attendait un refus ». Un test dont le verdict dépend de la vitesse de la
// machine ne prouve rien (invariant #5) — et celui-là était le pire des deux
// mondes : il passait là où on le regardait.
//
// ## Ce qui rend ces cas déterministes
//
// On ne rend plus la BORNE minuscule, on rend le TRAVAIL infini. `execFile`
// est détourné pour lancer, à la demande, un processus Node qui ne rend jamais
// la main. La machinerie de Node est intacte : c'est bien elle qui arme le
// minuteur avec la borne que le code lui a passée, qui tue l'enfant, et qui
// produit l'erreur `killed: true` que `qualifyFailure` classe. Ce qui est
// faux, c'est seulement QUEL programme pend — et aucune vitesse de machine ne
// peut faire finir un `setInterval` éternel avant 200 ms.
//
// Le détournement est CONDITIONNEL (`etat.ralentir`), parce que ces tests ont
// besoin d'un vrai magasin avant de le faire pendre : le magasin est créé par
// de vrais `git init` et `git commit-tree`, puis on bascule.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Le commutateur, hissé pour que la fabrique du mock puisse le lire. */
const etat = vi.hoisted(() => ({ ralentir: false }));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');

  /** Un enfant qui ne rend JAMAIS la main. Seule la borne peut y mettre fin. */
  const PEND = ['-e', 'setInterval(() => {}, 1000);'];

  type Rappel = (err: unknown, stdout: string, stderr: string) => void;
  const lancer = (
    file: string,
    args: readonly string[] | undefined,
    options: unknown,
    cb: Rappel,
  ): unknown =>
    etat.ralentir
      ? (actual.execFile as never as (...a: unknown[]) => unknown)(
          process.execPath,
          PEND,
          options,
          cb,
        )
      : (actual.execFile as never as (...a: unknown[]) => unknown)(file, args, options, cb);

  const faux = ((...a: unknown[]) =>
    lancer(
      a[0] as string,
      a[1] as readonly string[],
      a[2],
      a[3] as Rappel,
    )) as unknown as typeof actual.execFile;

  // `promisify` lit CE symbole sur la fonction, et `checkpoints.ts` fait
  // `promisify(execFile)` au chargement. Sans lui, la version promise rendrait
  // `stdout` seul au lieu de `{ stdout, stderr }`, et tout le module casserait
  // pour une raison qui n'a rien à voir avec ce qu'on teste.
  Object.defineProperty(faux, promisify.custom, {
    value: (file: string, args: readonly string[], options: unknown) =>
      new Promise((resolve, reject) => {
        lancer(file, args, options, (err, stdout, stderr) => {
          if (err) reject(Object.assign(err as object, { stdout, stderr }));
          else resolve({ stdout, stderr });
        });
      }),
  });

  return { ...actual, execFile: faux };
});

import { snapshot, listCheckpoints, diffFile, gitAllowingMiss } from './checkpoints';
import {
  isCheckpointError,
  checkpointFailureLogLine,
  checkpointRefusalMessage,
  PATH_MAX_CHARS,
  type CheckpointError,
} from './failure';

/**
 * Large devant le temps qu'il faut pour tuer un processus, minuscule devant
 * l'éternité que l'enfant détourné promet. Le verdict ne peut pas basculer.
 */
const BORNE_MS = 200;

let root: string;
let store: string;
let ws: string;

beforeEach(async () => {
  etat.ralentir = false;
  root = await mkdtemp(join(tmpdir(), 'nodal-cpt-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'shared');
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  etat.ralentir = false;
  delete process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'];
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

/** Le rejet, rendu comme `CheckpointError` — ou le test échoue en le disant. */
async function refusDe(promesse: Promise<unknown>): Promise<CheckpointError> {
  try {
    await promesse;
  } catch (err) {
    if (isCheckpointError(err)) return err;
    throw new Error(
      `l'appel a échoué SANS porter ses faits : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error("l'appel a réussi alors que le test attendait un refus");
}

/** Un arbre réel, assez fourni pour que la mesure ait quelque chose à compter. */
async function remplirLeDossier(cible: string, fichiers = 40): Promise<void> {
  for (let i = 0; i < fichiers; i++) {
    const sousDossier = join(cible, `d${i % 4}`);
    await mkdir(sousDossier, { recursive: true });
    await writeFile(join(sousDossier, `f${i}.txt`), 'x'.repeat(1024));
  }
}

/** Le magasin, créé par de VRAIS git, avant qu'on fasse pendre les suivants. */
async function magasinReel(cible = ws): Promise<string> {
  await writeFile(join(cible, 'amorce.txt'), 'bonjour');
  const cp = await snapshot(store, cible, 'amorce');
  if (!cp) throw new Error("l'amorce du magasin n'a rien enregistré");
  return cp.sha;
}

describe('un instantané qui dépasse la borne @cap:executer-une-commande/moteur', () => {
  it('rend le code `snapshot_timeout` ET les faits mesurés du dossier', async () => {
    await magasinReel();
    await remplirLeDossier(ws);
    etat.ralentir = true;

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: BORNE_MS }));

    expect(err.code).toBe('snapshot_timeout');
    expect(err.operation).toBe('snapshot');
    expect(err.workspace).toBe(ws);
    expect(err.limitMs).toBe(BORNE_MS);
    // LA BORNE A RÉELLEMENT TENU : la tentative a duré au moins ce qu'elle
    // annonçait. C'est ce qui distingue « la borne est tombée » de « quelque
    // chose a échoué », et c'est précisément ce que la version à 1 ms ne
    // pouvait pas garantir — git y finissait AVANT le minuteur.
    expect(err.elapsedMs).toBeGreaterThanOrEqual(BORNE_MS);
    // Les mesures sont RÉELLES : 40 fichiers de 1 Ko, plus l'amorce.
    expect(err.measure).not.toBeNull();
    expect(err.measure?.files).toBe(41);
    expect(err.measure?.bytes).toBe(40 * 1024 + 7);
    expect(err.measure?.capped).toBe(false);
  });

  it('dit la phrase actionnable : la taille, le nombre de fichiers, la borne, le geste', async () => {
    await magasinReel();
    await remplirLeDossier(ws);
    etat.ralentir = true;

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: BORNE_MS }));

    // La phrase ENTIÈRE, pas un fragment : c'est elle que l'agent lit et que le
    // fil affiche. Un test sur « contient snapshot_timeout » laisserait passer
    // un message redevenu générique après les deux premiers mots.
    expect(err.message).toBe(
      `snapshot_timeout: the "shared" workspace (${ws}) holds 40 KB / 41 files, ` +
        `the safety snapshot cannot finish in 200 ms; move or ignore the heavy folders.`,
    );
  });

  it('le message du refus ajoute la conséquence, jamais une deuxième version de la cause', async () => {
    await magasinReel();
    etat.ralentir = true;

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: BORNE_MS }));

    expect(checkpointRefusalMessage(err, '"run_command"')).toBe(
      `${err.message} "run_command" was refused rather than run without a way back.`,
    );
  });

  it('la ligne de journal porte le code et chaque mesure', async () => {
    await magasinReel();
    await remplirLeDossier(ws);
    etat.ralentir = true;

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: BORNE_MS }));
    const ligne = checkpointFailureLogLine(err, { tool: 'run_command', job: 'job-1', turn: 3 });

    expect(ligne).toContain('CHECKPOINT_REFUSED');
    expect(ligne).toContain('code=snapshot_timeout');
    expect(ligne).toContain('operation=snapshot');
    expect(ligne).toContain(`limit_ms=${BORNE_MS}`);
    expect(ligne).toContain(`bytes=${40 * 1024 + 7}`);
    expect(ligne).toContain('files=41');
    expect(ligne).toContain('files_capped=false');
    expect(ligne).toContain('tool=run_command');
    expect(ligne).toContain('job=job-1');
    expect(ligne).toContain('turn=3');
    // Une ligne, jamais deux : un journal qui se coupe en deux ne se grep plus.
    expect(ligne.split('\n')).toHaveLength(1);
  });

  it('la borne vient aussi de l’environnement, pour un dossier gros mais légitime', async () => {
    await magasinReel();
    etat.ralentir = true;
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = String(BORNE_MS);

    const err = await refusDe(snapshot(store, ws, 'before run_command'));

    expect(err.code).toBe('snapshot_timeout');
    expect(err.limitMs).toBe(BORNE_MS);
  });

  it('un chemin très long est raccourci PAR LE MILIEU et la phrase finit par le geste', async () => {
    // Revue #262, passe 1 : l'appelant coupait le message à 600 caractères, et
    // sur un chemin profond la coupe mangeait « move or ignore the heavy
    // folders », la seule partie sur laquelle quelqu'un peut agir.
    //
    // LE MAGASIN EST AMORCÉ AILLEURS, sur le chemin court : un vrai `git` ne
    // sait pas travailler sur un chemin de 300 caractères sous Windows, et ce
    // n'est pas ce qu'on teste. Une fois le magasin créé, l'instantané du
    // chemin profond pend avant de toucher à quoi que ce soit.
    await magasinReel();
    const profond = join(ws, ...Array.from({ length: 14 }, (_, i) => `un-dossier-assez-long-${i}`));
    await mkdir(profond, { recursive: true });
    expect(profond.length).toBeGreaterThan(PATH_MAX_CHARS);
    etat.ralentir = true;

    const err = await refusDe(
      snapshot(store, profond, 'before run_command', { timeoutMs: BORNE_MS }),
    );

    expect(err.message).toContain('…');
    expect(err.message).toContain(profond.slice(0, 40));
    expect(err.message.endsWith('move or ignore the heavy folders.')).toBe(true);
    // Et la conséquence survit elle aussi : c'est ce que l'appelant coupait.
    expect(
      checkpointRefusalMessage(err, 'the code harness turn').endsWith(
        'the code harness turn was refused rather than run without a way back.',
      ),
    ).toBe(true);
  });
});

describe('une PANNE n’est jamais lue comme une réponse @cap:executer-une-commande/moteur', () => {
  // Revue #262, passe 1. Les deux lectures de l'instantané portaient un
  // `.catch(() => '')` nu. Une fois la borne de temps en place (#245), un
  // `rev-parse` TUÉ par cette borne se lisait « pas de parent » : `commit-tree`
  // repartait sans `-p`, `update-ref` posait un commit RACINE, et la chaîne des
  // checkpoints se coupait en silence.

  it('une borne dépassée REJETTE au lieu de rendre une chaîne vide', async () => {
    const amorce = await magasinReel();
    // La même lecture, sans détournement, répond bien.
    expect(await gitAllowingMiss(store, ws, ['rev-parse', '--verify', '--quiet', amorce])).toBe(
      amorce,
    );

    etat.ralentir = true;
    await expect(
      gitAllowingMiss(store, ws, ['rev-parse', '--verify', '--quiet', amorce], {
        timeoutMs: BORNE_MS,
      }),
    ).rejects.toThrow();
  });

  it('la chaîne des instantanés ne repart JAMAIS d’un commit racine', async () => {
    // Le dommage que tout ça évite, constaté sur le magasin : chaque photo a la
    // précédente pour parent, donc l'état d'avant reste retrouvable.
    const premier = await magasinReel();
    await writeFile(join(ws, 'amorce.txt'), 'deux');
    const second = await snapshot(store, ws, 'second');

    // Une tentative qui PANNE entre les deux ne bouge pas la ref.
    await writeFile(join(ws, 'amorce.txt'), 'trois');
    etat.ralentir = true;
    const err = await refusDe(snapshot(store, ws, 'tue par la borne', { timeoutMs: BORNE_MS }));
    expect(err.code).toBe('snapshot_timeout');
    etat.ralentir = false;
    expect(await listCheckpoints(store, ws)).toHaveLength(2);

    // Puis un instantané qui réussit reprend la chaîne où elle était.
    const troisieme = await snapshot(store, ws, 'troisieme');
    const parents = async (sha: string): Promise<string[]> =>
      (await gitAllowingMiss(store, ws, ['rev-list', '--parents', '-n', '1', sha]))
        .split(/\s+/)
        .filter(Boolean)
        .slice(1);

    expect(await parents(troisieme!.sha)).toEqual([second!.sha]);
    expect(await parents(second!.sha)).toEqual([premier]);
    expect(await parents(premier)).toEqual([]);
  });
});

describe('une LECTURE du magasin ne ment pas non plus @cap:executer-une-commande/moteur', () => {
  // Revue #262, passe 2. `listCheckpoints` et `diffFile` avalaient chaque panne
  // dans une réponse vide : « aucun checkpoint » sur un magasin qui en a, « pas
  // dans l'instantané » sur un chemin photographié.

  it('`listCheckpoints` LÈVE au lieu de rendre une liste vide', async () => {
    await magasinReel();
    await writeFile(join(ws, 'amorce.txt'), 'deux');
    await snapshot(store, ws, 'second');
    // Le magasin en contient bien deux : c'est ce que la panne ne doit pas nier.
    expect(await listCheckpoints(store, ws)).toHaveLength(2);

    etat.ralentir = true;
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = String(BORNE_MS);
    const err = await refusDe(listCheckpoints(store, ws));

    expect(err.code).toBe('checkpoint_read_timeout');
    expect(err.operation).toBe('read');
    // Aucune mesure : relire ne parcourt pas le dossier, donc sa taille ne
    // serait pas la cause et le geste de l'instantané ne s'applique pas.
    expect(err.measure).toBeNull();
    expect(err.message).toContain('reading the checkpoint history');
    expect(err.message).toContain('no history is shown rather than an empty one');
    expect(err.message).not.toContain('move or ignore the heavy folders');
  });

  it('`diffFile` LÈVE au lieu de dire qu’un fichier photographié est hors instantané', async () => {
    const amorce = await magasinReel();
    await writeFile(join(ws, 'amorce.txt'), 'apres');
    // Le fichier EST dans l'instantané : la lecture ordinaire le montre.
    expect((await diffFile(store, ws, amorce, null, 'amorce.txt')).kind).toBe('diff');

    etat.ralentir = true;
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = String(BORNE_MS);
    const err = await refusDe(diffFile(store, ws, amorce, null, 'amorce.txt'));

    expect(err.code).toBe('checkpoint_read_timeout');
    expect(err.operation).toBe('read');
    expect(err.message).toContain('reading the checkpoint history');
  });

  it('la ligne de journal d’une lecture dit son opération', async () => {
    await magasinReel();
    etat.ralentir = true;
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = String(BORNE_MS);

    const err = await refusDe(listCheckpoints(store, ws));
    const ligne = checkpointFailureLogLine(err, { route: 'file-diff' });

    expect(ligne).toContain('code=checkpoint_read_timeout');
    expect(ligne).toContain('operation=read');
    expect(ligne).toContain('bytes=unmeasured');
    expect(ligne).toContain('route=file-diff');
  });
});
