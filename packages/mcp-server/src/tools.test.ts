// tools.test.ts — un test par constat de la review qui a fait bloquer la v1.
//
// La première version exposait `create_task` / `assign_*` directement, et la
// review l'a démontée en six constats à racine unique : ces outils tirent leur
// autorité du JOB qui les appelle. La v2 applique le contrat de la surface
// chat — UN outil, `run_task`, qui crée un vrai job. Chaque test ci-dessous
// épingle un des constats pour qu'il ne revienne pas.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentJobs, entities, eq } from '@nodal-agents/db';
import { buildNodalMcpServer } from './server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let autreEntiteId: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  // Une SECONDE entité — le contrôle de l'usurpation inter-workspace.
  const [autre] = await db
    .insert(entities)
    .values({ userId: seed.userId, name: 'Autre Workspace', slug: 'autre-workspace' })
    .returning();
  autreEntiteId = (autre as { id: string }).id;
});

/** Un client MCP réel branché en mémoire — vrai protocole, zéro processus. */
async function connect(agentId: string) {
  const server = await buildNodalMcpServer({ db, agentId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

describe('le contrat run_task', () => {
  it("expose UN outil, et c'est run_task", async () => {
    // Constat « create_task contourne la hiérarchie » : les outils internes ne
    // sont plus servis du tout. La seule porte est celle du chat.
    const client = await connect(seed.agentId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['run_task']);
    await client.close();
  });

  it("crée un VRAI job, dans l'entité DE L'AGENT", async () => {
    // Constat « usurpation inter-entité » : entityId n'est plus un paramètre.
    // Il est lu depuis la ligne agent — le seul endroit qui fait foi.
    // Mutation exécutée : réinjecter une entité fournie par l'appelant fait
    // rougir CE test avec « le job a atterri dans la mauvaise entité ».
    const client = await connect(seed.agentId);
    const res = await client.callTool({
      name: 'run_task',
      arguments: { instruction: 'analyse le depot et liste les bugs' },
    });
    const body = JSON.parse((res.content as Array<{ text: string }>)[0]!.text) as {
      jobId: string;
    };
    expect(body.jobId, 'aucun job créé').toBeTruthy();

    const [job] = await db.select().from(agentJobs).where(eq(agentJobs.id, body.jobId)).limit(1);
    expect(job, 'le job annoncé n existe pas en base').toBeTruthy();
    expect(job!.entityId, 'le job a atterri dans la mauvaise entité').toBe(seed.entityId);
    expect(job!.entityId).not.toBe(autreEntiteId);
    expect(job!.agentId).toBe(seed.agentId);
    expect(job!.status, 'le job doit attendre le worker, pas s exécuter ici').toBe('pending');
    expect(job!.channel, 'la provenance doit être dite, pas déguisée en api').toBe('mcp');
    await client.close();
  });

  it('refuse de démarrer pour un agent inexistant', async () => {
    // Constat « un agentId inconnu reçoit quand même les outils » : un serveur
    // au nom de personne n'a rien à servir.
    await expect(connect('00000000-0000-0000-0000-000000000000')).rejects.toThrow(
      /mcp_agent_not_found/,
    );
  });

  it('refuse de démarrer pour un agent inactif', async () => {
    const [dormant] = await db
      .insert(agents)
      .values({
        entityId: seed.entityId,
        name: 'Dormant',
        slug: 'dormant',
        personality: 'zzz',
        model: 'test-model',
        role: 'agent',
        active: false,
      })
      .returning();
    await expect(connect((dormant as { id: string }).id)).rejects.toThrow(/mcp_agent_not_found/);
  });

  it('plafonne le nombre de jobs par processus', async () => {
    // Constat « contournement global des compteurs anti-boucle » : les gardes
    // de Nodal vivent DANS un job ; rien ne bornait le nombre de racines
    // injectées. Le plafond par processus est cette borne — le réarmer est un
    // redémarrage, donc un geste humain.
    const server = await buildNodalMcpServer({
      db,
      agentId: seed.agentId,
      maxJobsPerProcess: 2,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const call = () =>
      client.callTool({ name: 'run_task', arguments: { instruction: 'petite tache' } });
    const a = await call();
    const b = await call();
    const c = await call();

    expect(a.isError ?? false).toBe(false);
    expect(b.isError ?? false).toBe(false);
    expect(c.isError, 'le troisième appel aurait dû être refusé').toBe(true);
    expect((c.content as Array<{ text: string }>)[0]!.text).toMatch(/mcp_job_cap_reached/);
    await client.close();
  });
});

describe('le plafond sous la concurrence', () => {
  it('tient quand dix appels partent EN MÊME TEMPS', async () => {
    // Constat de la passe 2 : contrôle -> insert (await) -> incrément laissait
    // dix appels concurrents observer la même valeur avant qu'aucun ne
    // l'incrémente — dix jobs payants sous un plafond de deux. Le test
    // séquentiel ne pouvait pas le voir ; celui-ci lance la salve d'un coup.
    const server = await buildNodalMcpServer({
      db,
      agentId: seed.agentId,
      maxJobsPerProcess: 2,
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);

    const salve = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        client.callTool({ name: 'run_task', arguments: { instruction: `salve ${i}` } }),
      ),
    );

    const reussis = salve.filter((r) => !(r.isError ?? false)).length;
    expect(reussis, `${reussis} jobs créés sous un plafond de 2`).toBe(2);
    await client.close();
  });
});

describe('le plafond refuse les valeurs qui ne plafonnent rien', () => {
  it.each([NaN, Infinity, 2.5, 0, -1])('refuse %s au démarrage', async (cap) => {
    // Constat de la passe 3 : `jobsCreated >= NaN` est toujours faux — un
    // Number(process.env.X) mal écrit lançait un serveur SANS plafond, sans un
    // mot. Une protection qui disparaît en silence est pire qu'absente.
    await expect(
      buildNodalMcpServer({ db, agentId: seed.agentId, maxJobsPerProcess: cap }),
    ).rejects.toThrow(/mcp_invalid_job_cap/);
  });
});
