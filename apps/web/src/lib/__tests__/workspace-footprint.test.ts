// workspace-footprint.test.ts — la taille d'un espace et le coût de son filet,
// contre une VRAIE base et un VRAI dossier (#261).
//
// @cap:travailler-sur-des-fichiers/moteur
//
// CE QUE CE FICHIER PROUVE :
//
//   1. LA TAILLE EST LUE, pas estimée. Des fichiers réels sont écrits dans le
//      dossier partagé de l'espace, et la mesure rend LEURS octets.
//   2. LA DURÉE DE LA DERNIÈRE PHOTO REMONTE, celle de la ligne la plus récente
//      de cet espace, et pas une autre.
//   3. UN DOSSIER QUI N'EXISTE PAS SE DIT, il ne pèse pas zéro. Un zéro veut
//      dire « vide », ce qui est un fait ; l'absence en est un autre.
//   4. UNE PHOTO D'AVANT LA COLONNE SE DIT AUSSI : `ms` reste `null`, et
//      l'écran écrit « not timed » au lieu d'un zéro qui se lirait
//      « instantanée ».
//   5. LES PHRASES disent le plancher quand le comptage s'est arrêté avant la
//      fin — « At least », jamais la taille nue.
//   6. LA FRAÎCHEUR EST PAR ESPACE. La photo d'un espace silencieux remonte
//      même enterrée sous deux cents photos d'un espace bavard : une absence
//      affirmée à tort est ce que l'invariant #4 refuse.
//   7. UN FICHIER à la place du dossier partagé se dit ILLISIBLE, et non vide.
//
// Mutations vérifiées :
//   - le `stat` retiré de l'action (mesure directe) → le point 3 rougit (un
//     dossier absent pèse « 0 B in 0 files ») ;
//   - `capped` ignoré dans `footprintSizeText` → le point 5 rougit ;
//   - `ms ?? null` remplacé par `ms ?? 0` → le point 4 rougit ;
//   - la lecture par espace remplacée par un balayage borné commun → le point
//     6 rougit (l'espace silencieux n'a plus de photo) ;
//   - `unreadable` changé en `absent` sur la branche « pas un dossier » → le
//     point 7 rougit.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, entities, entityMembers, jobCheckpoints } from '@nodal-agents/db';
import { footprintSizeText, footprintSnapshotText } from '../workspace-footprint.ts';
import type { WorkspaceFootprint } from '../workspace-footprint-actions.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
/** La racine que l'action lit pour composer le chemin du dossier partagé. */
let racine: string;
let jobId = '';

vi.mock('@/lib/server.ts', () => ({
  getDb: () => testDb,
  getAuthProvider: () => ({ name: 'local-trust' }),
  ACTIVE_ENTITY_COOKIE: 'nodalai_active_entity',
  applyActiveEntity: (session: { userId: string; entityId?: string }) => ({
    ...session,
    entityId: seed?.entityId ?? session.entityId ?? '',
  }),
}));

vi.mock('next/headers', () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ set: () => {}, get: () => null, delete: () => {} }),
}));

vi.mock('@nodal-agents/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/auth')>();
  return {
    ...actual,
    requireAuth: async () => ({
      userId: seed?.userId ?? 'mock-user-id',
      entityId: seed?.entityId ?? 'mock-entity-id',
    }),
  };
});

const actions = () => import('../workspace-footprint-actions.ts');

/** La ligne de l'espace semé, telle que l'action la rend. */
async function empreinte(): Promise<WorkspaceFootprint> {
  const { listWorkspaceFootprintsAction } = await actions();
  const r = await listWorkspaceFootprintsAction();
  if (!r.ok) throw new Error(r.message);
  const ligne = r.data.find((f) => f.workspaceId === seed.entityId);
  if (ligne === undefined) throw new Error('l’espace semé est absent de la lecture');
  return ligne;
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  // `seedMinimal` ne pose pas d'appartenance, et c'est par elle que la lecture
  // borne les espaces d'une personne — la même frontière que la liste des
  // réglages.
  await testDb
    .insert(entityMembers)
    .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });

  racine = await mkdtemp(join(tmpdir(), 'nodal-footprint-'));
  // La MÊME racine que le runner : l'action compose
  // `<racine>/<espace>/shared`, et c'est ce dossier-là qu'elle mesure.
  process.env['NODALAI_WORKSPACES_ROOT'] = racine;

  const [job] = await testDb
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'dashboard',
      task: 'écrire un fichier',
      status: 'completed',
    })
    .returning({ id: agentJobs.id });
  jobId = job!.id;
});

afterAll(async () => {
  delete process.env['NODALAI_WORKSPACES_ROOT'];
  await rm(racine, { recursive: true, force: true }).catch(() => {});
});

