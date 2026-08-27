// workspace-locks.test.ts — le créneau d'écriture unique, sur TOUS les dossiers
// d'une session CLI.
//
// Deux constats successifs de la revue Codex (27/08), le second créé par le
// correctif du premier :
//
//   1. le verrou vit dans une colonne texte, donc trois orthographes du même
//      dossier donnaient trois verrous dont aucun ne bloquait les autres ;
//   2. une fois la clé normalisée en base, la prise MULTIPLE dédupliquait
//      encore sur la chaîne brute — un agent ayant le même dossier attaché deux
//      fois se heurtait à lui-même et ne démarrait plus.
//
// Sur une vraie base : ce qui compte est ce que la table contient.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { workspaceLocks } from '@nodal-agents/db';
import { workspaceLockKey, WorkspaceLockedError } from '@nodal-agents/tools';
import { acquireWorkspaceLocks } from '../../cli-runtime/workspace-locks.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string };

const JOB = '00000000-0000-0000-0000-0000000000a1';
const AUTRE_JOB = '00000000-0000-0000-0000-0000000000a2';

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  await db.delete(workspaceLocks);
});

async function lignes(): Promise<string[]> {
  const rows = await db.select({ path: workspaceLocks.workspacePath }).from(workspaceLocks);
  return rows.map((r) => r.path).sort();
}

describe('acquireWorkspaceLocks', () => {
  it('le MÊME dossier écrit trois fois autrement ne prend QU’UN verrou', async () => {
    // Le cas qui bloquait l'agent : il prenait le premier verrou, puis se
    // heurtait à LUI-MÊME sur le second, rendait tout, et refusait la session.
    // Un agent arrêté par sa propre configuration, sans rien pour l'expliquer.
    const locks = await acquireWorkspaceLocks(
      db,
      ['C:/Commun', 'c:\\commun\\', 'C:/COMMUN/'],
      JOB,
      seed.agentId,
    );
    expect(await lignes(), 'trois orthographes, trois verrous').toEqual([
      workspaceLockKey('C:/Commun'),
    ]);
    await locks.release();
    expect(await lignes(), 'le verrou ne se rend pas').toEqual([]);
  });

  it('deux dossiers DIFFÉRENTS prennent bien deux verrous', async () => {
    // Le pendant : dédupliquer trop large laisserait un dossier sans protection.
    const locks = await acquireWorkspaceLocks(db, ['C:/Un', 'C:/Deux'], JOB, seed.agentId);
    expect(await lignes()).toEqual([workspaceLockKey('C:/Deux'), workspaceLockKey('C:/Un')]);
    await locks.release();
  });

  it('un dossier déjà tenu par une AUTRE session refuse, et ne laisse rien derrière', async () => {
    const premier = await acquireWorkspaceLocks(db, ['C:/Partage'], AUTRE_JOB, seed.agentId);

    // La seconde session demande deux dossiers dont un est pris : elle doit
    // échouer SANS garder le dossier libre, sinon elle bloquerait tout le monde
    // jusqu'à expiration.
    await expect(
      acquireWorkspaceLocks(db, ['C:/Libre', 'c:\\partage'], JOB, seed.agentId),
    ).rejects.toThrow(WorkspaceLockedError);
    expect(await lignes(), 'un verrou pris au passage n’a pas été rendu').toEqual([
      workspaceLockKey('C:/Partage'),
    ]);

    await premier.release();
  });

  it('l’ordre de prise est STABLE quelle que soit l’orthographe', async () => {
    // Deux sessions qui demandent les mêmes dossiers dans un ordre différent
    // doivent les prendre dans le MÊME ordre — sinon chacune tient ce que
    // l'autre attend, et les deux restent bloquées.
    const a = await acquireWorkspaceLocks(db, ['C:/B', 'C:/A'], JOB, seed.agentId);
    const ordre1 = await lignes();
    await a.release();

    const b = await acquireWorkspaceLocks(db, ['c:\\a', 'c:\\b'], AUTRE_JOB, seed.agentId);
    expect(await lignes()).toEqual(ordre1);
    await b.release();
  });
});
