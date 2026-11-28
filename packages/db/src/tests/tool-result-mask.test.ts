// tool-result-mask.test.ts — the registry of one workspace's secret values, read from the stores.
//
// `loadToolResultMaskPolicy` is read by the tool-result boundary for every
// call. These cases prove what it holds on a real database: every store where
// Nodal keeps a secret for a workspace, decrypted; nothing of another
// workspace; a token refreshed by the real refresh path the moment it is
// stored; the install's own values; the agent's switch as stored. Values are
// built at run time and never printed.

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  _resetMasterKeyCacheForTests,
  _setMasterKeyForTests,
  encrypt,
} from '@nodal-agents/secrets';
import {
  REDACTED_TEXT,
  _resetInstallSecretValuesForTests,
  registerInstallSecretValues,
} from '@nodal-agents/shared';
import { spinUpTestDb, seedMinimal } from './helpers.ts';
import type { TestDb } from './helpers.ts';
import {
  agentMcpServers,
  agents,
  channelBindings,
  connectors,
  credentials,
  entityLlmKeys,
  mcpServers,
  webhookTriggers,
} from '../schema/index.ts';
import { eq } from 'drizzle-orm';
import { refreshAndPersistCredential } from '../queries/credentials.ts';
import {
  loadToolResultMaskPolicy,
  loadWorkspaceSecretValues,
} from '../queries/tool-result-mask.ts';

const value = (): string => randomBytes(18).toString('hex');

let db: TestDb;

beforeAll(async () => {
  _setMasterKeyForTests(randomBytes(32));
  db = (await spinUpTestDb()).db;
});

afterEach(() => {
  _resetInstallSecretValuesForTests();
  vi.restoreAllMocks();
});

afterAll(() => {
  _resetMasterKeyCacheForTests();
});

/** A workspace with one secret in each store; returns the values, by store. */
async function workspaceWithSecrets() {
  const seed = await seedMinimal(db);
  const v = {
    llm: value(),
    connector: value(),
    access: value(),
    refresh: value(),
    clientSecret: value(),
    mcpKey: value(),
    mcpEnv: value(),
    sharedMcpEnv: value(),
    channel: value(),
    bot: value(),
    webhook: value(),
  };
  await db.insert(entityLlmKeys).values({
    entityId: seed.entityId,
    provider: 'openrouter',
    apiKey: encrypt(v.llm),
  });
  const [cred] = await db
    .insert(credentials)
    .values({
      ownerUserId: seed.userId,
      name: `cred-${randomUUID()}`,
      type: 'google-oauth',
      payload: encrypt(
        JSON.stringify({
          accessToken: v.access,
          refreshToken: v.refresh,
          clientId: 'client-id-public',
          clientSecret: v.clientSecret,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        }),
      ),
    })
    .returning();
  await db.insert(connectors).values([
    { entityId: seed.entityId, name: 'Key', slug: 'acme', apiKey: encrypt(v.connector) },
    { entityId: seed.entityId, name: 'OAuth', slug: 'google-drive', credentialId: cred!.id },
  ]);
  await db.insert(mcpServers).values({
    entityId: seed.entityId,
    name: 'Own',
    slug: `own-${randomUUID().slice(0, 6)}`,
    transport: 'stdio',
    command: 'node',
    apiKey: encrypt(v.mcpKey),
    envVars: { OWN_VAR: encrypt(v.mcpEnv) },
  });
  // A server with no workspace of its own, given to this workspace's agent.
  const [shared] = await db
    .insert(mcpServers)
    .values({
      entityId: null,
      name: 'Shared',
      slug: `shared-${randomUUID().slice(0, 6)}`,
      transport: 'stdio',
      command: 'node',
      envVars: { SHARED_VAR: encrypt(v.sharedMcpEnv) },
    })
    .returning();
  await db
    .insert(agentMcpServers)
    .values({ entityId: seed.entityId, agentId: seed.agentId, mcpServerId: shared!.id });
  await db.insert(channelBindings).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'slack',
    credentials: encrypt(JSON.stringify({ botToken: v.channel })),
  });
  await db
    .update(agents)
    .set({ telegramBotToken: encrypt(v.bot) })
    .where(eq(agents.id, seed.agentId));
  await db.insert(webhookTriggers).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    name: 'hook',
    slug: `hook-${randomUUID()}`,
    taskTemplate: 'x',
    secret: encrypt(v.webhook),
  });
  return { seed, v, credentialId: cred!.id };
}

