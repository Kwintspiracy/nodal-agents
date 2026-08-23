// mcp-provenance.test.ts — la garde meta-tools est-elle FAIL-CLOSED ?
//
// La review a démontré le contournement de la version inline avec une chaîne
// de six jobs : /api/agent accepte un parentJobId arbitraire, la marche était
// bornée à cinq sauts, et l'ancêtre MCP au sixième saut redevenait invisible —
// les meta-tools revenaient. Même faille avec un parent purgé par la rétention.
// Une garde qui s'ouvre quand elle ne sait pas n'est pas une garde ; ces tests
// épinglent le sens de chaque cas indéterminable.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs } from '@nodal-agents/db';
import { isMcpOriginJob } from '../../lib/mcp-provenance.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

async function insertJob(channel: string, parentJobId: string | null): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      status: 'pending',
      channel,
      task: 't',
      parentJobId: parentJobId ?? undefined,
      messages: [],
    })
    .returning({ id: agentJobs.id });
  return (row as { id: string }).id;
}

describe('isMcpOriginJob', () => {
  it('vrai pour un job canal mcp lui-même', async () => {
    expect(await isMcpOriginJob(db, { channel: 'mcp', parentJobId: null })).toBe(true);
  });

  it('faux pour un job racine ordinaire — dashboard, chat, cron', async () => {
    expect(await isMcpOriginJob(db, { channel: 'dashboard', parentJobId: null })).toBe(false);
  });

  it("vrai pour l'enfant task-board d'un job mcp — l'héritage direct", async () => {
    const mcp = await insertJob('mcp', null);
    const enfant = await insertJob('task-board', mcp);
    expect(await isMcpOriginJob(db, { channel: 'task-board', parentJobId: mcp })).toBe(true);
    void enfant;
  });

  it('VRAI même à six sauts — le contournement exact de la review', async () => {
    // /api/agent accepte un parentJobId arbitraire : le client enchaînait
    // A1(parent=M)…A6, et M — l'ancêtre MCP — sortait de la fenêtre de cinq
    // sauts de l'ancienne version. A6 récupérait les meta-tools.
    const m = await insertJob('mcp', null);
    let parent = m;
    for (let i = 0; i < 5; i++) parent = await insertJob('api', parent);
    expect(
      await isMcpOriginJob(db, { channel: 'api', parentJobId: parent }),
      'l ancêtre MCP au-delà de la fenêtre a été perdu — la garde s est ouverte',
    ).toBe(true);
  });

  it('VRAI quand un parent manque — rétention ou id forgé', async () => {
    // Un parent purgé rendait la provenance indéterminable, et l'ancienne
    // version concluait « non-MCP ». Fermer, pas ouvrir.
    expect(
      await isMcpOriginJob(db, {
        channel: 'task-board',
        parentJobId: '00000000-0000-0000-0000-00000000dead',
      }),
    ).toBe(true);
  });

  it('faux pour une chaîne légitime courte sans ancêtre mcp', async () => {
    const racine = await insertJob('dashboard', null);
    const enfant = await insertJob('task-board', racine);
    expect(await isMcpOriginJob(db, { channel: 'task-board', parentJobId: racine })).toBe(false);
    void enfant;
  });
});

describe("l'épuisement de la marche est fermé, pas ouvert", () => {
  it('VRAI pour une chaîne plus longue que la borne, même sans ancêtre mcp visible', async () => {
    // Le chemin « épuisement » : onze maillons, l'ancêtre au-delà de la borne
    // de dix. La marche ne PEUT pas savoir — et ne pas savoir doit fermer.
    // C'est ce chemin précis que la mutation fail-open ne faisait pas rougir.
    const m = await insertJob('mcp', null);
    let parent = m;
    for (let i = 0; i < 10; i++) parent = await insertJob('api', parent);
    expect(
      await isMcpOriginJob(db, { channel: 'api', parentJobId: parent }),
      "la chaîne trop longue a été déclarée sûre — c'est le fail-open",
    ).toBe(true);
  });
});
