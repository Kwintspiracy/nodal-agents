// register-project.test.ts — « où écrire ? » devient un projet, et rien ne se
// crée en silence (P10b, plan « De la maquette au produit »).
//
// Tout passe par `executeTool` avec le VRAI outil du registre, un terrain
// temporaire réel et une base pglite : la porte d'approbation est donc dans le
// chemin, comme en production. Les assertions portent sur le DOSSIER sur le
// disque et sur les LIGNES relues (`code_projects`, `agent_jobs`,
// `conversations`, `approval_requests`), jamais sur des compteurs d'appels.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  approvalRequests,
  codeProjects,
  conversations,
  and,
  eq,
} from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { createToolRegistry } from '../../registry';
import { registerBuiltins } from '../../builtin';
import { executeTool } from '../../execute';
import type { ExecuteOptions, ToolContext } from '../../types';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let terrain = '';

const registry = createToolRegistry();
registerBuiltins(registry);

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  // `realpath` : sur Windows `tmpdir()` peut rendre la forme courte 8.3 alors
  // que l'outil résout en forme longue — le chemin comparé doit être le même.
  terrain = normalizePath(realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-regproj-'))));
});

afterEach(async () => {
  await rm(terrain, { recursive: true, force: true }).catch(() => undefined);
});

function outil() {
  const tool = registry.get('register_project');
  if (!tool) throw new Error('register_project absent du registre');
  return tool;
}

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'telegram', task: 'p10b' })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('insert job');
  return job.id;
}

async function conversationNeuve(chatId: string): Promise<string> {
  const [row] = await db
    .insert(conversations)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'telegram',
      chatId,
      title: '',
      origin: 'user',
    })
    .returning({ id: conversations.id });
  if (!row) throw new Error('insert conversation');
  return row.id;
}

/** La question `ask_user` de ce job, RÉPONDUE — ce que le clic de l'utilisateur laisse. */
async function questionRepondue(jobId: string): Promise<void> {
  await db.insert(approvalRequests).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    toolCallId: `call-ask-${jobId}`,
    toolName: 'ask_user',
    toolInput: { question: 'Où ranger cette synthèse ?', options: ['New project: veille-ia'] },
    kind: 'question',
    status: 'approved',
    answer: 'New project: veille-ia',
    resolvedAt: new Date(),
  });
}

function ctx(jobId: string, conversationId: string | null): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    conversationId,
    workspaces: [{ label: 'terrain', path: terrain }],
    turn: 1,
  } as unknown as ToolContext;
}

function options(autonomy?: ExecuteOptions['autonomy']): ExecuteOptions {
  return {
    approvalRules: [] as ExecuteOptions['approvalRules'],
    ...(autonomy === undefined ? {} : { autonomy }),
    onApprovalRequired: async () => {},
  };
}

async function ligne(path: string) {
  const [row] = await db
    .select()
    .from(codeProjects)
    .where(
      and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, projectKey(path))),
    );
  return row ?? null;
}

async function toutesLesLignes(path: string) {
  return db
    .select()
    .from(codeProjects)
    .where(eq(codeProjects.projectKey, projectKey(path)));
}

async function projetDuJob(jobId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job introuvable');
  return row.projectId;
}

async function projetDeLaConversation(id: string): Promise<string | null> {
  const [row] = await db
    .select({ currentProjectId: conversations.currentProjectId })
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!row) throw new Error('conversation introuvable');
  return row.currentProjectId;
}

/** La sortie d'un appel qui a bien traversé la porte. */
async function appel(
  input: unknown,
  jobId: string,
  conversationId: string | null,
  autonomy?: ExecuteOptions['autonomy'],
) {
  return executeTool(outil(), input, ctx(jobId, conversationId), options(autonomy));
}

