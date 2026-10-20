// embeddings-addressed-by-handle.test.ts — ce que le FOURNISSEUR d'embeddings
// reçoit nomme une conversation par son handle, jamais par l'identifiant du
// canal (#824, passe 2 de la revue).
//
// Un fournisseur d'embeddings est un tiers : le fait d'une mémoire, à son
// écriture (`createMemory`) et au backfill du démarrage (`backfillEmbeddings`),
// et la requête d'un rappel (`searchMemories`) lui partent. Le client est celui
// du runner, pris à sa source (`createRunnerEmbeddingClient`, deps.ts), branché
// sur un vrai serveur HTTP local qui parle comme l'API d'embeddings d'OpenAI :
// ce qui est asserté, c'est le CORPS des requêtes reçues.
//
// Mutation vérifiée : `embeddingsAddressedByHandle` retiré de
// `createRunnerEmbeddingClient` → les trois cas rougissent.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentMemory,
  channelAllowedConversations,
  conversationHandleFor,
  eq,
} from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { EmbeddingClient } from '@nodal-agents/llm';
import { backfillEmbeddings, createMemory, searchMemories } from '@nodal-agents/memory';
import { createRunnerEmbeddingClient } from '../../deps.ts';

const WA = '33698700824@s.whatsapp.net';

/** Les textes que le fournisseur a reçus, dans l'ordre. */
const received: string[] = [];
let server: Server;
let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let client: EmbeddingClient;

const any = () => db as unknown as AnyDrizzleDb;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString('utf8')));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { input: string | string[] };
      const inputs = Array.isArray(parsed.input) ? parsed.input : [parsed.input];
      received.push(...inputs);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          object: 'list',
          data: inputs.map((_, index) => ({
            object: 'embedding',
            index,
            embedding: Array.from({ length: 1536 }, (__, i) => ((i % 7) + 1) / 10),
          })),
          model: 'text-embedding-3-small',
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const { port } = server.address() as AddressInfo;

  ({ db } = await spinUpTestDb());
  seed = await seedMinimal(db);
  // The WhatsApp DM is a conversation this workspace knows.
  await db.insert(channelAllowedConversations).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    channel: 'whatsapp',
    conversationId: WA,
    kind: 'private',
    status: 'active',
    requesterName: 'Marie',
  });
  client = createRunnerEmbeddingClient(
    { provider: 'openai', apiKey: 'test', baseURL: `http://127.0.0.1:${port}/v1` },
    any(),
  );
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  received.length = 0;
});

const handleOfWa = () =>
  conversationHandleFor(any(), {
    entityId: seed.entityId,
    channel: 'whatsapp',
    conversationId: WA,
  });

describe('the embedding provider reads conversations by their handle (#824) @cap:se-souvenir/moteur', () => {
  it("a memory's write: the fact is embedded with the handle; the STORED fact keeps the truth", async () => {
    const fact = `Marie se joint sur WhatsApp au ${WA} (écriture)`;
    const memory = await createMemory(
      any(),
      {
        entity_id: seed.entityId,
        fact,
        category: 'context',
        importance: 3,
        source: 'agent',
        skill_tags: [],
      },
      client,
    );
    expect(received).toEqual([`Marie se joint sur WhatsApp au ${await handleOfWa()} (écriture)`]);
    const [row] = await db
      .select({ fact: agentMemory.fact, embedding: agentMemory.embedding })
      .from(agentMemory)
      .where(eq(agentMemory.id, memory.id));
    expect(row!.fact).toBe(fact);
    expect(row!.embedding).toHaveLength(1536);
  });

  it('the startup backfill: a memory without a vector is embedded with the handle', async () => {
    const fact = `Marie se joint sur WhatsApp au ${WA} (backfill)`;
    await createMemory(any(), {
      entity_id: seed.entityId,
      fact,
      category: 'context',
      importance: 3,
      source: 'agent',
      skill_tags: [],
    });
    const result = await backfillEmbeddings(any(), client);
    expect(result.embedded).toBeGreaterThanOrEqual(1);
    expect(received).toContain(`Marie se joint sur WhatsApp au ${await handleOfWa()} (backfill)`);
    expect(received.join('\n')).not.toContain(WA);
  });

  it("a recall's query goes through the SAME rewrite as the memories it is compared with", async () => {
    await searchMemories(any(), client, {
      query: `comment joindre ${WA} ?`,
      entityId: seed.entityId,
    });
    expect(received).toEqual([`comment joindre ${await handleOfWa()} ?`]);
  });

  // #824, passe 3 : un fait sans espace. Mutations vérifiées : la dérivation
  // par l'agent retirée (`workspaceOf`) → les deux cas « derived » rougissent ;
  // `workspaceOf` qui laisse passer le texte brut → les deux cas « no
  // workspace at all » rougissent (le fournisseur reçoit le numéro).
  it('a memory with no workspace of its own: its agent gives it one — write AND backfill', async () => {
    const written = `Marie (sans espace, écrite) : ${WA}`;
    await createMemory(
      any(),
      {
        entity_id: null,
        agent_id: seed.agentId,
        fact: written,
        category: 'context',
        importance: 3,
        source: 'agent',
        skill_tags: [],
      },
      client,
    );
    const legacy = `Marie (sans espace, ancienne) : ${WA}`;
    await db.insert(agentMemory).values({ entityId: null, agentId: seed.agentId, fact: legacy });
    await backfillEmbeddings(any(), client);
    const h = await handleOfWa();
    expect(received).toEqual(
      expect.arrayContaining([
        `Marie (sans espace, écrite) : ${h}`,
        `Marie (sans espace, ancienne) : ${h}`,
      ]),
    );
    expect(received.join(' | ')).not.toContain(WA);
  });

  it('no workspace at all, not even through an agent: NOT embedded, said with the row id, vector NULL — write AND backfill', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const memory = await createMemory(
        any(),
        {
          entity_id: null,
          agent_id: null,
          fact: `orpheline écrite : ${WA}`,
          category: 'context',
          importance: 3,
          source: 'agent',
          skill_tags: [],
        },
        client,
      );
      const [orphan] = await db
        .insert(agentMemory)
        .values({ entityId: null, agentId: null, fact: `orpheline ancienne : ${WA}` })
        .returning({ id: agentMemory.id });
      await backfillEmbeddings(any(), client);

      // The provider never received either text.
      expect(received.join(' | ')).not.toContain(WA);
      expect(received.join(' | ')).not.toContain('orpheline');
      for (const id of [memory.id, orphan!.id]) {
        const [row] = await db
          .select({ embedding: agentMemory.embedding })
          .from(agentMemory)
          .where(eq(agentMemory.id, id));
        expect(row!.embedding).toBeNull();
        const said = warn.mock.calls.map((c) => c.map(String).join(' ')).join(' | ');
        expect(said).toContain(`${id} has no workspace`);
      }
    } finally {
      warn.mockRestore();
    }
  });
});
