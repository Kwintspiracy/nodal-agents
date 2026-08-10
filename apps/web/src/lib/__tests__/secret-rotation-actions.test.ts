// secret-rotation-actions.test.ts — lot 1, les deux actions qui MANIPULENT
// des secrets.
//
// La rotation de clé a deux façons de mal tourner, et aucune ne se voit à
// l'écran :
//
//   - la clé est écrite EN CLAIR dans une colonne que le reste du produit
//     traite comme chiffrée ; tout continue de fonctionner, et le jour où un
//     dump de base circule le secret est dedans ;
//   - la clé est remplacée AVANT d'avoir été vérifiée : une faute de frappe
//     efface la clé qui marchait, et le connecteur tombe au prochain job.
//
// Les tests portent donc sur la valeur réellement stockée — jamais sur `r.ok` —
// et, pour chaque refus, sur le fait que l'ANCIENNE clé est toujours là.

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, and, connectors, entities, entityMembers, mcpServers, users } from '@nodal-agents/db';
import { encrypt, decrypt, isEncrypted } from '@nodal-agents/secrets';

let testDb: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let foreignEntityId: string;

/** Outils renvoyés par la fausse connexion MCP — relus depuis la ligne écrite. */
const FAKE_TOOLS = [
  { name: 'retrieve_balance', description: 'Solde du compte', inputSchema: { type: 'object' } },
  { name: 'list_customers', description: 'Liste les clients', inputSchema: { type: 'object' } },
];

const connectMcpMock = vi.hoisted(() => vi.fn());

vi.mock('@nodal-agents/adapter-mcp', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@nodal-agents/adapter-mcp')>();
  return { ...actual, connectMcp: connectMcpMock };
});

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

  const existing = await testDb
    .select()
    .from(entityMembers)
    .where(and(eq(entityMembers.entityId, seed.entityId), eq(entityMembers.userId, seed.userId)));
  if (existing.length === 0) {
    await testDb
      .insert(entityMembers)
      .values({ entityId: seed.entityId, userId: seed.userId, role: 'owner' });
  }

  const [other] = await testDb
    .insert(users)
    .values({ email: `voisin-${Date.now()}@example.com` })
    .returning();
  const [otherEntity] = await testDb
    .insert(entities)
    .values({ userId: other!.id, name: 'Entité voisine', slug: `voisine-${Date.now()}` })
    .returning();
  foreignEntityId = otherEntity!.id;
});

async function actions() {
  return import('../actions.ts');
}

/** Connexion MCP factice : la forme minimale que l'action consomme. */
function fakeConnection() {
  return {
    client: { callTool: vi.fn().mockResolvedValue({ content: [] }) },
    tools: FAKE_TOOLS,
    close: vi.fn().mockResolvedValue(undefined),
  };
}

let compteur = 0;
async function makeConnector(opts: { entityId: string; authType: string; apiKey: string }) {
  compteur += 1;
  const [row] = await testDb
    .insert(connectors)
    .values({
      entityId: opts.entityId,
      name: `Connecteur ${compteur}`,
      slug: `connecteur-${compteur}`,
      authType: opts.authType,
      apiKey: encrypt(opts.apiKey),
    })
    .returning();
  return row!;
}

async function makeMcpServer(opts: { entityId: string; apiKey: string; url?: string | null }) {
  compteur += 1;
  const [row] = await testDb
    .insert(mcpServers)
    .values({
      entityId: opts.entityId,
      name: `Stripe ${compteur}`,
      // Le slug pointe vers une entrée RÉELLE du catalogue : c'est elle qui
      // porte le préfixe attendu et le tool de vérification.
      slug: 'stripe',
      transport: 'http',
      url: opts.url === undefined ? 'https://mcp.stripe.com' : opts.url,
      authScheme: 'bearer',
      authParamName: 'Authorization',
      apiKey: encrypt(opts.apiKey),
      apiKeyLast4: opts.apiKey.slice(-4),
    })
    .returning();
  return row!;
}

async function connectorRow(id: string) {
  const [row] = await testDb.select().from(connectors).where(eq(connectors.id, id));
  return row!;
}

async function mcpRow(id: string) {
  const [row] = await testDb.select().from(mcpServers).where(eq(mcpServers.id, id));
  return row!;
}

