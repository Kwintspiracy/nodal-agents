// skills-lifecycle.test.ts — les trois routes qui touchent une skill DÉJÀ
// installée : uninstall, update, acknowledge-update.
//
// La garde centrale est nommée dans le code lui-même (F-6, audit #2) : le slug
// d'une skill est unique par (entity_id, slug), pas globalement. Une recherche
// non scopée laisserait donc l'espace A désinstaller la skill de même slug de
// l'espace B — et EFFACER SES FICHIERS au passage. C'est ce que ce fichier
// vérifie en premier, en installant volontairement le même slug des deux côtés.
//
// Chaque route porte sa propre copie de la vérification du secret runner. Elles
// sont donc éprouvées une par une : une garde copiée-collée se retire aussi une
// par une.
//
// Ce qui n'est PAS couvert ici, et pourquoi : les chemins heureux d'`update` et
// d'`acknowledge-update` retéléchargent la source depuis GitHub. Ils demandent
// le réseau, donc un test d'intégration, pas un test unitaire. Tous les refus
// qui précèdent le téléchargement le sont.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, agentSkills, entities, users } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { entityId: string; agentId: string };
let foreignEntityId: string;

const WORKER_SECRET = 'test-secret';
/** Le même slug des deux côtés : tout l'enjeu de la garde F-6. */
const SLUG_PARTAGE = 'pdf-toolkit';

const testEnv: RunnerEnv = {
  DATABASE_URL: 'test://local',
  LLM_PROVIDER: 'anthropic',
  LLM_MODEL: 'claude-sonnet-4-6-20260217',
  LLM_API_KEY: 'test-key',
  LLM_BASE_URL: undefined,
  EMBEDDING_PROVIDER: 'keyword',
  EMBEDDING_MODEL: undefined,
  EMBEDDING_BASE_URL: undefined,
  AUTH_MODE: 'local-trust',
  WORKER_SECRET,
  BEARER_TOKEN: undefined,
  PORT: 3099,
  BIND: '127.0.0.1',
  APP_URL: 'http://localhost:3099',
  NODE_ENV: 'test',
  REFLECTION_ENABLED: 'false',
  REFLECTION_MAX_PER_HOUR: 6,
  REFLECTION_MAX_TURNS: 3,
  CURATOR_STALE_DAYS: 30,
  CURATOR_ARCHIVE_DAYS: 90,
  CURATOR_MIN_SKILLS: 5,
  CURATOR_INTERVAL_DAYS: 7,
  CURATOR_MAX_TURNS: 4,
  CURATOR_MEMORY_STALE_DAYS: 60,
  CURATOR_MEMORY_IMPORTANCE_MAX: 2,
  CURATOR_MEMORY_MIN: 8,
  MEMORY_CURATION_ENABLED: '',
  RETENTION_DAYS: 0,
  SKILL_UPDATE_CHECK_INTERVAL_HOURS: 24,
  SKILL_UPDATE_CHECK_BATCH_SIZE: 10,
  NODALAI_APPROVAL_GRACE_MS: 0,
};

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  const s = await seedMinimal(db);
  seed = { entityId: s.entityId, agentId: s.agentId };

  const [autreUser] = await db
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await db
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Entité voisine',
      slug: `voisine-${Date.now()}`,
    })
    .returning();
  foreignEntityId = autreEntite!.id;

  const registry = createToolRegistry();
  registerBuiltins(registry);

  const deps: RunnerDeps = {
    db: db as RunnerDeps['db'],
    llmClient: createLlmClient({
      provider: 'anthropic',
      model: 'claude-sonnet-4-6-20260217',
      apiKey: 'test-key',
    }),
    embeddingClient: createEmbeddingClient({ provider: 'keyword' }),
    registry,
    authProvider: new LocalTrustProvider(),
    close: async () => {},
  };

  app = createApp(deps, testEnv);
});

