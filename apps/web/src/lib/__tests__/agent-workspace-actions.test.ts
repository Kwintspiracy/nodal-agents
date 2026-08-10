// agent-workspace-actions.test.ts — les répertoires que l'agent a le droit de toucher.
//
// Ces deux actions sont les seules du lot restant qui sortent de la base : l'une
// déclare un dossier du disque comme accessible à un agent, l'autre y écrit un
// fichier. Une régression ici ne se voit pas dans l'interface — elle se voit
// dans le système de fichiers de Quentin, et trop tard.
//
// D'où deux règles tenues tout du long :
//   - on asserte sur la LIGNE écrite et sur le FICHIER réellement posé sur le
//     disque (contenu relu, octets comptés), jamais sur `result.ok` ;
//   - les gardes passent avant les chemins heureux. Le contrat qui compte n'est
//     pas « l'upload marche », c'est « l'upload ne sort JAMAIS du dossier
//     déclaré », et il se prouve en tentant d'en sortir.
//
// Sur le franchissement de dossier : `resolveWorkspacePath` réduit le nom reçu à
// son `basename` AVANT de résoudre. Un nom comme `../../evil.txt` n'échoue donc
// pas — il est aplati en `evil.txt` et atterrit dans le workspace. C'est un
// contrat parfaitement défendable, mais il fallait le figer : le test vérifie
// que le fichier est bien dans le dossier ET qu'il n'y a rien au-dessus.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, agents, agentWorkspaces, entities, users } from '@nodal-agents/db';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Racine jetable : tout ce que les tests d'upload écrivent vit là-dessous. */
let racine = '';

/** L'espace d'à côté — jamais celui de la session. */
const voisin = { entityId: '', agentId: '' };

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

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));

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

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);
  racine = await mkdtemp(join(tmpdir(), 'nodal-ws-test-'));

  const [autreUser] = await testDb
    .insert(users)
    .values({ email: `voisin-ws-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await testDb
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-ws-${Date.now()}`,
    })
    .returning();
  voisin.entityId = autreEntite!.id;

  const [autreAgent] = await testDb
    .insert(agents)
    .values({
      entityId: voisin.entityId,
      name: 'Agent du voisin',
      slug: `agent-voisin-${Date.now()}`,
      personality: 'Pas le vôtre.',
    })
    .returning();
  voisin.agentId = autreAgent!.id;
});

afterAll(async () => {
  if (racine) await rm(racine, { recursive: true, force: true });
});

/** Les lignes agent_workspaces d'un agent, dans l'ordre du label. */
async function workspacesDe(agentId: string) {
  return testDb
    .select()
    .from(agentWorkspaces)
    .where(eq(agentWorkspaces.agentId, agentId))
    .orderBy(agentWorkspaces.label);
}

