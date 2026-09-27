// current-content-window.test.ts — la dernière vérification de la porte
// d'écrasement lit le disque EN DERNIER (revue Codex de #505, passe 3).
//
// La fenêtre entre cette lecture et le `rename` ne se ferme pas face à un
// écrivain qui ne coopère pas (voir `atomic-write.ts`). Ce qui se prouve ici :
// aucune attente superflue ne l'élargit. La requête en base se fait AVANT la
// lecture du fichier ; un fichier changé PENDANT cette requête est vu.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentContentWrittenByJob } from '../verification/record-constat';
import type { AnyDrizzleDb } from '@nodal-agents/db';

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-window-'));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

/** Une base dont la requête laisse un autre écrivain passer pendant qu'elle répond. */
function baseQuiLaissePasser(pendant: () => Promise<void>, lignes: unknown[]): AnyDrizzleDb {
  const chaine = {
    from: () => chaine,
    where: () => chaine,
    orderBy: async () => {
      await pendant();
      return lignes;
    },
  };
  return { select: () => chaine } as unknown as AnyDrizzleDb;
}

describe('currentContentWrittenByJob reads the disk last (#505) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a file changed while the records are being read is not ours', async () => {
    const path = join(dir, 'take.txt');
    await writeFile(path, 'mine');
    const db = baseQuiLaissePasser(
      () => writeFile(path, 'someone else'),
      [{ jobId: 'job-a', sha: sha('mine') }],
    );

    expect(await currentContentWrittenByJob(db, 'job-a', path)).toBe(false);
  });

  it('an unchanged file whose last record is this job’s is ours', async () => {
    const path = join(dir, 'still.txt');
    await writeFile(path, 'mine');
    const db = baseQuiLaissePasser(async () => {}, [{ jobId: 'job-a', sha: sha('mine') }]);

    expect(await currentContentWrittenByJob(db, 'job-a', path)).toBe(true);
  });
});
