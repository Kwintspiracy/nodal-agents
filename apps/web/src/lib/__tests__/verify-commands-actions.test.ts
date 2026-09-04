// verify-commands-actions.test.ts — les deux gestes qui donnent un POUVOIR à
// une commande (plan « Vérifier & Corriger », T21 / D9) : écrire la séquence
// de preuve d'un projet, et approuver son manifeste.
//
// Ce qui compte, relu EN BASE après chaque geste : écrire des commandes
// efface l'approbation dans la même écriture ; approuver écrit le hash que le
// SERVEUR recalcule (le hash du client n'est qu'un jeton de concurrence) ;
// seul le propriétaire écrit, dans SON espace seulement.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, codeProjects, entities, users } from '@nodal-agents/db';
import { projectKey, hashVerificationManifest } from '@nodal-agents/shared';
import { codeProjectManifest, deriveVerifyStatus } from '../verification-display.ts';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let otherUserId: string;
let foreignEntityId: string;

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

/**
 * AUTH_MODE est figé au chargement d'`env.ts` (un `envSchema.parse` de
 * `process.env`), donc inatteignable une fois `actions.ts` importé. Ce proxy
 * rend la SEULE clé qui compte ici lisible à chaud : `isWorkspaceOwner`
 * court-circuite en local-trust (tout le monde est propriétaire), et sans ce
 * levier le cas « tiers ⇒ isOwner false » ne serait pas testable.
 */
const authState = vi.hoisted(() => ({ mode: 'local-trust' as 'local-trust' | 'local-auth' }));

vi.mock('../env.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../env.ts')>();
  return {
    ...actual,
    env: new Proxy(actual.env, {
      get: (target, prop) => (prop === 'AUTH_MODE' ? authState.mode : Reflect.get(target, prop)),
    }),
  };
});

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

const PATH = 'D:/Dev/ProofApp';
const CMDS = [
  { command: 'pnpm typecheck', timeoutSeconds: 120 },
  { command: 'pnpm test', timeoutSeconds: 600 },
];
const OTHER_CMDS = [{ command: 'pnpm lint', timeoutSeconds: 60 }];

beforeAll(async () => {
  const result = await spinUpTestDb();
  testDb = result.db;
  seed = await seedMinimal(testDb);

  const [other] = await testDb
    .insert(users)
    .values({ email: `autre-${Date.now()}@example.com` })
    .returning();
  otherUserId = other!.id;
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: otherUserId, name: 'Entité voisine', slug: `voisine-${Date.now()}` })
    .returning();
  foreignEntityId = otherEntity!.id;
});

/** Rend la session non-propriétaire le temps d'un test, puis restaure. */
async function asNonOwner(run: () => Promise<void>) {
  await testDb.update(entities).set({ userId: otherUserId }).where(eq(entities.id, seed.entityId));
  try {
    await run();
  } finally {
    await testDb
      .update(entities)
      .set({ userId: seed.userId })
      .where(eq(entities.id, seed.entityId));
  }
}

async function row(entityId = seed.entityId, path = PATH) {
  const [r] = await testDb
    .select()
    .from(codeProjects)
    .where(and(eq(codeProjects.entityId, entityId), eq(codeProjects.projectKey, projectKey(path))));
  return r ?? null;
}

async function reset() {
  await testDb.delete(codeProjects);
}

const actions = () => import('../actions.ts');

describe('setCodeProjectVerifyCommandsAction', () => {
  it('écrit la liste, et efface l’approbation DANS la même écriture', async () => {
    await reset();
    // Une ligne déjà approuvée : l'approbation doit tomber avec les nouvelles commandes.
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: PATH,
      projectKey: projectKey(PATH),
      verifyCommands: OTHER_CMDS,
      verifyApprovedManifestHash: 'v1:ancien',
      verifyApprovedAt: new Date(),
      verifyApprovedBy: seed.userId,
    });
    const { setCodeProjectVerifyCommandsAction } = await actions();
    const res = await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });
    expect(res.ok).toBe(true);
    const r = await row();
    expect(r?.verifyCommands).toEqual(CMDS);
    expect(r?.verifyApprovedManifestHash).toBeNull();
    expect(r?.verifyApprovedAt).toBeNull();
    expect(r?.verifyApprovedBy).toBeNull();
  });

  it('zod : 0 commande, 6 commandes, timeout non entier ⇒ validation_failed, aucune écriture', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction } = await actions();
    const six = Array.from({ length: 6 }, (_, i) => ({ command: `c${i}`, timeoutSeconds: 5 }));
    for (const commands of [[], six, [{ command: 'x', timeoutSeconds: 1.5 }]]) {
      const res = await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('validation_failed');
    }
    expect(await row()).toBeNull();
  });

  it('non-owner ⇒ forbidden, zéro écriture', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction } = await actions();
    await asNonOwner(async () => {
      const res = await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('forbidden');
    });
    expect(await row()).toBeNull();
  });

  it('n’écrit QUE son espace : la ligne voisine au même chemin est intacte', async () => {
    await reset();
    await testDb.insert(codeProjects).values({
      entityId: foreignEntityId,
      projectPath: PATH,
      projectKey: projectKey(PATH),
      verifyCommands: OTHER_CMDS,
    });
    const { setCodeProjectVerifyCommandsAction } = await actions();
    expect(
      (await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS })).ok,
    ).toBe(true);
    expect((await row(foreignEntityId))?.verifyCommands).toEqual(OTHER_CMDS);
    expect((await row())?.verifyCommands).toEqual(CMDS);
  });
});