describe('addAgentWorkspaceAction', () => {
  it('écrit la ligne — label découpé, chemin gardé, entité recopiée depuis l’agent', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');
    const chemin = join(racine, 'notes');

    const result = await addAgentWorkspaceAction(seed.agentId, '  Notes  ', chemin);
    expect(result.ok).toBe(true);

    const [ligne] = await testDb
      .select()
      .from(agentWorkspaces)
      .where(and(eq(agentWorkspaces.agentId, seed.agentId), eq(agentWorkspaces.label, 'Notes')));

    expect(ligne, 'aucune ligne écrite pour le label découpé').toBeDefined();
    expect(ligne!.path).toBe(chemin);
    expect(ligne!.entityId, 'l’entité doit être recopiée depuis l’agent').toBe(seed.entityId);
    expect(ligne!.position).toBe(0);
    if (result.ok) expect(result.data.id).toBe(ligne!.id);
  });

  it('refuse l’agent d’un AUTRE espace — et ne lui ajoute aucun répertoire', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');

    const result = await addAgentWorkspaceAction(voisin.agentId, 'Intrusion', join(racine, 'chez'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(
      await workspacesDe(voisin.agentId),
      'un répertoire a été greffé sur l’agent du voisin',
    ).toHaveLength(0);
  });

  it('refuse un chemin relatif — c’est la garde qui empêche d’écrire n’importe où', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');

    const result = await addAgentWorkspaceAction(seed.agentId, 'Relatif', 'notes/sous-dossier');

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
    const lignes = await workspacesDe(seed.agentId);
    expect(lignes.some((l) => l.label === 'Relatif')).toBe(false);
  });

  it('accepte les deux formes absolues du parc — POSIX et Windows', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');

    const posix = await addAgentWorkspaceAction(seed.agentId, 'Posix', '/srv/notes');
    const windows = await addAgentWorkspaceAction(
      seed.agentId,
      'Windows',
      'C:\\Users\\kwint\\docs',
    );

    expect(posix.ok, 'un chemin POSIX absolu a été refusé').toBe(true);
    expect(windows.ok, 'un chemin Windows absolu a été refusé').toBe(true);

    const lignes = await workspacesDe(seed.agentId);
    expect(lignes.find((l) => l.label === 'Posix')?.path).toBe('/srv/notes');
    expect(lignes.find((l) => l.label === 'Windows')?.path).toBe('C:\\Users\\kwint\\docs');
  });

  it('refuse un agentId qui n’est pas un GUID', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');

    const result = await addAgentWorkspaceAction('pas-un-guid', 'Peu importe', join(racine, 'x'));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });

  it('refuse un label vide, et un label de plus de 80 caractères', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');

    const vide = await addAgentWorkspaceAction(seed.agentId, '', join(racine, 'vide'));
    const tropLong = await addAgentWorkspaceAction(
      seed.agentId,
      'x'.repeat(81),
      join(racine, 'long'),
    );

    expect(vide.ok).toBe(false);
    expect(tropLong.ok).toBe(false);
    const lignes = await workspacesDe(seed.agentId);
    expect(lignes.some((l) => l.label.length > 80)).toBe(false);
  });

  it('le même label deux fois : conflit annoncé, et UNE seule ligne en base', async () => {
    const { addAgentWorkspaceAction } = await import('../actions.ts');
    const chemin = join(racine, 'unique');

    const premier = await addAgentWorkspaceAction(seed.agentId, 'Unique', chemin);
    const second = await addAgentWorkspaceAction(seed.agentId, 'Unique', join(racine, 'ailleurs'));

    expect(premier.ok).toBe(true);
    expect(second.ok, 'le doublon de label a été accepté').toBe(false);
    if (!second.ok) expect(second.code).toBe('conflict');

    const lignes = (await workspacesDe(seed.agentId)).filter((l) => l.label === 'Unique');
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.path, 'le second appel a écrasé le chemin du premier').toBe(chemin);
  });
});

