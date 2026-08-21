// skills-install.test.ts — POST /api/skills/install, la surface publique du
// lot 1.
//
// Cette route installe du CODE TIERS : elle télécharge une skill depuis un
// dépôt distant et l'écrit dans le magasin de l'espace. Trois gardes la
// protègent, et chacune est le genre de chose qui se retire par inadvertance
// en refactorisant :
//
//   - le secret du runner (elle n'est appelable que par le dashboard) ;
//   - la validation du corps (un entityId non-GUID ne doit jamais atteindre
//     la couche d'installation) ;
//   - l'allowlist d'hôtes de `parseSkillSource` (GitHub, skills.sh, clawhub.ai
//     et rien d'autre).
//
// Le garde Origin/Host qui ferme `/api/*` aux origines étrangères est déjà
// éprouvé — et prouvé antérieur à l'authentification — dans
// `trusted-origin.test.ts` ; il n'est pas redoublé ici.
//
// Les tests sont hermétiques : aucun n'atteint le réseau. Le chemin refusé
// s'arrête avant tout téléchargement, ce qui est justement ce qu'on veut
// prouver.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentSkills } from '@nodal-agents/db';
import { createToolRegistry, registerBuiltins } from '@nodal-agents/tools';
import { createLlmClient, createEmbeddingClient } from '@nodal-agents/llm';
import { LocalTrustProvider } from '@nodal-agents/auth';
import { createApp } from '../../server.ts';
import type { RunnerDeps } from '../../deps.ts';
import type { RunnerEnv } from '../../env.ts';

let db: TestDb;
let app: ReturnType<typeof createApp>;
let seed: { entityId: string; agentId: string };

const WORKER_SECRET = 'test-secret';

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

/** POST sur la route, avec les en-têtes d'un appel serveur-à-serveur légitime. */
async function post(body: unknown, opts: { secret?: string | null } = {}): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const secret = opts.secret === undefined ? WORKER_SECRET : opts.secret;
  if (secret !== null) headers['Authorization'] = `Bearer ${secret}`;
  return app.fetch(
    new Request('http://localhost:3099/api/skills/install', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}

async function skillCount() {
  return (await db.select().from(agentSkills)).length;
}

// ─── Le secret du runner ─────────────────────────────────────────────────────

describe('POST /api/skills/install — authentification', () => {
  it('refuse une requête SANS en-tête Authorization', async () => {
    const avant = await skillCount();

    const res = await post(
      { source: 'github.com/exemple/skill', entityId: seed.entityId },
      { secret: null },
    );
    expect(res.status).toBe(403);

    expect(await skillCount(), 'une skill a été installée sans secret').toBe(avant);
  });

  it('refuse un secret ERRONÉ', async () => {
    const res = await post(
      { source: 'github.com/exemple/skill', entityId: seed.entityId },
      { secret: 'mauvais-secret' },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'invalid_worker_secret' });
  });

  it('refuse un secret de la bonne longueur mais faux — pas de comparaison partielle', async () => {
    // Le secret attendu fait 11 caractères ; celui-ci aussi. Une comparaison
    // par préfixe ou par longueur passerait.
    const res = await post(
      { source: 'github.com/exemple/skill', entityId: seed.entityId },
      { secret: 'test-secrez' },
    );
    expect(res.status).toBe(403);
  });

  it('vérifie le secret AVANT de regarder le corps', async () => {
    // Un corps invalide ne doit pas renvoyer 400 à un appelant non authentifié :
    // ce serait un oracle sur la forme attendue de la requête.
    const res = await post({ nimporte: 'quoi' }, { secret: null });
    expect(res.status).toBe(403);
  });
});

// ─── Validation du corps ─────────────────────────────────────────────────────

describe('POST /api/skills/install — validation', () => {
  it('refuse un entityId qui n’est pas un GUID', async () => {
    const res = await post({ source: 'github.com/exemple/skill', entityId: 'pas-un-guid' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'invalid_request' });
  });

  it('refuse une source vide', async () => {
    const res = await post({ source: '', entityId: seed.entityId });
    expect(res.status).toBe(400);
  });

  it('refuse une source démesurée plutôt que de la transmettre', async () => {
    const res = await post({ source: 'g'.repeat(2049), entityId: seed.entityId });
    expect(res.status).toBe(400);
  });

  it('refuse un corps qui n’est pas du JSON', async () => {
    const res = await post('{ ceci n’est pas du json', {});
    expect(res.status).toBe(400);
  });

  it('refuse un corps sans les champs attendus', async () => {
    const res = await post({});
    expect(res.status).toBe(400);
  });
});

// ─── L'allowlist d'hôtes ─────────────────────────────────────────────────────

describe('POST /api/skills/install — provenance du code installé', () => {
  it('refuse un hôte hors allowlist AVANT tout téléchargement', async () => {
    // La garde qui compte : la route installe du code tiers, et la liste des
    // origines acceptables est la seule chose qui décide de qui.
    const avant = await skillCount();

    const res = await post({ source: 'https://depot-hostile.test/skill', entityId: seed.entityId });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { ok: boolean; error: string; message: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('install_failed');
    // Le message nomme les hôtes acceptés — c'est ce que l'utilisateur lit.
    expect(body.message).toContain('depot-hostile.test');

    expect(await skillCount(), 'une skill d’un hôte non autorisé a été installée').toBe(avant);
  });

  it('refuse aussi la forme sans schéma, qui passe par un second parcours', async () => {
    // `depot-hostile.test/x` est ré-analysé en `https://depot-hostile.test/x` :
    // le chemin de reprise doit réappliquer l'allowlist, pas la contourner.
    const res = await post({ source: 'depot-hostile.test/x', entityId: seed.entityId });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('depot-hostile.test');
  });

  it('refuse un chemin skills.sh incomplet avec un message exploitable', async () => {
    const res = await post({ source: 'skills-sh/proprietaire', entityId: seed.entityId });
    expect(res.status).toBe(400);

    const body = (await res.json()) as { message: string };
    expect(body.message).toContain('skills-sh/');
  });

  it('renvoie un diagnostic utilisateur, jamais une erreur interne brute', async () => {
    // Le contrat de la route : une erreur d'installation prévue devient un 400
    // lisible. Un 500 signifierait qu'une exception inattendue a fui.
    const res = await post({ source: 'https://exemple.invalide/x', entityId: seed.entityId });
    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
  });
});
