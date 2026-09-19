// failure.test.ts — un refus de checkpoint NOMME sa cause (issue #245).
//
// Ce qui est prouvé ici n'est pas qu'un message se met en forme : c'est qu'une
// borne de temps DÉPASSÉE sur un vrai arbre, par un vrai `git add -A`, produit
// un code typé et des chiffres mesurés. D'où la borne injectée à 1 ms plutôt
// qu'un faux `execFile` : un faux prouverait la mise en forme et rien d'autre,
// exactement le test qui reste vert le jour où la borne cesse de se déclencher.
//
// Le 19/09/2026, le refus disait `checkpoint_failed: ... Cause: git add timed
// out after 30000 ms`. Les agents ont cherché une panne du dossier pendant des
// heures, alors que la cause tenait en une phrase : 3,3 Go de paquets de
// relecture y avaient été déballés.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  snapshot,
  headCheckpoint,
  gitAllowingMiss,
  listCheckpoints,
  diffFile,
} from './checkpoints';
import {
  CheckpointError,
  isCheckpointError,
  measureWorkspace,
  SKIPPED_DIRS,
  SKIPPED_FILE_SUFFIXES,
  PATH_MAX_CHARS,
  checkpointFailureLogLine,
  checkpointRefusalMessage,
  formatBytes,
  formatCount,
  formatDuration,
} from './failure';

let root: string;
let store: string;
let ws: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cpf-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'shared');
  await mkdir(ws, { recursive: true });
});

