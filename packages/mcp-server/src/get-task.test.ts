// get-task.test.ts — l'appelant de run_task obtient la réponse de SON job (#887).
//
// Tout passe par le vrai protocole MCP (client du SDK, transport en mémoire) et
// une vraie base (PGlite, le schéma de spinUpTestDb) : ce que le test lit est
// ce qu'un client MCP lit, et ce que la base porte vraiment.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentJobs,
  approvalRequests,
  entities,
  eq,
  jobDeliverableVerificationState,
} from '@nodal-agents/db';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildNodalMcpServer } from './server';
import { GET_TASK_MAX_WAIT_SECONDS } from './tools';
import { waitForRun } from './get-task';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

/** Un workspace neuf, serveur MCP ouvert, avec un agent. */
async function workspace(nom: string): Promise<{ entityId: string; agentId: string }> {
  const [ent] = await db
    .insert(entities)
    .values({ userId: seed.userId, name: `WS ${nom}`, slug: `ws-${nom}`, mcpServerEnabled: true })
    .returning();
  const entityId = (ent as { id: string }).id;
  const [ag] = await db
    .insert(agents)
    .values({
      entityId,
      name: `Agent ${nom}`,
      slug: `agent-${nom}`,
      personality: 'x',
      model: 'test-model',
      role: 'agent',
      active: true,
    })
    .returning();
  return { entityId, agentId: (ag as { id: string }).id };
}

async function connect(agentId: string): Promise<Client> {
  const server = await buildNodalMcpServer({ db, agentId });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.1' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  return client;
}

const textOf = (res: unknown) =>
  ((res as { content: unknown }).content as Array<{ text: string }>)[0]!.text;

async function runTask(client: Client, instruction: string): Promise<string> {
  const res = await client.callTool({ name: 'run_task', arguments: { instruction } });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return (JSON.parse(textOf(res)) as { jobId: string }).jobId;
}

interface Reply {
  jobId: string;
  status: string;
  jobStatus: string | null;
  result: string | null;
  error: string | null;
  liveJobs: number;
  deliverables: Array<{ path: string; type: string; declared: boolean; verification: string }>;
  waitingForPerson: Array<{
    requestId: string;
    jobId: string;
    kind: string;
    toolName: string;
    about: unknown;
    answerOn: string;
  }>;
}

async function getTask(client: Client, args: Record<string, unknown>): Promise<Reply> {
  const res = await client.callTool({ name: 'get_task', arguments: args });
  expect(res.isError ?? false, textOf(res)).toBe(false);
  return JSON.parse(textOf(res)) as Reply;
}

