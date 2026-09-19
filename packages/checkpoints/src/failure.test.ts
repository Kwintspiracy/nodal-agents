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
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot } from './checkpoints';
import {
  CheckpointError,
  isCheckpointError,
  measureWorkspace,
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