describe('la taille d’un espace et le coût de son filet @cap:travailler-sur-des-fichiers/moteur', () => {
  it('dit l’ABSENCE du dossier partagé plutôt que de le peser zéro', async () => {
    const vu = await empreinte();
    expect(vu.measure, 'un dossier inexistant a été mesuré').toBeNull();
    expect(vu.unmeasured).toBe('absent');
    expect(footprintSizeText(vu)).toBe('No shared folder yet');
    // Et rien n'a encore photographié : là aussi, une phrase, pas un zéro.
    expect(vu.lastSnapshot).toBeNull();
    expect(footprintSnapshotText(vu)).toBe('No safety snapshot yet');
  });

  it('compte les octets RÉELLEMENT sur le disque', async () => {
    const partage = join(racine, seed.entityId, 'shared');
    await mkdir(partage, { recursive: true });
    await writeFile(join(partage, 'a.txt'), 'x'.repeat(1000), 'utf8');
    await writeFile(join(partage, 'b.txt'), 'y'.repeat(500), 'utf8');

    const vu = await empreinte();
    expect(vu.unmeasured).toBeNull();
    expect(vu.measure, 'le dossier n’a pas été mesuré').not.toBeNull();
    // LES OCTETS ÉCRITS, pas un ordre de grandeur.
    expect(vu.measure!.bytes).toBe(1500);
    expect(vu.measure!.files).toBe(2);
    expect(vu.measure!.capped).toBe(false);
    expect(footprintSizeText(vu)).toBe('1.5 KB in 2 files');
  });

  it('remonte la durée de la DERNIÈRE photo de cet espace', async () => {
    await testDb.insert(jobCheckpoints).values([
      {
        jobId,
        turn: 1,
        workspace: join(racine, seed.entityId, 'shared'),
        sha: 'aaaaaaa',
        snapshotMs: 800,
        takenAt: new Date('2026-09-20T10:00:00Z'),
      },
      {
        jobId,
        turn: 2,
        workspace: join(racine, seed.entityId, 'shared'),
        sha: 'bbbbbbb',
        snapshotMs: 24_130,
        takenAt: new Date('2026-09-20T12:00:00Z'),
      },
    ]);

    const vu = await empreinte();
    expect(vu.lastSnapshot, 'aucune photo remontée').not.toBeNull();
    // LA PLUS RÉCENTE, pas la première écrite.
    expect(vu.lastSnapshot!.ms).toBe(24_130);
    expect(footprintSnapshotText(vu)).toBe('Last snapshot took 24.1 s');
  });

  it('dit ILLISIBLE quand un FICHIER occupe le chemin du dossier partagé', async () => {
    // `measureWorkspace` rendrait `{0, 0, false}` : c'est le `stat` préalable
    // qui fait la différence entre « vide », « absent » et « pas un dossier »
    // (revue C, passe 1, mutation (b) non couverte).
    const [e] = await testDb
      .insert(entities)
      .values({ userId: seed.userId, name: 'Fichier', slug: `fichier-${Date.now()}` })
      .returning({ id: entities.id });
    await testDb
      .insert(entityMembers)
      .values({ entityId: e!.id, userId: seed.userId, role: 'owner' });
    await mkdir(join(racine, e!.id), { recursive: true });
    await writeFile(join(racine, e!.id, 'shared'), 'je ne suis pas un dossier', 'utf8');

    const { listWorkspaceFootprintsAction } = await actions();
    const r = await listWorkspaceFootprintsAction();
    if (!r.ok) throw new Error(r.message);
    const sien = r.data.find((f) => f.workspaceId === e!.id);
    expect(sien!.measure, 'un fichier a été mesuré comme un dossier').toBeNull();
    expect(sien!.unmeasured).toBe('unreadable');
    expect(footprintSizeText(sien!)).toBe('Size unreadable');
  });

  it('dit « pas chronométrée » pour une photo d’avant la colonne', async () => {
    await testDb.insert(jobCheckpoints).values({
      jobId,
      turn: 3,
      workspace: join(racine, seed.entityId, 'shared'),
      sha: 'ccccccc',
      takenAt: new Date('2026-09-20T14:00:00Z'),
    });

    const vu = await empreinte();
    expect(vu.lastSnapshot!.ms, 'une photo non mesurée a reçu une durée').toBeNull();
    expect(footprintSnapshotText(vu)).toBe('Last snapshot not timed');
  });
});

// ─── Les phrases, sur des faits posés à la main ───────────────────────────────