async function post(
  route: 'uninstall' | 'update' | 'acknowledge-update',
  body: unknown,
  opts: { secret?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = opts.secret === undefined ? WORKER_SECRET : opts.secret;
  if (secret !== null) headers['Authorization'] = `Bearer ${secret}`;
  return app.fetch(
    new Request(`http://localhost:3099/api/skills/${route}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** (Ré)installe la paire de skills homonymes, une par espace. */
async function seedPaireHomonyme() {
  await db.delete(agentSkills).where(eq(agentSkills.slug, SLUG_PARTAGE));
  await db.insert(agentSkills).values([
    {
      entityId: seed.entityId,
      name: 'PDF Toolkit',
      slug: SLUG_PARTAGE,
      content: '# la mienne',
      isCommunity: true,
      source: 'github.com/exemple/pdf-toolkit',
    },
    {
      entityId: foreignEntityId,
      name: 'PDF Toolkit',
      slug: SLUG_PARTAGE,
      content: '# celle du voisin',
      isCommunity: true,
      source: 'github.com/exemple/pdf-toolkit',
    },
  ]);
}

async function skillDe(entityId: string) {
  const [row] = await db
    .select()
    .from(agentSkills)
    .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, entityId)));
  return row;
}

beforeEach(async () => {
  await seedPaireHomonyme();
});

// ─── uninstall ───────────────────────────────────────────────────────────────

describe('POST /api/skills/uninstall', () => {
  it('désinstalle la skill de l’espace demandeur — et laisse l’homonyme du voisin', async () => {
    const res = await post('uninstall', { slug: SLUG_PARTAGE, entityId: seed.entityId });
    expect(res.status).toBe(200);

    expect(await skillDe(seed.entityId)).toBeUndefined();
    expect(
      await skillDe(foreignEntityId),
      'la skill homonyme d’un autre espace a été désinstallée',
    ).toBeDefined();
  });

  it('F-6 — un espace qui n’a PAS la skill ne peut pas désinstaller celle du voisin', async () => {
    // Le test précédent ne prouve pas la garde : quand les deux lignes
    // existent, un `limit(1)` non scopé retombe de toute façon sur la nôtre.
    // Vérifié par mutation — retirer le filtre d'entité le laissait passer.
    //
    // Le seul scénario qui discrimine est celui décrit dans le code : notre
    // espace N'A PAS la skill, le voisin l'a. Une recherche non scopée trouve
    // alors la sienne, la supprime, et efface ses fichiers.
    await db
      .delete(agentSkills)
      .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, seed.entityId)));

    const res = await post('uninstall', { slug: SLUG_PARTAGE, entityId: seed.entityId });
    expect(res.status).toBe(400);

    expect(
      await skillDe(foreignEntityId),
      'la skill d’un autre espace a été désinstallée depuis le nôtre',
    ).toBeDefined();
  });

  it('refuse une skill SYSTÈME au lieu de la supprimer', async () => {
    // Les skills système ne sont pas installées depuis une source : les retirer
    // par cette route laisserait un espace amputé sans moyen de réinstaller.
    await db
      .update(agentSkills)
      .set({ isCommunity: false })
      .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, seed.entityId)));

    const res = await post('uninstall', { slug: SLUG_PARTAGE, entityId: seed.entityId });
    expect(res.status).toBe(400);

    expect(await skillDe(seed.entityId), 'une skill système a été supprimée').toBeDefined();
  });

  it('refuse un slug inconnu sans rien toucher', async () => {
    const avant = (await db.select().from(agentSkills)).length;

    const res = await post('uninstall', { slug: 'jamais-installee', entityId: seed.entityId });
    expect(res.status).toBe(400);

    expect((await db.select().from(agentSkills)).length).toBe(avant);
  });

  it('exige le secret du runner — et ne désinstalle rien sans lui', async () => {
    const res = await post(
      'uninstall',
      { slug: SLUG_PARTAGE, entityId: seed.entityId },
      { secret: null },
    );
    expect(res.status).toBe(403);

    expect(await skillDe(seed.entityId), 'désinstallation sans authentification').toBeDefined();
  });

  it('refuse un entityId qui n’est pas un GUID', async () => {
    const res = await post('uninstall', { slug: SLUG_PARTAGE, entityId: 'pas-un-guid' });
    expect(res.status).toBe(400);
    expect(await skillDe(seed.entityId)).toBeDefined();
  });
});

// ─── update ──────────────────────────────────────────────────────────────────

describe('POST /api/skills/update', () => {
  it('exige le secret du runner', async () => {
    const res = await post(
      'update',
      { slug: SLUG_PARTAGE, entityId: seed.entityId },
      { secret: 'mauvais' },
    );
    expect(res.status).toBe(403);
  });

  it('ne trouve pas la skill d’un autre espace — la recherche est scopée', async () => {
    // On demande la mise à jour d'un slug qui n'existe QUE chez le voisin.
    await db
      .delete(agentSkills)
      .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, seed.entityId)));

    const res = await post('update', { slug: SLUG_PARTAGE, entityId: seed.entityId });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { message: string };
    expect(body.message).toContain(SLUG_PARTAGE);
  });

  it('refuse un slug inconnu avant tout téléchargement', async () => {
    const res = await post('update', { slug: 'jamais-installee', entityId: seed.entityId });
    expect(res.status).toBe(400);
  });

  it('refuse un corps incomplet', async () => {
    const res = await post('update', { slug: SLUG_PARTAGE });
    expect(res.status).toBe(400);
  });
});

// ─── acknowledge-update ──────────────────────────────────────────────────────

describe('POST /api/skills/acknowledge-update', () => {
  it('exige le secret du runner', async () => {
    const res = await post(
      'acknowledge-update',
      { slug: SLUG_PARTAGE, entityId: seed.entityId },
      { secret: null },
    );
    expect(res.status).toBe(403);
  });

  it('refuse une skill sans source — il n’y a rien à re-caler', async () => {
    // « Garder ma version » re-cale les empreintes sur la source amont : sans
    // source, l'opération n'a pas de sens et doit le dire plutôt que d'écrire
    // un état incohérent.
    await db
      .update(agentSkills)
      .set({ source: null })
      .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, seed.entityId)));

    const res = await post('acknowledge-update', {
      slug: SLUG_PARTAGE,
      entityId: seed.entityId,
    });
    expect(res.status).toBe(400);
  });

  it('ne voit pas la skill d’un autre espace', async () => {
    await db
      .delete(agentSkills)
      .where(and(eq(agentSkills.slug, SLUG_PARTAGE), eq(agentSkills.entityId, seed.entityId)));

    const res = await post('acknowledge-update', {
      slug: SLUG_PARTAGE,
      entityId: seed.entityId,
    });
    expect(res.status).toBe(400);

    // Et la ligne du voisin n'a pas bougé.
    const voisine = await skillDe(foreignEntityId);
    expect(voisine?.updateAvailable).toBe(false);
  });
});
