// agent-model-provider.test.ts — le fournisseur contre lequel `create_agent` /
// `update_agent` valident un modèle vient d'une clé DE L'ESPACE.
//
// Une clé est désignée par son id. Un agent copié d'un espace à l'autre avec
// l'id d'une clé de l'espace d'origine faisait valider son modèle contre le
// fournisseur de cette clé étrangère : même règle que `resolveAgentLlmClient`
// côté runner, une clé d'un autre espace n'est jamais celle de l'agent.

import { describe, it, expect, beforeAll } from 'vitest';
import { entities, entityLlmKeys } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { resolveAgentProvider } from '../builtin/meta-ops/agent-model';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let foreignKeyId: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  const [other] = await db
    .insert(entities)
    .values({ userId: seed.userId, name: 'Other', slug: `other-${Date.now()}` })
    .returning();
  const [k] = await db
    .insert(entityLlmKeys)
    .values({ entityId: other!.id, provider: 'anthropic', isActive: true })
    .returning();
  foreignKeyId = k!.id;
});

describe('resolveAgentProvider', () => {
  it("uses the agent's own key when it belongs to the workspace", async () => {
    expect(await resolveAgentProvider(db, seed.entityId, seed.llmKeyId)).toEqual({
      provider: 'openai-compatible',
      keyId: seed.llmKeyId,
    });
  });

  it("never the key of another workspace: the workspace's active key answers", async () => {
    expect(await resolveAgentProvider(db, seed.entityId, foreignKeyId)).toEqual({
      provider: 'openai-compatible',
      keyId: seed.llmKeyId,
    });
  });
});
