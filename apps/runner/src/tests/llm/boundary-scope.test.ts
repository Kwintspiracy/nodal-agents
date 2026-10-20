// boundary-scope.test.ts — la frontière des handles ne laisse JAMAIS passer un
// texte brut en silence (#824, passe 3 de la revue), sur le chemin chat comme
// sur le chemin CLI.
//
// Son espace se construit en un endroit (`conversationIdsAsHandles`) : celui
// du texte, sinon celui de son agent. Aucun des deux : la requête est refusée,
// et le fournisseur n'est jamais appelé.
//
// Mutation vérifiée : `workspaceOf` qui rend '' au lieu de lever → les deux
// cas « refused » rougissent (le client et la CLI reçoivent le texte brut).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, channelAllowedConversations, conversationHandleFor } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { NodalLlmClient } from '@nodal-agents/llm';
import { addressedByHandle } from '../../llm/addressed-by-handle.ts';
import { cliTurnForModel } from '../../cli-runtime/provider.ts';
import type { CliTurnOptions } from '../../cli-runtime/provider.ts';

const WA = '33612000999@s.whatsapp.net';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let homelessAgentId: string;
const any = () => db as unknown as AnyDrizzleDb;

beforeAll(async () => {
  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'whatsapp',
    conversationId: WA,
    kind: 'private',
    status: 'active',
  });
  // A legacy row: an agent with no workspace (no writer creates one today).
  const [homeless] = await db
    .insert(agents)
    .values({ entityId: null, name: 'Homeless', slug: 'homeless', personality: 'p' })
    .returning({ id: agents.id });
  homelessAgentId = homeless!.id;
});

function fakeClient() {
  const generateText = vi.fn(async () => ({ text: 'ok' }));
  const client = {
    config: { provider: 'anthropic', model: 'mock' },
    capabilities: {},
    generateText,
    generateObject: vi.fn(),
    streamText: vi.fn(),
  } as unknown as NodalLlmClient;
  return { client, generateText };
}

const turn = (message: string): CliTurnOptions =>
  ({ message, personality: `system ${WA}`, cwd: '.' }) as unknown as CliTurnOptions;

describe('the handle boundary never sends raw text in silence @cap:parler-par-canal-externe/moteur', () => {
  it('chat: an agent with no workspace — the request is refused, the provider never called', async () => {
    const { client, generateText } = fakeClient();
    const wrapped = addressedByHandle(client, any(), {
      entityId: null,
      subject: 'a model request of an agent with no workspace',
    });
    await expect(
      wrapped.generateText({ messages: [{ role: 'user', content: `écris à ${WA}` }] }),
    ).rejects.toMatchObject({ name: 'conversation_scope_unknown' });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('chat: an agent with a workspace — the request is sent with the handle', async () => {
    const { client, generateText } = fakeClient();
    const wrapped = addressedByHandle(client, any(), { entityId: seed.entityId });
    await wrapped.generateText({ messages: [{ role: 'user', content: `écris à ${WA}` }] });
    const handle = await conversationHandleFor(any(), {
      entityId: seed.entityId,
      channel: 'whatsapp',
      conversationId: WA,
    });
    expect(JSON.stringify(generateText.mock.calls[0])).toContain(`écris à ${handle}`);
    expect(JSON.stringify(generateText.mock.calls[0])).not.toContain(WA);
  });

  it('CLI: a job with no workspace of its own takes its agent’s', async () => {
    const shown = await cliTurnForModel(
      { db: any(), entityId: null, agentId: seed.agentId },
      turn(`écris à ${WA}`),
    );
    const handle = await conversationHandleFor(any(), {
      entityId: seed.entityId,
      channel: 'whatsapp',
      conversationId: WA,
    });
    expect(shown.message).toBe(`écris à ${handle}`);
    expect(shown.personality).toBe(`system ${handle}`);
  });

  it('CLI: no workspace, not even through its agent — the turn is refused, nothing is launched', async () => {
    await expect(
      cliTurnForModel(
        { db: any(), entityId: null, agentId: homelessAgentId },
        turn(`écris à ${WA}`),
      ),
    ).rejects.toMatchObject({ name: 'conversation_scope_unknown' });
  });
});