// ─── updateConnectorApiKeyAction ─────────────────────────────────────────────

describe('updateConnectorApiKeyAction', () => {
  it('écrit la nouvelle clé CHIFFRÉE — jamais en clair', async () => {
    const { updateConnectorApiKeyAction } = await actions();
    const connecteur = await makeConnector({
      entityId: seed.entityId,
      authType: 'api_key',
      apiKey: 'ancienne-cle-1111',
    });

    const r = await updateConnectorApiKeyAction(connecteur.id, 'nouvelle-cle-2222');
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    const row = await connectorRow(connecteur.id);
    // Les trois assertions ensemble : la colonne ne contient pas le clair, elle
    // porte bien le marqueur de chiffrement, et elle redonne le bon secret.
    expect(row.apiKey).not.toBe('nouvelle-cle-2222');
    expect(isEncrypted(row.apiKey!)).toBe(true);
    expect(decrypt(row.apiKey!)).toBe('nouvelle-cle-2222');
  });

  it('accepte une valeur déjà chiffrée sans la chiffrer deux fois', async () => {
    // Le double chiffrement rendrait la clé indéchiffrable côté runner, sans
    // qu'aucune erreur ne soit levée à l'écriture.
    const { updateConnectorApiKeyAction } = await actions();
    const connecteur = await makeConnector({
      entityId: seed.entityId,
      authType: 'api_key',
      apiKey: 'ancienne-cle-3333',
    });
    const dejaChiffree = encrypt('clé-déjà-chiffrée-4444');

    const r = await updateConnectorApiKeyAction(connecteur.id, dejaChiffree);
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    expect(decrypt((await connectorRow(connecteur.id)).apiKey!)).toBe('clé-déjà-chiffrée-4444');
  });

  it('refuse un connecteur OAuth — et sa clé reste celle d’avant', async () => {
    const { updateConnectorApiKeyAction } = await actions();
    const connecteur = await makeConnector({
      entityId: seed.entityId,
      authType: 'oauth2',
      apiKey: 'jeton-oauth-5555',
    });

    const r = await updateConnectorApiKeyAction(connecteur.id, 'nouvelle-cle-6666');
    expect(r.ok).toBe(false);

    expect(decrypt((await connectorRow(connecteur.id)).apiKey!)).toBe('jeton-oauth-5555');
  });

  it('refuse le connecteur d’une autre entité — sa clé est intacte', async () => {
    // Garde IDOR sur un secret : écraser la clé d'un autre espace n'expose pas
    // le secret, mais coupe silencieusement son connecteur.
    const { updateConnectorApiKeyAction } = await actions();
    const etranger = await makeConnector({
      entityId: foreignEntityId,
      authType: 'api_key',
      apiKey: 'cle-du-voisin-7777',
    });

    const r = await updateConnectorApiKeyAction(etranger.id, 'clé-injectée');
    expect(r.ok).toBe(false);

    expect(
      decrypt((await connectorRow(etranger.id)).apiKey!),
      'la clé d’une autre entité a été écrasée',
    ).toBe('cle-du-voisin-7777');
  });

  it('refuse une clé vide — la précédente reste en place', async () => {
    const { updateConnectorApiKeyAction } = await actions();
    const connecteur = await makeConnector({
      entityId: seed.entityId,
      authType: 'api_key',
      apiKey: 'cle-en-place-8888',
    });

    const r = await updateConnectorApiKeyAction(connecteur.id, '');
    expect(r.ok).toBe(false);

    expect(decrypt((await connectorRow(connecteur.id)).apiKey!)).toBe('cle-en-place-8888');
  });
});

// ─── updateMcpServerApiKeyAction ─────────────────────────────────────────────