describe('register_project — la création', () => {
  it('crée le dossier, déclare la ligne, rattache le job ET la conversation', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-a');
    await questionRepondue(jobId);

    const res = await appel({ path: 'veille-ia', name: 'Veille IA' }, jobId, conversationId);
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    const out = res.output as {
      ok: boolean;
      project_id: string;
      path: string;
      name: string;
      kind: string;
      created: boolean;
    };
    expect(out.ok).toBe(true);
    expect(out.created).toBe(true);
    expect(out.name).toBe('Veille IA');
    expect(out.kind).toBe('documents');

    const abs = `${terrain}/veille-ia`;
    // 1. Le dossier existe VRAIMENT.
    expect((await stat(abs)).isDirectory()).toBe(true);
    expect(normalizePath(out.path)).toBe(abs);

    // 2. La ligne est DÉCLARÉE, avec ce que la conversation en dit.
    const row = await ligne(abs);
    expect(row).not.toBeNull();
    expect(row?.id).toBe(out.project_id);
    expect(row?.kind).toBe('documents');
    expect(row?.registeredFrom).toBe('conversation');
    expect(row?.registeredJobId).toBe(jobId);
    expect(row?.agentId).toBe(seed.agentId);
    expect(row?.displayName).toBe('Veille IA');
    expect(row?.registeredAt).not.toBeNull();

    // 3. Le job et la conversation y sont rattachés — sans ça, le tour suivant
    //    reposerait la même question.
    expect(await projetDuJob(jobId)).toBe(out.project_id);
    expect(await projetDeLaConversation(conversationId)).toBe(out.project_id);
  });

  it('un second appel ne redéclare rien : `created: false`, une seule ligne, le nom intact', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-b');
    await questionRepondue(jobId);

    const premier = await appel({ path: 'notes', name: 'Mes notes' }, jobId, conversationId);
    expect(premier.outcome).toBe('success');

    const jobDeux = await jobNeuf();
    await questionRepondue(jobDeux);
    const second = await appel({ path: 'notes', name: 'Autre nom' }, jobDeux, conversationId);
    expect(second.outcome).toBe('success');
    if (second.outcome !== 'success') return;
    const out = second.output as { ok: boolean; created: boolean; name: string };
    expect(out.ok).toBe(true);
    expect(out.created).toBe(false);
    // Le nom rendu est celui de la BASE, pas celui qu'on vient de demander.
    expect(out.name).toBe('Mes notes');

    const abs = `${terrain}/notes`;
    expect(await toutesLesLignes(abs)).toHaveLength(1);
    expect((await ligne(abs))?.displayName).toBe('Mes notes');
    // Le second job se rattache quand même : c'est le même projet.
    expect(await projetDuJob(jobDeux)).toBe((await ligne(abs))?.id);
  });

  it('un chemin hors terrain est refusé, et rien n’est créé', async () => {
    const jobId = await jobNeuf();
    await questionRepondue(jobId);

    const res = await appel({ path: '../hors' }, jobId, null);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; reason: string }).toMatchObject({
      ok: false,
      reason: 'outside_workspace',
    });

    const dehors = normalizePath(join(terrain, '..', 'hors'));
    await expect(stat(dehors)).rejects.toThrow();
    expect(await toutesLesLignes(dehors)).toHaveLength(0);
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un nom de projet écrase le nom que le PROPRIÉTAIRE avait posé depuis Spaces : jamais', async () => {
    const abs = `${terrain}/déjà`;
    await db.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: abs,
      projectKey: projectKey(abs),
      displayName: 'Le nom de Quentin',
      kind: 'documents',
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    });

    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-c');
    await questionRepondue(jobId);
    const res = await appel({ path: 'déjà', name: 'Nom de l’agent' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean; name: string }).toMatchObject({
      ok: true,
      created: false,
      name: 'Le nom de Quentin',
    });
    const row = await ligne(abs);
    expect(row?.displayName).toBe('Le nom de Quentin');
    expect(row?.registeredFrom).toBe('spaces');
  });

  it('un dossier RENOMMÉ depuis l’onglet Code (comptabilité, jamais déclaré) garde son nom en devenant projet', async () => {
    // La ligne existe SANS `registered_at` (un renommage, 0086) : l'upsert la
    // déclare (le `setWhere` passe), et c'est précisément là que `display_name`
    // ne doit pas être dans le `set` — le nom du propriétaire survivrait au
    // `setWhere`, pas à un `set` qui le porterait.
    const abs = `${terrain}/renommé`;
    await db.insert(codeProjects).values({
      entityId: seed.entityId,
      projectPath: abs,
      projectKey: projectKey(abs),
      displayName: 'Le nom de Quentin',
    });

    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-c2');
    await questionRepondue(jobId);
    const res = await appel({ path: 'renommé', name: 'Nom de l’agent' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean; name: string }).toMatchObject({
      ok: true,
      created: true,
      name: 'Le nom de Quentin',
    });
    const row = await ligne(abs);
    expect(row?.displayName).toBe('Le nom de Quentin');
    expect(row?.registeredAt).not.toBeNull();
    expect(row?.registeredFrom).toBe('conversation');
  });
});

describe('register_project — la garde « rien ne se crée en silence »', () => {
  it('SANS question répondue : le travail suspend sur une approbation ordinaire, rien n’est créé', async () => {
    const jobId = await jobNeuf();
    const res = await executeTool(
      outil(),
      { path: 'silencieux' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-1' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');

    const [row] = await db
      .select()
      .from(approvalRequests)
      .where(
        and(eq(approvalRequests.jobId, jobId), eq(approvalRequests.toolName, 'register_project')),
      );
    expect(row).toBeDefined();
    // `approval`, pas `question` : cet outil ne demande rien, il ATTEND une
    // décision — c'est la carte d'approbation ordinaire.
    expect(row?.kind).toBe('approval');
    expect(row?.status).toBe('pending');

    await expect(stat(`${terrain}/silencieux`)).rejects.toThrow();
    expect(await toutesLesLignes(`${terrain}/silencieux`)).toHaveLength(0);
  });

  it("une question DÉCLINÉE n'est pas une réponse : la porte tient", async () => {
    const jobId = await jobNeuf();
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      toolCallId: `call-ask-refus-${jobId}`,
      toolName: 'ask_user',
      toolInput: { question: 'Où ?', options: ['a', 'b'] },
      kind: 'question',
      status: 'rejected',
      resolvedAt: new Date(),
    });

    const res = await executeTool(
      outil(),
      { path: 'refuse' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-2' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    await expect(stat(`${terrain}/refuse`)).rejects.toThrow();
  });

  it('une question répondue dans un AUTRE job ne déverrouille pas celui-ci', async () => {
    const autreJob = await jobNeuf();
    await questionRepondue(autreJob);
    const jobId = await jobNeuf();

    const res = await executeTool(
      outil(),
      { path: 'voisin' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-3' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    await expect(stat(`${terrain}/voisin`)).rejects.toThrow();
  });

  it('sous `fully_autonomous`, le propriétaire a déjà tranché : la création passe sans question', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-d');

    const res = await appel({ path: 'yolo' }, jobId, conversationId, 'fully_autonomous');
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
    expect((await stat(`${terrain}/yolo`)).isDirectory()).toBe(true);
    // Sans `name`, le nom affiché est celui du dossier.
    expect((await ligne(`${terrain}/yolo`))?.displayName).toBeNull();
    expect(await projetDeLaConversation(conversationId)).toBe((await ligne(`${terrain}/yolo`))?.id);
  });
});