/** Le délégué d'un job : la même forme que router/delegate.ts lui donne. */
async function child(parent: string, ws: { entityId: string; agentId: string }, status: string) {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: ws.entityId,
      agentId: ws.agentId,
      parentJobId: parent,
      channel: 'internal',
      task: 'sous-tache',
      status,
      messages: [],
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

describe('get_task rend à l’appelant la réponse de son job @cap:parler-par-canal-externe/moteur', () => {
  it('le serveur expose run_task et get_task, et get_task se dit en lecture seule', async () => {
    const ws = await workspace('liste');
    const client = await connect(ws.agentId);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['get_task', 'run_task']);
    const get = tools.find((t) => t.name === 'get_task')!;
    expect(get.annotations?.readOnlyHint).toBe(true);
    expect(get.inputSchema.required).toEqual(['jobId']);
    // Le reçu de run_task dit comment obtenir la réponse.
    const run = tools.find((t) => t.name === 'run_task')!;
    expect(run.description).toContain('call `get_task` with that jobId');
    await client.close();
  });

  it('un job créé par run_task, puis fini, rend son vrai résultat', async () => {
    const ws = await workspace('fini');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'combien font 2 + 2 ?');

    const avant = await getTask(client, { jobId });
    expect(avant).toMatchObject({ jobId, status: 'running', jobStatus: 'pending', result: null });
    expect(avant.liveJobs).toBe(1);

    // Le worker finit le job : la ligne que finalize écrit.
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: 'Ça fait 4.' })
      .where(eq(agentJobs.id, jobId));
    await db.insert(jobDeliverableVerificationState).values({
      jobId,
      deliverableType: 'document',
      canonicalKey: '/work/reponse.md',
      displayPathSnapshot: 'reponse.md',
      dirtyGeneration: 1,
      declared: true,
      decisionStatus: 'green',
    });

    const apres = await getTask(client, { jobId });
    expect(apres).toEqual({
      jobId,
      status: 'completed',
      jobStatus: 'completed',
      result: 'Ça fait 4.',
      error: null,
      liveJobs: 0,
      deliverables: [
        { jobId, path: 'reponse.md', type: 'document', declared: true, verification: 'green' },
      ],
      waitingForPerson: [],
    });
    // Relire n'écrit rien : la ligne est celle que le worker a laissée.
    const [row] = await db.select().from(agentJobs).where(eq(agentJobs.id, jobId));
    expect(row!.status).toBe('completed');
    expect(row!.result).toBe('Ça fait 4.');
    await client.close();
  });

  it('un échec rend le statut et l’erreur de la ligne', async () => {
    const ws = await workspace('echec');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    await db
      .update(agentJobs)
      .set({ status: 'failed', error: 'budget_exceeded' })
      .where(eq(agentJobs.id, jobId));
    const r = await getTask(client, { jobId });
    expect(r).toMatchObject({ status: 'failed', error: 'budget_exceeded', result: null });
    await client.close();
  });

  it('un délégué qui court encore garde le run « running », même quand la tête est terminée', async () => {
    // Mutation exécutée : rendre le statut de la tête sans lire l'arbre fait
    // rougir CE test (« completed » au lieu de « running »).
    const ws = await workspace('delegue');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'fais faire le travail par l’équipe');
    await db
      .update(agentJobs)
      .set({ status: 'completed', result: 'Je délègue à Dev.' })
      .where(eq(agentJobs.id, jobId));
    const fils = await child(jobId, ws, 'processing');
    // Un petit-fils fini ne change rien : c'est le fils vivant qui compte.
    await child(fils, ws, 'completed');

    const pendant = await getTask(client, { jobId });
    expect(pendant).toMatchObject({ status: 'running', jobStatus: 'completed', liveJobs: 1 });

    // Le délégué au second niveau d'abord : l'arbre entier est lu, pas un seul niveau.
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, fils));
    const petitFils = await child(fils, ws, 'pending');
    expect((await getTask(client, { jobId })).status).toBe('running');
    await db.update(agentJobs).set({ status: 'completed' }).where(eq(agentJobs.id, petitFils));

    expect(await getTask(client, { jobId })).toMatchObject({
      status: 'completed',
      result: 'Je délègue à Dev.',
      liveJobs: 0,
    });
    await client.close();
  });

  it('une approbation en attente dans un délégué est rapportée, avec ce qu’elle demande', async () => {
    const ws = await workspace('approbation');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'envoie le rapport');
    await db
      .update(agentJobs)
      .set({ status: 'awaiting_delegation' })
      .where(eq(agentJobs.id, jobId));
    const fils = await child(jobId, ws, 'awaiting_approval');
    const [req] = await db
      .insert(approvalRequests)
      .values({
        entityId: ws.entityId,
        jobId: fils,
        agentId: ws.agentId,
        toolName: 'send_email',
        toolInput: { to: 'a@example.com', subject: 'Rapport' },
        kind: 'approval',
      })
      .returning({ id: approvalRequests.id });
    const [question] = await db
      .insert(approvalRequests)
      .values({
        entityId: ws.entityId,
        jobId,
        agentId: ws.agentId,
        toolName: 'files_mcp__write',
        toolInput: { message: 'Quel dossier ?', requestedSchema: { type: 'object' } },
        kind: 'elicitation',
      })
      .returning({ id: approvalRequests.id });

    const r = await getTask(client, { jobId });
    expect(r.status).toBe('waiting_for_person');
    expect(r.waitingForPerson).toEqual([
      {
        requestId: req!.id,
        jobId: fils,
        kind: 'approval',
        toolName: 'send_email',
        about: { to: 'a@example.com', subject: 'Rapport' },
        requestedAt: expect.any(String),
        answerOn: 'dashboard',
      },
      {
        requestId: question!.id,
        jobId,
        kind: 'elicitation',
        toolName: 'files_mcp__write',
        about: { message: 'Quel dossier ?', requestedSchema: { type: 'object' } },
        requestedAt: expect.any(String),
        answerOn: 'dashboard',
      },
    ]);

    // Répondue, la demande ne l'est plus, et le run court de nouveau.
    await db
      .update(approvalRequests)
      .set({ status: 'approved' })
      .where(eq(approvalRequests.jobId, fils));
    await db
      .update(approvalRequests)
      .set({ status: 'approved' })
      .where(eq(approvalRequests.jobId, jobId));
    await db.update(agentJobs).set({ status: 'processing' }).where(eq(agentJobs.id, fils));
    expect(await getTask(client, { jobId })).toMatchObject({
      status: 'running',
      waitingForPerson: [],
    });
    await client.close();
  });
});

