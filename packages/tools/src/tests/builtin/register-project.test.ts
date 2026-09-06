// register-project.test.ts — « où écrire ? » devient un projet, et rien ne se
// crée en silence (P10b, plan « De la maquette au produit »).
//
// Tout passe par `executeTool` avec le VRAI outil du registre, un terrain
// temporaire réel et une base pglite : la porte d'approbation est donc dans le
// chemin, comme en production. Les assertions portent sur le DOSSIER sur le
// disque et sur les LIGNES relues (`code_projects`, `agent_jobs`,
// `conversations`, `approval_requests`), jamais sur des compteurs d'appels.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
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

/**
 * La question `ask_user` de ce job, RÉPONDUE — ce que le clic laisse en base.
 *
 * Le LIBELLÉ choisi est le paramètre : depuis la passe 39, c'est lui qui doit
 * nommer le projet pour que la création passe sans second clic.
 */
async function questionRepondue(
  jobId: string,
  answer = 'New project: veille-ia',
  question = 'Où ranger cette synthèse ?',
): Promise<void> {
  await db.insert(approvalRequests).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    toolCallId: `call-ask-${jobId}-${answer}`,
    toolName: 'ask_user',
    toolInput: { question, options: [answer, 'Something else'] },
    kind: 'question',
    status: 'approved',
    answer,
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
    await questionRepondue(jobId, 'New project: notes');

    const premier = await appel({ path: 'notes', name: 'Mes notes' }, jobId, conversationId);
    expect(premier.outcome).toBe('success');

    const jobDeux = await jobNeuf();
    await questionRepondue(jobDeux, 'New project: notes');
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
    await questionRepondue(jobId, 'New project: hors');

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
    await questionRepondue(jobId, 'New project: déjà');
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
    await questionRepondue(jobId, 'New project: renommé');
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

describe('register_project — le rattachement rate : rien ne reste (revue Codex, passe 39)', () => {
  /**
   * Un rattachement qui ÉCHOUE pour de vrai, sans truquer l'outil.
   *
   * Un `jobId` inexistant ne convient pas : `registered_job_id` porte une clé
   * étrangère vers `agent_jobs`, donc l'upsert casserait AVANT le rattachement
   * et le test ne prouverait rien du nettoyage. Un id de conversation qui n'est
   * pas un uuid, lui, ne gêne pas l'upsert et fait lever l'UPDATE de la
   * conversation à l'intérieur de la transaction : `attach_write_failed`.
   * C'est un cas réel — les uuid orphelins d'avant P6 que l'absence de clé
   * étrangère conserve délibérément.
   */
  function ctxRattachementCasse(jobId: string): ToolContext {
    return { ...ctx(jobId, 'pas-un-uuid') } as ToolContext;
  }

  it('la ligne déclarée par CET appel est retirée, et le dossier qu’il a créé aussi', async () => {
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'New project: fantome');

    const res = await executeTool(
      outil(),
      { path: 'fantome' },
      ctxRattachementCasse(jobId),
      options(),
    );
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    const out = res.output as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason.startsWith('attach_failed:')).toBe(true);

    // Rien dans Spaces, rien sur le disque : l'échec est un vrai échec.
    expect(await toutesLesLignes(`${terrain}/fantome`)).toHaveLength(0);
    await expect(stat(`${terrain}/fantome`)).rejects.toThrow();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('un dossier VIDE qui existait AVANT l’appel n’est pas effacé', async () => {
    // Vide exprès : `rmdir` réussirait dessus. Ce qui le sauve n'est donc pas
    // le hasard d'un dossier peuplé, c'est le drapeau `existedBefore`.
    const abs = `${terrain}/deja-la`;
    await mkdir(abs, { recursive: true });

    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'New project: deja-la');

    const res = await executeTool(
      outil(),
      { path: 'deja-la' },
      ctxRattachementCasse(jobId),
      options(),
    );
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect((res.output as { ok: boolean }).ok).toBe(false);

    // La ligne déclarée par cet appel part ; le dossier du propriétaire reste.
    expect(await toutesLesLignes(abs)).toHaveLength(0);
    expect((await stat(abs)).isDirectory()).toBe(true);
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
    await questionRepondue(autreJob, 'New project: voisin');
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

  it('une question répondue sur AUTRE CHOSE ne crée pas ce projet (revue Codex, passe 39)', async () => {
    // Le scénario exact du constat bloquant : « Quelle couleur ? » → « Bleu ».
    // La question a bien été posée et répondue dans ce job, mais rien dans ce
    // qui a été choisi ne parle de `comptabilite`.
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'Bleu', 'Quelle couleur utiliser ?');

    const res = await executeTool(
      outil(),
      { path: 'comptabilite' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-couleur' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    await expect(stat(`${terrain}/comptabilite`)).rejects.toThrow();
    expect(await toutesLesLignes(`${terrain}/comptabilite`)).toHaveLength(0);
  });

  it('le libellé choisi nomme le DOSSIER : la création passe', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-lien-dossier');
    await questionRepondue(jobId, 'New project: veille-ia');

    const res = await appel({ path: 'veille-ia' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('le libellé choisi nomme le NOM affiché, écrit autrement que le dossier : la création passe', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-lien-nom');
    await questionRepondue(jobId, 'New project: Veille IA');

    const res = await appel({ path: 'veille-ia', name: 'Veille IA' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('accents et casse : c’est le NOM qui lie, pas le dossier tréma-libre', async () => {
    // « Nouveau projet : Été 2026 » replié donne « nouveau projet : ete 2026 ».
    // Le dernier segment du chemin, `ete-2026`, n'y est PAS contenu — le tiret
    // n'est pas un espace. C'est donc le `name` (« Été 2026 ») qui doit être
    // passé, et lui matche : le repli retire les diacritiques et la casse.
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-accents');
    // Le libellé est écrit en capitales, le nom du projet ne l'est pas : seul
    // le repli (NFKD + minuscules) les rapproche.
    await questionRepondue(jobId, 'Nouveau projet : ÉTÉ 2026');

    const sansNom = await executeTool(
      outil(),
      { path: 'ete-2026' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-accent-1' } as ToolContext,
      options(),
    );
    expect(sansNom.outcome).toBe('awaiting_approval');

    const avecNom = await appel({ path: 'ete-2026', name: 'Été 2026' }, jobId, conversationId);
    expect(avecNom.outcome).toBe('success');
    if (avecNom.outcome !== 'success') return;
    expect(avecNom.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
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