afterEach(async () => {
  delete process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'];
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

/** Un arbre réel, assez fourni pour que la mesure ait quelque chose à compter. */
async function remplirLeDossier(fichiers = 40): Promise<void> {
  for (let i = 0; i < fichiers; i++) {
    const sousDossier = join(ws, `d${i % 4}`);
    await mkdir(sousDossier, { recursive: true });
    await writeFile(join(sousDossier, `f${i}.txt`), 'x'.repeat(1024));
  }
}

/** Le rejet de `snapshot`, rendu comme `CheckpointError` — ou le test échoue en le disant. */
async function refusDe(promesse: Promise<unknown>): Promise<CheckpointError> {
  try {
    await promesse;
  } catch (err) {
    if (isCheckpointError(err)) return err;
    throw new Error(
      `l'instantané a échoué SANS porter ses faits : ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  throw new Error("l'instantané a réussi alors que le test attendait un refus");
}

describe('un instantané qui dépasse la borne @cap:executer-une-commande/moteur', () => {
  it('rend le code `snapshot_timeout` ET les faits mesurés du dossier', async () => {
    await remplirLeDossier();

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: 1 }));

    expect(err.code).toBe('snapshot_timeout');
    expect(err.workspace).toBe(ws);
    expect(err.limitMs).toBe(1);
    // Les mesures sont RÉELLES : 40 fichiers de 1 Ko viennent d'être écrits.
    expect(err.measure).not.toBeNull();
    expect(err.measure?.files).toBe(40);
    expect(err.measure?.bytes).toBe(40 * 1024);
    expect(err.measure?.capped).toBe(false);
  });

  it('dit la phrase actionnable : la taille, le nombre de fichiers, la borne, le geste', async () => {
    await remplirLeDossier();

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: 1 }));

    // La phrase ENTIÈRE, pas un fragment : c'est elle que l'agent lit et que le
    // fil affiche. Un test sur « contient snapshot_timeout » laisserait passer
    // un message redevenu générique après les deux premiers mots.
    expect(err.message).toBe(
      `snapshot_timeout: the "shared" workspace (${ws}) holds 40 KB / 40 files, ` +
        `the safety snapshot cannot finish in 1 ms; move or ignore the heavy folders.`,
    );
  });

  it('le message du refus ajoute la conséquence, jamais une deuxième version de la cause', async () => {
    await remplirLeDossier();

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: 1 }));

    expect(checkpointRefusalMessage(err, '"run_command"')).toBe(
      `${err.message} "run_command" was refused rather than run without a way back.`,
    );
  });

  it('la ligne de journal porte le code et chaque mesure', async () => {
    await remplirLeDossier();

    const err = await refusDe(snapshot(store, ws, 'before run_command', { timeoutMs: 1 }));
    const ligne = checkpointFailureLogLine(err, { tool: 'run_command', job: 'job-1', turn: 3 });

    expect(ligne).toContain('CHECKPOINT_REFUSED');
    expect(ligne).toContain('code=snapshot_timeout');
    expect(ligne).toContain('limit_ms=1');
    expect(ligne).toContain(`bytes=${40 * 1024}`);
    expect(ligne).toContain('files=40');
    expect(ligne).toContain('files_capped=false');
    expect(ligne).toContain('tool=run_command');
    expect(ligne).toContain('job=job-1');
    expect(ligne).toContain('turn=3');
    // Une ligne, jamais deux : un journal qui se coupe en deux ne se grep plus.
    expect(ligne.split('\n')).toHaveLength(1);
  });

  it('la borne vient aussi de l’environnement, pour un dossier gros mais légitime', async () => {
    await remplirLeDossier(4);
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = '1';

    const err = await refusDe(snapshot(store, ws, 'before run_command'));

    expect(err.code).toBe('snapshot_timeout');
    expect(err.limitMs).toBe(1);
  });
});

/** Les parents d'un commit du magasin, lus sur le magasin lui-même. */
async function parentsDe(sha: string): Promise<string[]> {
  const ligne = await gitAllowingMiss(store, ws, ['rev-list', '--parents', '-n', '1', sha]);
  return ligne.split(/\s+/).filter(Boolean).slice(1);
}

describe('une PANNE n’est jamais lue comme une réponse @cap:executer-une-commande/moteur', () => {
  // Revue de la PR #262, passe 1. Les deux lectures de l'instantané portaient
  // un `.catch(() => '')` nu. Depuis que la borne de temps existe (#245), un
  // `rev-parse` TUÉ par cette borne se lisait donc « pas de parent » :
  // `commit-tree` repartait sans `-p`, `update-ref` posait un commit RACINE et
  // la chaîne des checkpoints se coupait en silence.
  //
  // POURQUOI LA DISTINCTION EST ÉPINGLÉE ICI, et pas par un instantané entier
  // calibré pour frapper le `rev-parse` : chaque commande git a SA borne, et
  // `add -A` parcourt l'arbre quand `rev-parse` lit un fichier. `add -A` est
  // donc toujours le plus lent, et aucune valeur de borne ne tue le second
  // sans avoir tué le premier. Un test qui prétendrait le contraire serait
  // instable. C'est donc `gitAllowingMiss` — la fonction que l'instantané
  // utilise, sur un vrai magasin — qui est épinglée, avec de VRAIES erreurs.

  it('une ref absente est une RÉPONSE : la lecture rend une chaîne vide', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');
    await snapshot(store, ws, 'premier');

    const absente = await gitAllowingMiss(store, ws, [
      'rev-parse',
      '--verify',
      '--quiet',
      'refs/nodal/jamais-photographie',
    ]);

    expect(absente).toBe('');
  });

  it('une borne dépassée est une PANNE : la lecture REJETTE au lieu de rendre une chaîne vide', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');
    const premier = await snapshot(store, ws, 'premier');
    const cible = premier!.sha;

    // La même lecture, sans borne serrée, répond bien.
    expect(await gitAllowingMiss(store, ws, ['rev-parse', '--verify', '--quiet', cible])).toBe(
      cible,
    );

    // Avec une borne de 1 ms, elle ne répond pas : elle doit le DIRE.
    await expect(
      gitAllowingMiss(store, ws, ['rev-parse', '--verify', '--quiet', cible], { timeoutMs: 1 }),
    ).rejects.toThrow();
  });

  it('la chaîne des instantanés ne repart JAMAIS d’un commit racine', async () => {
    // Le dommage que tout ça évite, constaté sur le magasin : chaque photo a
    // la précédente pour parent, donc l'état d'avant reste retrouvable.
    await writeFile(join(ws, 'a.txt'), 'un');
    const premier = await snapshot(store, ws, 'premier');
    await writeFile(join(ws, 'a.txt'), 'deux');
    const second = await snapshot(store, ws, 'second');

    // Une tentative qui PANNE entre les deux ne bouge pas la ref.
    await writeFile(join(ws, 'a.txt'), 'trois');
    const err = await refusDe(snapshot(store, ws, 'tue par la borne', { timeoutMs: 1 }));
    expect(err.code).toBe('snapshot_timeout');
    expect(await headCheckpoint(store, ws)).toBe(second!.sha);

    // Puis un instantané qui réussit reprend la chaîne où elle était.
    const troisieme = await snapshot(store, ws, 'troisieme');
    expect(await parentsDe(troisieme!.sha)).toEqual([second!.sha]);
    expect(await parentsDe(second!.sha)).toEqual([premier!.sha]);
    expect(await parentsDe(premier!.sha)).toEqual([]);
  });
});

describe('une LECTURE du magasin ne ment pas non plus @cap:executer-une-commande/moteur', () => {
  // Revue de la PR #262, passe 2. `listCheckpoints` et `diffFile` avalaient
  // chaque panne dans une réponse vide : « aucun checkpoint » sur un magasin
  // qui en a, « pas dans l'instantané » sur un chemin photographié. Même
  // classe de silence que celui que ce lot supprime côté écriture, et il frappe
  // exactement les magasins qui grossissent.
  //
  // Le dépassement est provoqué par `NODALAI_CHECKPOINT_TIMEOUT_MS`, comme pour
  // l'instantané, et il est RÉEL : le magasin contient vraiment des photos, et
  // la lecture ordinaire vient de les rendre juste avant.

  it('`listCheckpoints` LÈVE au lieu de rendre une liste vide', async () => {
    await writeFile(join(ws, 'a.txt'), 'un');
    await snapshot(store, ws, 'premier');
    await writeFile(join(ws, 'a.txt'), 'deux');
    await snapshot(store, ws, 'second');
    expect(await listCheckpoints(store, ws)).toHaveLength(2);

    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = '1';
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

  it('un dossier jamais photographié rend TOUJOURS une liste vide', async () => {
    // Le contrôle du correctif trop large : une vraie réponse de git reste une
    // réponse. Sans lui, « lève sur une panne » pourrait devenir « lève ».
    const jamais = join(root, 'jamais-photographie');
    await mkdir(jamais, { recursive: true });
    await writeFile(join(ws, 'a.txt'), 'un');
    await snapshot(store, ws, 'premier');

    expect(await listCheckpoints(store, jamais)).toEqual([]);
  });

  it('`diffFile` LÈVE au lieu de dire qu’un fichier photographié est hors instantané', async () => {
    await writeFile(join(ws, 'a.txt'), 'avant');
    const premier = await snapshot(store, ws, 'premier');
    await writeFile(join(ws, 'a.txt'), 'apres');
    expect((await diffFile(store, ws, premier!.sha, null, 'a.txt')).kind).toBe('diff');

    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = '1';
    const err = await refusDe(diffFile(store, ws, premier!.sha, null, 'a.txt'));

    expect(err.code).toBe('checkpoint_read_timeout');
    expect(err.operation).toBe('read');
    expect(err.message).toContain('reading the checkpoint history');
  });

  it('un chemin réellement absent des deux états rend TOUJOURS `not_in_snapshot`', async () => {
    await writeFile(join(ws, 'a.txt'), 'avant');
    const premier = await snapshot(store, ws, 'premier');

    expect((await diffFile(store, ws, premier!.sha, null, 'jamais-ecrit.txt')).kind).toBe(
      'not_in_snapshot',
    );
  });

  it('la ligne de journal d’une lecture dit son opération', async () => {
    await writeFile(join(ws, 'a.txt'), 'un');
    await snapshot(store, ws, 'premier');
    process.env['NODALAI_CHECKPOINT_TIMEOUT_MS'] = '1';

    const err = await refusDe(listCheckpoints(store, ws));
    const ligne = checkpointFailureLogLine(err, { route: 'file-diff' });

    expect(ligne).toContain('code=checkpoint_read_timeout');
    expect(ligne).toContain('operation=read');
    expect(ligne).toContain('bytes=unmeasured');
    expect(ligne).toContain('route=file-diff');
  });
});

describe('un instantané ordinaire ne change pas @cap:executer-une-commande/moteur', () => {
  it('rend un checkpoint avec son sha, borne par défaut', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');

    const cp = await snapshot(store, ws, 'before file_write');

    expect(cp).not.toBeNull();
    expect(cp?.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(cp?.workspace).toBe(ws);
    expect(cp?.label).toBe('before file_write');
  });

  it('rend toujours `null` quand rien n’a bougé, borne explicite ou non', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');

    expect(await snapshot(store, ws, 'premier')).not.toBeNull();
    expect(await snapshot(store, ws, 'second', { timeoutMs: 30_000 })).toBeNull();
  });

  it('refuse une borne absurde au lieu de retomber en silence sur le défaut', async () => {
    // Invariant #4. Une borne à 0 qui redeviendrait 30 s en silence ferait
    // croire à un appelant qu'il a demandé quelque chose qu'il n'a pas eu.
    await expect(snapshot(store, ws, 'x', { timeoutMs: 0 })).rejects.toThrow(
      /invalid snapshot timeout: 0/,
    );
  });
});

describe('les autres causes portent un AUTRE code @cap:executer-une-commande/moteur', () => {
  it('`git_missing` quand le binaire est introuvable', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');
    const sansGit = join(root, 'chemin-vide');
    await mkdir(sansGit, { recursive: true });
    const pathAvant = process.env['PATH'];
    process.env['PATH'] = sansGit;
    try {
      const err = await refusDe(snapshot(store, ws, 'before run_command'));
      expect(err.code).toBe('git_missing');
      // Rien n'est mesuré ici : parcourir l'arbre coûterait le prix d'un
      // instantané pour n'éclairer personne.
      expect(err.measure).toBeNull();
      expect(err.message).toContain('git is not available');
    } finally {
      if (pathAvant === undefined) delete process.env['PATH'];
      else process.env['PATH'] = pathAvant;
    }
  });

  it('`snapshot_failed` quand le magasin est inutilisable', async () => {
    // Un magasin dont le parent est un FICHIER — le même montage que le test
    // du seam, pour que les deux parlent du même échec.
    const bloque = join(root, 'fichier-pas-dossier');
    await writeFile(bloque, 'je ne suis pas un dossier');
    await writeFile(join(ws, 'a.txt'), 'bonjour');

    const err = await refusDe(snapshot(join(bloque, 'checkpoints'), ws, 'before run_command'));

    expect(err.code).toBe('snapshot_failed');
    expect(err.measure).toBeNull();
    expect(err.message).toMatch(/^snapshot_failed: the safety snapshot of the "shared" workspace/);
  });
});

describe('la mesure est bornée et le DIT @cap:executer-une-commande/moteur', () => {
  it('s’arrête au plafond de fichiers et rend des planchers, pas des totaux', async () => {
    await remplirLeDossier(20);

    const mesure = await measureWorkspace(ws, { maxFiles: 5 });

    expect(mesure.files).toBe(5);
    expect(mesure.capped).toBe(true);
    expect(mesure.bytes).toBe(5 * 1024);
  });

  it('une mesure arrêtée se lit « more than », jamais comme un total', async () => {
    await remplirLeDossier(20);
    const mesure = await measureWorkspace(ws, { maxFiles: 5 });
    const err = new CheckpointError({
      code: 'snapshot_timeout',
      operation: 'snapshot',
      workspace: ws,
      limitMs: 30_000,
      elapsedMs: 30_001,
      measure: mesure,
      gitMessage: 'git add -A timed out',
    });

    expect(err.message).toBe(
      `snapshot_timeout: the "shared" workspace (${ws}) holds more than 5 KB / ` +
        `more than 5 files, the safety snapshot cannot finish in 30 s; ` +
        `move or ignore the heavy folders.`,
    );
  });

  it('saute EXACTEMENT les dossiers que le magasin met dans son fichier d’exclusion', async () => {
    // La liste est UNE. Si la mesure et l'instantané divergeaient, un refus
    // annoncerait une taille que git n'a jamais eu à traverser, et enverrait
    // le propriétaire vider le mauvais dossier. Le fichier relu ici est celui
    // qu'un VRAI instantané vient d'écrire dans le magasin, pas une constante.
    await writeFile(join(ws, 'a.txt'), 'bonjour');
    await snapshot(store, ws, 'premier');

    const exclude = await readFile(join(store, 'store', 'info', 'exclude'), 'utf-8');
    const dossiersExclus = exclude
      .split('\n')
      .filter((ligne) => ligne.endsWith('/'))
      .map((ligne) => ligne.slice(0, -1))
      .sort();

    expect(dossiersExclus).toEqual([...SKIPPED_DIRS].sort());
  });

  it('ne compte pas non plus les FICHIERS que l’instantané exclut', async () => {
    // Revue #262, passe 1 : `EXCLUDES` porte aussi `*.log`, qu'un ensemble de
    // noms de dossiers ne pouvait pas honorer. Un dossier plein de journaux
    // aurait donc été annoncé comme la cause d'un refus alors que git ne les
    // enregistre jamais, et le propriétaire aurait vidé le mauvais dossier.
    await writeFile(join(ws, 'serveur.log'), 'y'.repeat(100_000));
    await writeFile(join(ws, 'a.txt'), 'bonjour');

    const mesure = await measureWorkspace(ws);

    expect(mesure.files).toBe(1);
    expect(mesure.bytes).toBe(7);
  });

  it('les suffixes exclus sont EXACTEMENT ceux que le magasin écrit comme motifs', async () => {
    await writeFile(join(ws, 'a.txt'), 'bonjour');
    await snapshot(store, ws, 'premier');

    const exclude = await readFile(join(store, 'store', 'info', 'exclude'), 'utf-8');
    const motifs = exclude
      .split('\n')
      .filter((ligne) => ligne.startsWith('*'))
      .map((ligne) => ligne.slice(1))
      .sort();

    expect(motifs).toEqual([...SKIPPED_FILE_SUFFIXES].sort());
  });

  it('ne descend pas dans les dossiers que l’instantané exclut déjà', async () => {
    // Compter `node_modules` enverrait le propriétaire vider un dossier qui
    // n'était pas le problème : git ne l'a jamais regardé.
    await mkdir(join(ws, 'node_modules', 'paquet'), { recursive: true });
    await writeFile(join(ws, 'node_modules', 'paquet', 'gros.js'), 'y'.repeat(100_000));
    await mkdir(join(ws, 'dist'), { recursive: true });
    await writeFile(join(ws, 'dist', 'bundle.js'), 'z'.repeat(50_000));
    await writeFile(join(ws, 'a.txt'), 'bonjour');

    const mesure = await measureWorkspace(ws);

    expect(mesure.files).toBe(1);
    expect(mesure.bytes).toBe(7);
    expect(mesure.capped).toBe(false);
  });
});

describe('la phrase est bornée SANS perdre son geste @cap:executer-une-commande/moteur', () => {
  // Revue #262, passe 1 : l'appelant coupait le message à 600 caractères, et
  // sur un chemin profond la coupe tombait dans la fin de la phrase — elle
  // mangeait « move or ignore the heavy folders », la seule partie sur
  // laquelle quelqu'un peut agir. Ce sont les parties VARIABLES qui sont
  // bornées désormais, chacune en le disant.

  it('un chemin très long est raccourci PAR LE MILIEU et la phrase finit toujours par le geste', async () => {
    const profond = join(ws, ...Array.from({ length: 14 }, (_, i) => `un-dossier-assez-long-${i}`));
    await mkdir(profond, { recursive: true });
    await writeFile(join(profond, 'a.txt'), 'bonjour');
    expect(profond.length).toBeGreaterThan(PATH_MAX_CHARS);

    const err = await refusDe(snapshot(store, profond, 'before run_command', { timeoutMs: 1 }));

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

  it('une sortie de git interminable est coupée, et le dit', () => {
    const err = new CheckpointError({
      code: 'snapshot_failed',
      operation: 'snapshot',
      workspace: 'C:\\ws',
      limitMs: null,
      elapsedMs: null,
      measure: null,
      gitMessage: 'z'.repeat(5_000),
    });

    expect(err.message.length).toBeLessThan(400);
    expect(err.message.endsWith('…')).toBe(true);
  });
});

describe('les chiffres se lisent pareil partout @cap:executer-une-commande/moteur', () => {
  it('les octets, en unités que `du -sh` rendrait', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(3.3 * 1024 ** 3)).toBe('3.3 GB');
  });

  it('les milliers, sans dépendre de la locale du processus', () => {
    expect(formatCount(7)).toBe('7');
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(200_000)).toBe('200,000');
  });

  it('les durées, en secondes dès qu’elles en valent une', () => {
    expect(formatDuration(1)).toBe('1 ms');
    expect(formatDuration(999)).toBe('999 ms');
    expect(formatDuration(1500)).toBe('1.5 s');
    expect(formatDuration(60_000)).toBe('60 s');
  });
});