describe('uploadToWorkspaceAction', () => {
  /** Déclare un workspace réel sur le disque et rend son chemin. */
  async function workspaceSurDisque(label: string): Promise<string> {
    const chemin = join(racine, label);
    await mkdir(chemin, { recursive: true });
    await testDb.insert(agentWorkspaces).values({
      agentId: seed.agentId,
      entityId: seed.entityId,
      label,
      path: chemin,
    });
    return chemin;
  }

  function fichier(nom: string, contenu: string, type: string): FormData {
    const fd = new FormData();
    fd.append('file', new File([contenu], nom, { type }));
    return fd;
  }

  it('écrit le fichier sur le disque, avec son contenu exact, et ne laisse aucun .tmp', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('depot');
    const contenu = 'Ligne une.\nLigne deux.\n';

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'depot',
      fichier('note.md', contenu, 'text/markdown'),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.filename).toBe('note.md');
      expect(result.data.bytes).toBe(Buffer.byteLength(contenu));
    }

    expect(await readFile(join(chemin, 'note.md'), 'utf8')).toBe(contenu);

    const restes = (await readdir(chemin)).filter((n) => n.endsWith('.tmp'));
    expect(restes, 'un fichier temporaire a survécu à l’écriture').toEqual([]);
  });

  it('un nom qui remonte l’arborescence est aplati — le fichier atterrit DANS le dossier', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('borne');
    const auDessus = join(dirname(chemin), 'evade.txt');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'borne',
      fichier('../../evade.txt', 'charge', 'text/plain'),
    );

    // Deux affirmations, et il faut les deux. « Ça ne sort pas » seul serait
    // vrai même si l'action refusait tout en bloc : ce test-là ne contraindrait
    // plus rien. On fige donc l'issue exacte — aplatissement, puis écriture.
    expect(existsSync(auDessus), 'un fichier a été écrit AU-DESSUS du workspace').toBe(false);
    expect(result.ok, result.ok ? '' : `aplatissement refusé : ${result.message}`).toBe(true);
    if (result.ok) expect(result.data.filename).toBe('evade.txt');
    expect(await readdir(chemin)).toEqual(['evade.txt']);
    expect(await readFile(join(chemin, 'evade.txt'), 'utf8')).toBe('charge');
  });

  it('un nom porteur de sous-dossiers est aplati lui aussi — pas d’arborescence créée', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('aplati');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'aplati',
      fichier('sous/dossier/note.txt', 'contenu', 'text/plain'),
    );

    expect(result.ok, result.ok ? '' : result.message).toBe(true);
    if (result.ok) expect(result.data.filename).toBe('note.txt');
    expect(await readdir(chemin), 'un sous-dossier a été créé dans le workspace').toEqual([
      'note.txt',
    ]);
  });

  it('refuse un nom commençant par un point — pas de .env déposé dans un workspace', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('cache');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'cache',
      fichier('.env', 'SECRET=1', 'text/plain'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('path_traversal_blocked');
    expect(existsSync(join(chemin, '.env'))).toBe(false);
  });

  it('refuse une extension hors liste — et n’écrit rien', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('filtre');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'filtre',
      fichier('charge.exe', 'MZ', 'application/x-msdownload'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('unsupported_file_type');
    expect(await readdir(chemin)).toEqual([]);
  });

  it('octet-stream ne sert pas de passe-droit : l’extension seule décide', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('binaire');

    const refuse = await uploadToWorkspaceAction(
      seed.agentId,
      'binaire',
      fichier('charge.exe', 'MZ', 'application/octet-stream'),
    );
    const accepte = await uploadToWorkspaceAction(
      seed.agentId,
      'binaire',
      fichier('tableau.csv', 'a,b\n1,2\n', 'application/octet-stream'),
    );

    expect(refuse.ok, 'un .exe est passé sous couvert d’octet-stream').toBe(false);
    expect(accepte.ok, 'un .csv légitime a été refusé').toBe(true);
    expect(await readdir(chemin)).toEqual(['tableau.csv']);
  });

  it('refuse un fichier au-delà du plafond de 25 Mio', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('plafond');

    const fd = new FormData();
    fd.append(
      'file',
      new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'gros.txt', { type: 'text/plain' }),
    );

    const result = await uploadToWorkspaceAction(seed.agentId, 'plafond', fd);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('file_too_large');
    expect(await readdir(chemin)).toEqual([]);
  });

  it('refuse l’agent d’un autre espace — même en visant un workspace qui existe', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const cheminVoisin = join(racine, 'chez-le-voisin');
    await mkdir(cheminVoisin, { recursive: true });
    await testDb.insert(agentWorkspaces).values({
      agentId: voisin.agentId,
      entityId: voisin.entityId,
      label: 'prive',
      path: cheminVoisin,
    });

    const result = await uploadToWorkspaceAction(
      voisin.agentId,
      'prive',
      fichier('intrus.txt', 'charge', 'text/plain'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
    expect(await readdir(cheminVoisin), 'un fichier a été déposé chez le voisin').toEqual([]);
  });

  it('refuse un libellé de workspace inconnu pour cet agent', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'workspace-qui-n-existe-pas',
      fichier('note.txt', 'x', 'text/plain'),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_found');
  });

  it('refuse un FormData sans champ "file"', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    await workspaceSurDisque('vide-form');

    const fd = new FormData();
    fd.append('autre', 'valeur');

    const result = await uploadToWorkspaceAction(seed.agentId, 'vide-form', fd);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('validation_failed');
  });

  it('remplace un fichier existant sans laisser de résidu', async () => {
    const { uploadToWorkspaceAction } = await import('../actions.ts');
    const chemin = await workspaceSurDisque('remplace');
    await writeFile(join(chemin, 'note.txt'), 'ancienne version');

    const result = await uploadToWorkspaceAction(
      seed.agentId,
      'remplace',
      fichier('note.txt', 'nouvelle version', 'text/plain'),
    );

    expect(result.ok).toBe(true);
    expect(await readFile(join(chemin, 'note.txt'), 'utf8')).toBe('nouvelle version');
    expect(await readdir(chemin)).toEqual(['note.txt']);
  });
});