describe('get_task ne lit que les jobs MCP de son workspace @cap:parler-par-canal-externe/moteur', () => {
  it('un job d’un autre workspace, un job d’un autre canal et un id inconnu : le MÊME refus, octet pour octet', async () => {
    // Mutation exécutée : retirer le filtre d'espace fait rougir CE test (le
    // job de l'autre espace est lu).
    const ici = await workspace('ici');
    const ailleurs = await workspace('ailleurs');
    const clientAilleurs = await connect(ailleurs.agentId);
    const etranger = await runTask(clientAilleurs, 'job d’un autre espace');
    await clientAilleurs.close();
    const [chat] = await db
      .insert(agentJobs)
      .values({
        entityId: ici.entityId,
        agentId: ici.agentId,
        channel: 'dashboard',
        task: 'un job du tableau de bord',
        status: 'completed',
        result: 'secret du chat',
        messages: [],
      })
      .returning({ id: agentJobs.id });
    const inconnu = '00000000-0000-4000-8000-000000000000';

    const client = await connect(ici.agentId);
    const refus = async (jobId: string) => {
      const res = await client.callTool({ name: 'get_task', arguments: { jobId } });
      expect(res.isError, `le job ${jobId} a été lu`).toBe(true);
      // L'id demandé est remplacé par un repère : le reste doit être identique.
      return textOf(res).replace(jobId, '<id>');
    };
    const [a, b, c] = [await refus(etranger), await refus(chat!.id), await refus(inconnu)];
    expect(a).toBe(
      "mcp_job_not_found: no job with id <id> was created by this MCP server's workspace.",
    );
    expect(b).toBe(a);
    expect(c).toBe(a);
    // Le message ne porte que l'id que l'appelant a lui-même fourni.
    const brut = await client.callTool({ name: 'get_task', arguments: { jobId: etranger } });
    expect(textOf(brut)).toBe(
      `mcp_job_not_found: no job with id ${etranger} was created by this MCP server's workspace.`,
    );
    await client.close();
  });

  it('get_task ne compte pas dans le plafond de jobs en cours (#498), et n’en crée aucun', async () => {
    const ws = await workspace('plafond');
    const server = await buildNodalMcpServer({ db, agentId: ws.agentId, maxJobsInFlight: 1 });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.1' });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const jobId = await runTask(client, 'seul job permis');
    for (let i = 0; i < 3; i++) expect((await getTask(client, { jobId })).status).toBe('running');
    const jobs = await db
      .select({ id: agentJobs.id })
      .from(agentJobs)
      .where(eq(agentJobs.entityId, ws.entityId));
    expect(jobs).toEqual([{ id: jobId }]);
    await client.close();
  });

  it('couper l’interrupteur coupe aussi la lecture d’un client déjà connecté', async () => {
    const ws = await workspace('coupure');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    await db.update(entities).set({ mcpServerEnabled: false }).where(eq(entities.id, ws.entityId));
    const res = await client.callTool({ name: 'get_task', arguments: { jobId } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/^mcp_disabled: /);
    await client.close();
  });

  it(`refuse une attente au-delà de ${GET_TASK_MAX_WAIT_SECONDS} s`, async () => {
    const ws = await workspace('attente-max');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    const res = await client.callTool({
      name: 'get_task',
      arguments: { jobId, waitSeconds: GET_TASK_MAX_WAIT_SECONDS + 1 },
    });
    expect(res.isError).toBe(true);
    await client.close();
  });
});

describe('waitSeconds : une attente bornée @cap:parler-par-canal-externe/moteur', () => {
  it('rend dès que le job finit, bien avant la fin de l’attente', async () => {
    const ws = await workspace('attente-tot');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    // Un constructeur de requête drizzle ne part qu'une fois attendu.
    setTimeout(async () => {
      await db
        .update(agentJobs)
        .set({ status: 'completed', result: 'fini pendant l’attente' })
        .where(eq(agentJobs.id, jobId));
    }, 300);
    const t0 = Date.now();
    const r = await getTask(client, { jobId, waitSeconds: 30 });
    const ms = Date.now() - t0;
    expect(r).toMatchObject({ status: 'completed', result: 'fini pendant l’attente' });
    expect(ms, `rendu après ${ms} ms`).toBeLessThan(5_000);
    await client.close();
  });

  it('rend dès qu’une personne est attendue', async () => {
    const ws = await workspace('attente-personne');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    setTimeout(async () => {
      await db.insert(approvalRequests).values({
        entityId: ws.entityId,
        jobId,
        agentId: ws.agentId,
        toolName: 'ask_user',
        toolInput: { question: 'A ou B ?', options: ['A', 'B'] },
        kind: 'question',
      });
    }, 300);
    const t0 = Date.now();
    const r = await getTask(client, { jobId, waitSeconds: 30 });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.status).toBe('waiting_for_person');
    expect(r.waitingForPerson.map((w) => w.about)).toEqual([
      { question: 'A ou B ?', options: ['A', 'B'] },
    ]);
    await client.close();
  });

  it('rend à la fin de l’attente quand rien ne bouge, avec l’état courant', async () => {
    const ws = await workspace('attente-cap');
    const client = await connect(ws.agentId);
    const jobId = await runTask(client, 'x');
    const t0 = Date.now();
    const r = await getTask(client, { jobId, waitSeconds: 1 });
    const ms = Date.now() - t0;
    expect(r.status).toBe('running');
    expect(ms, `rendu après ${ms} ms`).toBeGreaterThanOrEqual(950);
    expect(ms).toBeLessThan(4_000);
    await client.close();
  });
});

describe('waitForRun : l’attente elle-même', () => {
  // Une horloge et des lectures simulées : la boucle est jugée sur ce qu'elle
  // RENDS et quand, pas sur un compte d'appels.
  it('sans attente, une seule lecture, rendue telle quelle', async () => {
    const states = ['running', 'completed'];
    let i = 0;
    const r = await waitForRun(
      async () => states[i++]!,
      (s) => s !== 'running',
      { waitMs: 0, pollMs: 1_000 },
    );
    expect(r).toBe('running');
  });

  it('le client qui annule arrête l’attente : la dernière lecture est rendue sans attendre la borne', async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    const r = await waitForRun(
      async () => 'running',
      (s) => s !== 'running',
      { waitMs: 60_000, pollMs: 1_000, signal: ctrl.signal },
    );
    expect(r).toBe('running');
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('une lecture qui échoue fait échouer l’attente, jamais un état inventé', async () => {
    await expect(
      waitForRun(
        async () => {
          throw new Error('db_down');
        },
        () => true,
        { waitMs: 5_000, pollMs: 100 },
      ),
    ).rejects.toThrow('db_down');
  });
});
