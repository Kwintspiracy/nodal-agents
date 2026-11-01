// constat-observed-merge.test.ts — deux constats du même chemin, dans le même
// appel, décrivent le MÊME état d'après : l'empreinte observée de l'un ne se
// perd pas parce que l'autre est arrivé le premier (revue A de la PR #919,
// passe 5).
//
// Le défaut : `rangerConstats` gardait la première ligne par chemin. Le seam
// fusionne `[...disque, ...git.fallbackWrites]` : une ligne disque sans
// empreinte (une lecture d'après qui a échoué) masquait la ligne de
// l'instantané de checkpoint qui portait l'empreinte exacte — identité
// inconnue, faux rouge à la finalisation.
//
// Ce que ce fichier prouve, sur la ligne `constated_writes` relue en base :
//   1. ligne sans empreinte puis ligne avec : l'empreinte est gardée ;
//   2. l'ordre inverse : l'empreinte est gardée, la première ligne garde son
//      genre et sa source ;
//   3. `constatSurDisque` rend l'empreinte d'APRÈS l'appel, celle du contenu
//      que le constat a lu, pas celle de l'instantané d'avant.
//
// Mutations vérifiées : « la première gagne » remise → 1 rougit ;
// `constatSurDisque` sans empreinte → 3 rougit.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { constatedWrites, eq } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { snapshotFileTargets } from '../verification/observed';
import { constatSurDisque, recordConstatedWrites } from '../verification/record-constat';

let db: TestDb;
let jobId: string;
let dir: string;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  jobId = (await seedMinimal(db)).jobId;
  dir = normalizePath(await mkdtemp(join(tmpdir(), 'nodal-merge-')));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function ligne(path: string, turn: number) {
  const rows = await db.select().from(constatedWrites).where(eq(constatedWrites.jobId, jobId));
  return rows.filter((r) => r.turn === turn && r.path.endsWith(path.slice(path.lastIndexOf('/'))));
}

describe('constats du même chemin, même appel : les champs se fusionnent (#919) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('1. une ligne sans empreinte puis une ligne avec : l’empreinte est gardée', async () => {
    const path = `${dir}/a.txt`;
    await writeFile(path, 'A');
    await recordConstatedWrites({
      db,
      jobId,
      turn: 1,
      lignes: [
        { path, kind: 'modified', constatedBy: 'disk' },
        { path, kind: 'added', constatedBy: 'disk', observedSha256: sha('A') },
      ],
    });
    const rows = await ligne(path, 1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedSha256).toBe(sha('A'));
  });

  it('2. l’ordre inverse : l’empreinte est gardée, la première ligne garde son genre', async () => {
    const path = `${dir}/b.txt`;
    await writeFile(path, 'B');
    await recordConstatedWrites({
      db,
      jobId,
      turn: 2,
      lignes: [
        { path, kind: 'added', constatedBy: 'git', observedSha256: sha('B') },
        { path, kind: 'modified', constatedBy: 'disk' },
      ],
    });
    const rows = await ligne(path, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.observedSha256).toBe(sha('B'));
    expect(rows[0]!.changeKind).toBe('added');
    expect(rows[0]!.constatedBy).toBe('git');
  });

  it('3. constatSurDisque rend l’empreinte d’APRÈS l’appel', async () => {
    const path = `${dir}/c.txt`;
    await writeFile(path, 'avant');
    const avant = await snapshotFileTargets([{ kind: 'file', path, deliverableType: 'document' }]);
    await writeFile(path, 'apres');
    expect(await constatSurDisque(path, avant)).toEqual({
      path,
      kind: 'modified',
      observedSha256: sha('apres'),
    });
  });
});