describe('approveCodeProjectVerifyManifestAction', () => {
  it('approuver écrit le hash DU SERVEUR, l’approbateur et la date', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction, approveCodeProjectVerifyManifestAction } =
      await actions();
    expect(
      (await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS })).ok,
    ).toBe(true);
    const expected = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: CMDS }),
    );

    const res = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: expected,
    });
    expect(res.ok).toBe(true);
    const r = await row();
    expect(r?.verifyApprovedManifestHash).toBe(expected);
    expect(r?.verifyApprovedBy).toBe(seed.userId);
    expect(r?.verifyApprovedAt).toBeInstanceOf(Date);
  });

  it('jeton périmé ⇒ conflict, aucune colonne modifiée', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction, approveCodeProjectVerifyManifestAction } =
      await actions();
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: OTHER_CMDS });
    const staleToken = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: OTHER_CMDS }),
    );
    // Les commandes changent entre la lecture du client et son approbation.
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });

    const res = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: staleToken,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('conflict');
    const r = await row();
    expect(r?.verifyApprovedManifestHash).toBeNull();
    expect(r?.verifyApprovedAt).toBeNull();
  });

  it('un hash quelconque envoyé par le client n’est JAMAIS écrit tel quel', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction, approveCodeProjectVerifyManifestAction } =
      await actions();
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });
    const res = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: 'v1:' + 'f'.repeat(64),
    });
    expect(res.ok).toBe(false);
    expect((await row())?.verifyApprovedManifestHash).toBeNull();
  });

  it('non-owner ⇒ forbidden, zéro écriture', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction, approveCodeProjectVerifyManifestAction } =
      await actions();
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });
    const token = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: CMDS }),
    );
    await asNonOwner(async () => {
      const res = await approveCodeProjectVerifyManifestAction({
        projectPath: PATH,
        manifestHash: token,
      });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe('forbidden');
    });
    expect((await row())?.verifyApprovedManifestHash).toBeNull();
  });

  it('projet sans commandes ⇒ not_configured', async () => {
    await reset();
    const { approveCodeProjectVerifyManifestAction } = await actions();
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: PATH,
      projectKey: projectKey(PATH),
    });
    const res = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: 'v1:x',
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe('not_configured');
  });
});