describe('les phrases d’une empreinte @cap:travailler-sur-des-fichiers/moteur', () => {
  const base: WorkspaceFootprint = {
    workspaceId: 'w',
    path: 'C:/partage',
    measure: null,
    unmeasured: null,
    lastSnapshot: null,
  };

  it('dit le PLANCHER quand le comptage s’est arrêté avant la fin', () => {
    const vu: WorkspaceFootprint = {
      ...base,
      measure: { bytes: 3_543_348_428, files: 50_000, capped: true, sizeLabel: '3.3 GB' },
    };
    // « At least » porte sur les deux chiffres : le comptage s'est arrêté, donc
    // ni la taille ni le nombre de fichiers ne sont complets.
    expect(footprintSizeText(vu)).toBe('At least 3.3 GB in 50000 files');
  });

  it('ne dit PAS le plancher quand le comptage est allé au bout', () => {
    const vu: WorkspaceFootprint = {
      ...base,
      measure: { bytes: 1024, files: 1, capped: false, sizeLabel: '1 KB' },
    };
    expect(footprintSizeText(vu)).toBe('1 KB in 1 file');
  });

  it('distingue un dossier illisible d’un dossier absent', () => {
    expect(footprintSizeText({ ...base, unmeasured: 'unreadable' })).toBe('Size unreadable');
    expect(footprintSizeText({ ...base, unmeasured: 'absent' })).toBe('No shared folder yet');
  });

  it('donne les millisecondes sous la seconde', () => {
    const vu: WorkspaceFootprint = {
      ...base,
      lastSnapshot: { ms: 640, takenAt: new Date('2026-09-20T12:00:00Z'), workspace: 'C:/p' },
    };
    expect(footprintSnapshotText(vu)).toBe('Last snapshot took 640 ms');
  });
});

// ─── La fraîcheur, par espace ────────────────────────────────────────────────
//
// EN DERNIER, et son commentaire le dit : ce cas sème deux cents photos, qui
// rendraient faux tout cas postérieur attendant « aucune photo ».

/** Un SECOND espace de la même personne, silencieux, et sa photo à lui. */
const voisin = { entityId: '', jobId: '', partage: '' };

describe('la fraîcheur par espace @cap:travailler-sur-des-fichiers/moteur', () => {
  it('rend la photo d’un espace SILENCIEUX, même noyée sous celles d’un actif', async () => {
    // ⚠️ LE CAS QUI A FAIT RATER LA PREMIÈRE VERSION (revue C, passe 1, C1).
    // La lecture prenait les deux cents lignes les plus récentes toutes
    // entités confondues, puis gardait la première de chaque espace : la photo
    // d'un espace calme, enterrée sous celles d'un espace bavard, disparaissait
    // et l'écran affirmait « No safety snapshot yet ». Une absence AFFIRMÉE à
    // tort est ce que l'invariant #4 refuse.
    const [e] = await testDb
      .insert(entities)
      .values({ userId: seed.userId, name: 'Voisin', slug: `voisin-${Date.now()}` })
      .returning({ id: entities.id });
    voisin.entityId = e!.id;
    await testDb
      .insert(entityMembers)
      .values({ entityId: voisin.entityId, userId: seed.userId, role: 'owner' });
    const [a] = await testDb
      .insert(agents)
      .values({
        entityId: voisin.entityId,
        name: 'Agent',
        slug: `agent-voisin-${Date.now()}`,
        personality: '',
      })
      .returning({ id: agents.id });
    const [j] = await testDb
      .insert(agentJobs)
      .values({
        entityId: voisin.entityId,
        agentId: a!.id,
        channel: 'dashboard',
        task: 'une tâche',
        status: 'completed',
      })
      .returning({ id: agentJobs.id });
    voisin.jobId = j!.id;
    voisin.partage = join(racine, voisin.entityId, 'shared');

    // SA photo, ANCIENNE.
    await testDb.insert(jobCheckpoints).values({
      jobId: voisin.jobId,
      turn: 1,
      workspace: voisin.partage,
      sha: 'ddddddd',
      snapshotMs: 1500,
      takenAt: new Date('2026-01-01T00:00:00Z'),
    });

    // Et DEUX CENTS photos plus récentes de l'espace bavard, qui enterraient
    // la sienne.
    await testDb.insert(jobCheckpoints).values(
      Array.from({ length: 200 }, (_, i) => ({
        jobId,
        turn: 1000 + i,
        workspace: join(racine, seed.entityId, 'shared'),
        sha: 'eeeeeee',
        snapshotMs: 100 + i,
        takenAt: new Date(Date.UTC(2026, 8, 20, 0, 0, i)),
      })),
    );

    const { listWorkspaceFootprintsAction } = await actions();
    const r = await listWorkspaceFootprintsAction();
    if (!r.ok) throw new Error(r.message);
    const sien = r.data.find((f) => f.workspaceId === voisin.entityId);
    expect(sien, 'l’espace voisin est absent de la lecture').toBeDefined();
    expect(sien!.lastSnapshot, 'la photo de l’espace silencieux a disparu').not.toBeNull();
    expect(sien!.lastSnapshot!.ms).toBe(1500);
    expect(footprintSnapshotText(sien!)).toBe('Last snapshot took 1.5 s');
  });
});