describe('the registry holds every secret Nodal keeps for the workspace, and only those @cap:connecter-un-service/moteur', () => {
  it('every store, decrypted: provider, connector, OAuth, MCP key and variables, channel, bot, webhook', async () => {
    const { seed, v } = await workspaceWithSecrets();
    const values = await loadWorkspaceSecretValues(db, seed.entityId);
    for (const [store, secret] of Object.entries(v)) {
      expect(values, `the ${store} secret is not in the registry`).toContain(secret);
    }
    // The client id is public: it is in the payload, and harmless to register,
    // but the point is the secrets: every one of them is there.
  });

  it('one workspace’s registry never holds another’s values', async () => {
    const a = await workspaceWithSecrets();
    const b = await workspaceWithSecrets();
    const policyA = await loadToolResultMaskPolicy(db, {
      entityId: a.seed.entityId,
      agentId: a.seed.agentId,
    });
    const text = `${a.v.connector} ${b.v.connector} ${b.v.llm}`;
    expect(policyA.registry.mask(text)).toBe(`${REDACTED_TEXT} ${b.v.connector} ${b.v.llm}`);
    const valuesA = await loadWorkspaceSecretValues(db, a.seed.entityId);
    for (const secret of Object.values(b.v)) expect(valuesA).not.toContain(secret);
  });

  it('a token refreshed by the real refresh path is in the next registry read', async () => {
    const { seed, v, credentialId } = await workspaceWithSecrets();
    const fresh = value();
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: fresh, expires_in: 3600 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    await refreshAndPersistCredential(db, credentialId);
    const policy = await loadToolResultMaskPolicy(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
    });
    expect(policy.registry.mask(`new ${fresh} old ${v.access}`)).toBe(
      `new ${REDACTED_TEXT} old ${v.access}`,
    );
  });

  it('the install’s own values are in every workspace’s registry', async () => {
    const own = value();
    registerInstallSecretValues([own]);
    const { seed } = await workspaceWithSecrets();
    const policy = await loadToolResultMaskPolicy(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
    });
    expect(policy.registry.mask(`x ${own} y`)).toBe(`x ${REDACTED_TEXT} y`);
  });

  it('a row that does not decrypt is skipped and said by its id, never with its content', async () => {
    const { seed, v } = await workspaceWithSecrets();
    const [broken] = await db
      .insert(connectors)
      .values({
        entityId: seed.entityId,
        name: 'Broken',
        slug: 'broken',
        apiKey: 'enc:v1:AAAA:BBBB:CCCC',
      })
      .returning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const values = await loadWorkspaceSecretValues(db, seed.entityId);
    expect(values).toContain(v.connector);
    const said = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(said).toContain('SECRET_ROW_UNDECRYPTABLE');
    expect(said).toContain(`connectors ${broken!.id}`);
    for (const secret of Object.values(v)) expect(said).not.toContain(secret);
  });
});

describe('the agent’s switch, as stored @cap:configurer-agent/moteur', () => {
  it('on by default, off when the row says so, per agent', async () => {
    const { seed } = await workspaceWithSecrets();
    const [other] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Other',
        slug: `other-${randomUUID().slice(0, 8)}`,
        personality: 'x',
      })
      .returning();
    await db.update(agents).set({ maskSecretShapes: false }).where(eq(agents.id, seed.agentId));
    const off = await loadToolResultMaskPolicy(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
    });
    const on = await loadToolResultMaskPolicy(db, { entityId: seed.entityId, agentId: other!.id });
    expect(off.shapes).toBe(false);
    expect(on.shapes).toBe(true);
    // The exact values do not depend on the switch.
    expect(off.registry.size).toBe(on.registry.size);
  });

  it('an agent that is not a row of the workspace has no policy: refused loudly', async () => {
    const a = await workspaceWithSecrets();
    const b = await workspaceWithSecrets();
    await expect(
      loadToolResultMaskPolicy(db, { entityId: a.seed.entityId, agentId: b.seed.agentId }),
    ).rejects.toThrow(/tool_result_mask_agent_missing/);
  });

  it('cost: the policy of a workspace holding 60 secrets is read in a few milliseconds', async () => {
    const { seed } = await workspaceWithSecrets();
    await db.insert(connectors).values(
      Array.from({ length: 50 }, (_, i) => ({
        entityId: seed.entityId,
        name: `C${i}`,
        slug: `c${i}`,
        apiKey: encrypt(value()),
      })),
    );
    await loadToolResultMaskPolicy(db, { entityId: seed.entityId, agentId: seed.agentId });
    const runs = 20;
    const t0 = performance.now();
    let size = 0;
    for (let i = 0; i < runs; i++) {
      size = (
        await loadToolResultMaskPolicy(db, { entityId: seed.entityId, agentId: seed.agentId })
      ).registry.size;
    }
    const ms = (performance.now() - t0) / runs;
    console.warn(`[tool-result-mask] policy read: ${size} forms, ${ms.toFixed(1)} ms per call`);
    expect(size).toBeGreaterThanOrEqual(60);
    expect(ms).toBeLessThan(250);
  });

  it('a job that names no workspace (an internal caller) is scanned with its agent’s', async () => {
    const { seed, v } = await workspaceWithSecrets();
    const policy = await loadToolResultMaskPolicy(db, { entityId: '', agentId: seed.agentId });
    expect(policy.registry.mask(`k=${v.connector}`)).toBe(`k=${REDACTED_TEXT}`);
  });
});