describe('listCodeProjectPrefsAction — statut dérivé au serveur', () => {
  it('not_configured / pending_approval / approved, selon les colonnes', async () => {
    await reset();
    const {
      setCodeProjectVerifyCommandsAction,
      approveCodeProjectVerifyManifestAction,
      listCodeProjectPrefsAction,
    } = await actions();
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: 'D:/Dev/Nothing',
      projectKey: projectKey('D:/Dev/Nothing'),
    });
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });
    const list1 = await listCodeProjectPrefsAction();
    expect(list1.ok).toBe(true);
    if (list1.ok) {
      const byPath = Object.fromEntries(list1.data.map((p) => [p.projectPath, p.verifyStatus]));
      expect(byPath['D:/Dev/Nothing']).toBe('not_configured');
      expect(byPath[PATH]).toBe('pending_approval');
    }
    const token = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: CMDS }),
    );
    await approveCodeProjectVerifyManifestAction({ projectPath: PATH, manifestHash: token });
    const list2 = await listCodeProjectPrefsAction();
    if (list2.ok) {
      expect(list2.data.find((p) => p.projectPath === PATH)?.verifyStatus).toBe('approved');
    }
  });

  it('rend le hash COURANT comme jeton d’approbation, et null sans commandes', async () => {
    await reset();
    const { setCodeProjectVerifyCommandsAction, listCodeProjectPrefsAction } = await actions();
    await testDb.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: 'D:/Dev/Nothing',
      projectKey: projectKey('D:/Dev/Nothing'),
    });
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });

    const list = await listCodeProjectPrefsAction();
    expect(list.ok).toBe(true);
    if (!list.ok) return;

    // Recalculé ICI depuis les primitives partagées : le test ne recopie pas
    // la valeur produite par l'action, il la reconstruit.
    const expected = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: CMDS }),
    );
    const configured = list.data.find((p) => p.projectPath === PATH);
    expect(configured?.verifyManifestHash).toBe(expected);
    // Pas encore approuvé : le hash courant existe, l'approuvé non.
    expect(configured?.verifyApprovedManifestHash).toBeNull();

    expect(
      list.data.find((p) => p.projectPath === 'D:/Dev/Nothing')?.verifyManifestHash,
    ).toBeNull();
  });

  it('le jeton rendu est celui qu’accepte l’approbation, et il suit une édition', async () => {
    await reset();
    const {
      setCodeProjectVerifyCommandsAction,
      approveCodeProjectVerifyManifestAction,
      listCodeProjectPrefsAction,
    } = await actions();
    await setCodeProjectVerifyCommandsAction({ projectPath: PATH, commands: CMDS });

    const first = await listCodeProjectPrefsAction();
    const token1 = first.ok
      ? (first.data.find((p) => p.projectPath === PATH)?.verifyManifestHash ?? null)
      : null;
    expect(token1).not.toBeNull();
    const approved = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: token1!,
    });
    expect(approved.ok).toBe(true);
    expect((await row())?.verifyApprovedManifestHash).toBe(token1);

    // Éditer change le manifeste : le jeton rendu change AVEC lui, et l'ancien
    // ne vaut plus rien (c'est ce qui rend l'approbation non rejouable).
    await setCodeProjectVerifyCommandsAction({
      projectPath: PATH,
      commands: [{ command: 'pnpm typecheck', timeoutSeconds: 121 }],
    });
    const second = await listCodeProjectPrefsAction();
    const token2 = second.ok
      ? (second.data.find((p) => p.projectPath === PATH)?.verifyManifestHash ?? null)
      : null;
    expect(token2).not.toBe(token1);
    const stale = await approveCodeProjectVerifyManifestAction({
      projectPath: PATH,
      manifestHash: token1!,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('conflict');
    expect((await row())?.verifyApprovedManifestHash).toBeNull();
  });

  it('deriveVerifyStatus est pur et cohérent avec le hash partagé', () => {
    const hash = hashVerificationManifest(
      codeProjectManifest({ projectPath: PATH, verifyCommands: CMDS }),
    );
    expect(
      deriveVerifyStatus({
        projectPath: PATH,
        verifyCommands: null,
        verifyApprovedManifestHash: null,
      }),
    ).toBe('not_configured');
    expect(
      deriveVerifyStatus({
        projectPath: PATH,
        verifyCommands: CMDS,
        verifyApprovedManifestHash: null,
      }),
    ).toBe('pending_approval');
    expect(
      deriveVerifyStatus({
        projectPath: PATH,
        verifyCommands: CMDS,
        verifyApprovedManifestHash: 'v1:autre',
      }),
    ).toBe('pending_approval');
    expect(
      deriveVerifyStatus({
        projectPath: PATH,
        verifyCommands: CMDS,
        verifyApprovedManifestHash: hash,
      }),
    ).toBe('approved');
  });
});

/**
 * Le booléen qui décide si le panneau de preuve est éditable (T22). Il vient
 * du serveur, et il n'a que deux régimes : hors local-trust, l'identité est
 * comparée au propriétaire de l'espace ; en local-trust il n'y a pas
 * d'identité à distinguer, tout le monde EST le propriétaire.
 */
describe('getCodeTabOwnerAction', () => {
  it('propriétaire ⇒ true, tiers ⇒ false (hors local-trust)', async () => {
    const { getCodeTabOwnerAction } = await actions();
    authState.mode = 'local-auth';
    try {
      const mine = await getCodeTabOwnerAction();
      expect(mine.ok).toBe(true);
      if (mine.ok) expect(mine.data.isOwner).toBe(true);

      await asNonOwner(async () => {
        const theirs = await getCodeTabOwnerAction();
        expect(theirs.ok).toBe(true);
        if (theirs.ok) expect(theirs.data.isOwner).toBe(false);
      });
    } finally {
      authState.mode = 'local-trust';
    }
  });

  it('local-trust : le MÊME prédicat que les écritures — un tiers voit « owner only », comme le serveur le refuserait', async () => {
    // Pas d'exemption local-trust ici : `assertProjectOwner`, qui garde les
    // deux écritures, compare l'identité sans exemption. Un panneau qui
    // montrerait des champs actifs à une session que le serveur refuse
    // ensuite mentirait — le booléen suit donc exactement l'écriture.
    const { getCodeTabOwnerAction } = await actions();
    expect(authState.mode).toBe('local-trust');
    const mine = await getCodeTabOwnerAction();
    expect(mine.ok).toBe(true);
    if (mine.ok) expect(mine.data.isOwner).toBe(true);
    await asNonOwner(async () => {
      const res = await getCodeTabOwnerAction();
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.data.isOwner).toBe(false);
    });
  });
});