describe('updateMcpServerApiKeyAction', () => {
  it('vérifie la clé, puis l’écrit chiffrée avec les outils rafraîchis', async () => {
    const { updateMcpServerApiKeyAction } = await actions();
    connectMcpMock.mockResolvedValue(fakeConnection());
    const serveur = await makeMcpServer({ entityId: seed.entityId, apiKey: 'rk_test_ancienne' });

    const r = await updateMcpServerApiKeyAction(serveur.id, 'rk_test_nouvelle9012');
    expect(r.ok, r.ok ? '' : r.message).toBe(true);

    const row = await mcpRow(serveur.id);
    expect(row.apiKey).not.toBe('rk_test_nouvelle9012');
    expect(isEncrypted(row.apiKey!)).toBe(true);
    expect(decrypt(row.apiKey!)).toBe('rk_test_nouvelle9012');
    expect(row.apiKeyLast4).toBe('9012');
    // Le catalogue Stripe déclare un tool de vérification : les outils relus
    // pendant la connexion doivent atterrir dans la ligne, sinon l'agent garde
    // la liste de l'ancienne connexion.
    expect((row.availableTools as { name: string }[]).map((t) => t.name)).toEqual([
      'retrieve_balance',
      'list_customers',
    ]);

    // La connexion de vérification a bien porté la NOUVELLE clé — vérifier avec
    // l'ancienne ne prouverait rien.
    const [connectArgs] = connectMcpMock.mock.calls.at(-1)!;
    expect((connectArgs as { apiKey: string }).apiKey).toBe('rk_test_nouvelle9012');
  });

  it('n’écrase PAS la clé qui marche quand la vérification échoue', async () => {
    // Le scénario le plus coûteux : la nouvelle clé est fausse. Si l'action
    // écrivait d'abord et vérifiait ensuite, l'utilisateur perdrait les deux.
    const { updateMcpServerApiKeyAction } = await actions();
    connectMcpMock.mockRejectedValue(new Error('401 Unauthorized'));
    const serveur = await makeMcpServer({ entityId: seed.entityId, apiKey: 'rk_test_valide4321' });

    const r = await updateMcpServerApiKeyAction(serveur.id, 'rk_test_fausse0000');
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.code).toBe('mcp_connect_failed');

    const row = await mcpRow(serveur.id);
    expect(decrypt(row.apiKey!), 'la clé valide a été remplacée par une clé refusée').toBe(
      'rk_test_valide4321',
    );
    expect(row.apiKeyLast4).toBe('4321');
  });

  it('refuse un préfixe hors catalogue sans même tenter la connexion', async () => {
    const { updateMcpServerApiKeyAction } = await actions();
    connectMcpMock.mockClear();
    connectMcpMock.mockResolvedValue(fakeConnection());
    const serveur = await makeMcpServer({ entityId: seed.entityId, apiKey: 'rk_test_intacte5678' });

    const r = await updateMcpServerApiKeyAction(serveur.id, 'clé-sans-préfixe');
    expect(r.ok).toBe(false);

    expect(
      connectMcpMock,
      'une clé mal formée a quand même déclenché un appel réseau',
    ).not.toHaveBeenCalled();
    expect(decrypt((await mcpRow(serveur.id)).apiKey!)).toBe('rk_test_intacte5678');
  });

  it('refuse le serveur d’une autre entité — sa clé est intacte', async () => {
    const { updateMcpServerApiKeyAction } = await actions();
    connectMcpMock.mockResolvedValue(fakeConnection());
    const etranger = await makeMcpServer({
      entityId: foreignEntityId,
      apiKey: 'rk_test_voisin1234',
    });

    const r = await updateMcpServerApiKeyAction(etranger.id, 'rk_test_injectee5555');
    expect(r.ok).toBe(false);

    expect(
      decrypt((await mcpRow(etranger.id)).apiKey!),
      'la clé MCP d’une autre entité a été écrasée',
    ).toBe('rk_test_voisin1234');
  });

  it('refuse une ligne à la configuration incomplète plutôt que de tourner à vide', async () => {
    // Une ligne héritée sans URL ne peut pas être vérifiée : faire tourner la
    // clé dessus donnerait un succès qui ne veut rien dire.
    const { updateMcpServerApiKeyAction } = await actions();
    connectMcpMock.mockResolvedValue(fakeConnection());
    const bancal = await makeMcpServer({
      entityId: seed.entityId,
      apiKey: 'rk_test_bancal7777',
      url: null,
    });

    const r = await updateMcpServerApiKeyAction(bancal.id, 'rk_test_nouvelle8888');
    expect(r.ok).toBe(false);

    expect(decrypt((await mcpRow(bancal.id)).apiKey!)).toBe('rk_test_bancal7777');
  });
});
