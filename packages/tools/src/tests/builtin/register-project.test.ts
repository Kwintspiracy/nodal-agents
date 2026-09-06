// register-project.test.ts — « où écrire ? » devient un projet, et rien ne se
// crée en silence (P10b, plan « De la maquette au produit »).
//
// Tout passe par `executeTool` avec le VRAI outil du registre, un terrain
// temporaire réel et une base pglite : la porte d'approbation est donc dans le
// chemin, comme en production. Les assertions portent sur le DOSSIER sur le
// disque et sur les LIGNES relues (`code_projects`, `agent_jobs`,
// `conversations`, `approval_requests`), jamais sur des compteurs d'appels.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import type * as fsPromises from 'node:fs/promises';
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

/**
 * Le seul truquage de ce fichier, et il est ciblé : `rmdir`.
 *
 * La branche de nettoyage distingue un échec BÉNIN (`ENOTEMPTY` — le dossier a
 * été rempli entre-temps, `ENOENT` — il a déjà disparu) d'un échec qui laisse
 * un dossier orphelin (`EACCES`, `EPERM`, une erreur d'E/S). Ces codes ne sont
 * pas provoquables depuis l'extérieur : entre le `mkdir` de l'outil et son
 * `rmdir`, rien d'observable ne s'intercale. `mkdir` et `stat` restent RÉELS —
 * le dossier est vraiment créé, et les autres cas le vérifient sur le disque.
 */
const fsHooks = vi.hoisted(() => ({ rmdirError: null as NodeJS.ErrnoException | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const reel = await importOriginal<typeof fsPromises>();
  return {
    ...reel,
    rmdir: async (path: Parameters<typeof reel.rmdir>[0]) => {
      const attendue = fsHooks.rmdirError;
      if (attendue) {
        fsHooks.rmdirError = null;
        throw attendue;
      }
      return reel.rmdir(path);
    },
  };
});

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
  fsHooks.rmdirError = null;
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
 * Le LIBELLÉ choisi est le paramètre. Depuis la passe 40 il doit être ÉGAL au
 * nom du projet ou à celui de son dossier — plus une phrase qui le contient.
 */
async function questionRepondue(
  jobId: string,
  answer = 'veille-ia',
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
    await questionRepondue(jobId, 'notes');

    const premier = await appel({ path: 'notes', name: 'Mes notes' }, jobId, conversationId);
    expect(premier.outcome).toBe('success');

    const jobDeux = await jobNeuf();
    await questionRepondue(jobDeux, 'notes');
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
    await questionRepondue(jobId, 'hors');

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
    await questionRepondue(jobId, 'déjà');
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
    await questionRepondue(jobId, 'renommé');
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
    await questionRepondue(jobId, 'fantome');

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
    await questionRepondue(jobId, 'deja-la');

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

describe('register_project — un rollback qui rate SE DIT (revue Codex, passe 40)', () => {
  function ctxRattachementCasse(jobId: string, db2?: ToolContext['db']): ToolContext {
    return { ...ctx(jobId, 'pas-un-uuid'), ...(db2 ? { db: db2 } : {}) } as ToolContext;
  }

  /** L'erreur que `rmdir` doit lever au prochain appel, ou `null` pour le vrai `rmdir`. */
  function rmdirLevera(code: string): void {
    const err: NodeJS.ErrnoException = new Error(`rmdir ${code}`);
    err.code = code;
    fsHooks.rmdirError = err;
  }

  it('ENOTEMPTY : quelque chose a été écrit dans le dossier, ce n’est PAS un échec de rollback', async () => {
    // Le dossier a été créé par cet appel, puis rempli avant le nettoyage. Le
    // laisser est le bon geste : la raison ne doit pas accuser le rollback.
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'rempli');
    rmdirLevera('ENOTEMPTY');

    const res = await executeTool(
      outil(),
      { path: 'rempli' },
      ctxRattachementCasse(jobId),
      options(),
    );
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    const out = res.output as { ok: boolean; reason: string };
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('attach_failed:attach_write_failed');
    // La ligne, elle, a bien été reprise : seul le dossier reste.
    expect(await toutesLesLignes(`${terrain}/rempli`)).toHaveLength(0);
  });

  it('EACCES : un dossier que l’appel a créé et n’a pas pu reprendre se dit', async () => {
    // Le `.catch(() => undefined)` d'avant la passe 40 avalait aussi les
    // permissions et les erreurs d'E/S : l'outil annonçait un simple
    // `attach_failed`, un dossier vide de plus sur le disque, et personne pour
    // le dire.
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'interdit');
    rmdirLevera('EACCES');

    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await executeTool(
        outil(),
        { path: 'interdit' },
        ctxRattachementCasse(jobId),
        options(),
      );
      expect(res.outcome).toBe('success');
      if (res.outcome !== 'success') return;
      const out = res.output as { ok: boolean; reason: string };
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('attach_failed:attach_write_failed;rollback_failed');

      const journal = erreurs.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(journal).toContain('PROJECT_ROLLBACK_DIR_FAILED');
      expect(journal).toContain('code=EACCES');
    } finally {
      erreurs.mockRestore();
    }
  });

  it('la suppression de la ligne qui LÈVE se dit dans la raison ET dans les logs', async () => {
    // Sans ce signal, l'outil annonçait le seul échec initial alors que le
    // projet peut encore apparaître dans Spaces : l'agent croyait n'avoir rien
    // créé (revue Codex, passe 40, constat hors demande).
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'sourd');

    const dbQuiRefuseDeSupprimer = new Proxy(db as object, {
      get(cible, prop, recepteur) {
        if (prop === 'delete') {
          return () => {
            throw new Error('delete refusé');
          };
        }
        return Reflect.get(cible, prop, recepteur) as unknown;
      },
    }) as unknown as ToolContext['db'];

    const erreurs = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const res = await executeTool(
        outil(),
        { path: 'sourd' },
        ctxRattachementCasse(jobId, dbQuiRefuseDeSupprimer),
        options(),
      );
      expect(res.outcome).toBe('success');
      if (res.outcome !== 'success') return;
      const out = res.output as { ok: boolean; reason: string };
      expect(out.ok).toBe(false);
      expect(out.reason).toBe('attach_failed:attach_write_failed;rollback_failed');

      const journal = erreurs.mock.calls.map((c) => String(c[0])).join(' | ');
      expect(journal).toContain('PROJECT_ROLLBACK_ROW_FAILED');
    } finally {
      erreurs.mockRestore();
    }

    // La ligne est TOUJOURS là — c'est précisément ce que la raison annonce.
    expect(await toutesLesLignes(`${terrain}/sourd`)).toHaveLength(1);
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
    await questionRepondue(autreJob, 'voisin');
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

  it('le libellé choisi EST le nom du DOSSIER : la création passe', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-lien-dossier');
    await questionRepondue(jobId, 'veille-ia');

    const res = await appel({ path: 'veille-ia' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('le libellé choisi EST le NOM affiché, écrit autrement que le dossier : la création passe', async () => {
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-lien-nom');
    await questionRepondue(jobId, 'Veille IA');

    const res = await appel({ path: 'veille-ia', name: 'Veille IA' }, jobId, conversationId);
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('une option qui CONTIENT le nom sans l’être ne crée rien (revue Codex, passe 40)', async () => {
    // Le scénario exact du constat bloquant : « Que faire ensuite ? » →
    // « Add notes to the README ». Le mot `notes` apparaît dans la phrase, mais
    // personne n'a choisi de créer un projet `notes`. La sous-chaîne suffisait
    // jusqu'à la passe 40 ; l'égalité ne s'y laisse pas prendre.
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'Add notes to the README', 'Que faire ensuite ?');

    const res = await executeTool(
      outil(),
      { path: 'notes' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-sous-chaine' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    await expect(stat(`${terrain}/notes`)).rejects.toThrow();
    expect(await toutesLesLignes(`${terrain}/notes`)).toHaveLength(0);
  });

  it('un libellé PRÉFIXÉ ne déverrouille plus rien : le préfixe a quitté l’option', async () => {
    // « New project: veille-ia » passait jusqu'à la passe 40. L'option porte
    // désormais le nom NU, et c'est la question qui dit qu'il serait créé —
    // sinon l'autorisation dépendrait d'une formulation.
    const jobId = await jobNeuf();
    await questionRepondue(jobId, 'New project: veille-ia');

    const res = await executeTool(
      outil(),
      { path: 'veille-ia' },
      { ...ctx(jobId, null), toolCallId: 'call-reg-prefixe' } as ToolContext,
      options(),
    );
    expect(res.outcome).toBe('awaiting_approval');
    await expect(stat(`${terrain}/veille-ia`)).rejects.toThrow();
  });

  it('au-delà de la borne, ce sont les questions les plus RÉCENTES qui comptent', async () => {
    // La lecture est plafonnée à cinquante questions approuvées. Sans ordre
    // explicite, `limit` prend cinquante lignes qu'aucune règle ne désigne, et
    // la réponse qui autorise pouvait tomber hors du lot d'un appel à l'autre
    // (revue Codex, passe 40, P2). Avec « les plus récentes d'abord », la
    // dernière décision de l'utilisateur est toujours celle qu'on lit.
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-borne');
    const debut = Date.now();
    for (let i = 0; i < 60; i += 1) {
      await db.insert(approvalRequests).values({
        entityId: seed.entityId,
        agentId: seed.agentId,
        jobId,
        toolCallId: `call-ask-vieux-${i}`,
        toolName: 'ask_user',
        toolInput: { question: 'Autre chose ?', options: [`option-${i}`, 'Something else'] },
        kind: 'question',
        status: 'approved',
        answer: `option-${i}`,
        resolvedAt: new Date(debut + i * 1000),
      });
    }
    // Celle qui autorise est la PLUS RÉCENTE des soixante et une.
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      toolCallId: 'call-ask-recent',
      toolName: 'ask_user',
      toolInput: { question: 'Où ranger cette synthèse ?', options: ['tardif', 'Something else'] },
      kind: 'question',
      status: 'approved',
      answer: 'tardif',
      resolvedAt: new Date(debut + 60 * 1000),
    });

    const res = await appel({ path: 'tardif' }, jobId, conversationId);
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect(res.output as { ok: boolean; created: boolean }).toMatchObject({
      ok: true,
      created: true,
    });
  });

  it('accents et casse : c’est le NOM qui lie, pas le dossier tréma-libre', async () => {
    // L'option est « ÉTÉ 2026 », repliée en « ete 2026 ». Le dernier segment du
    // chemin, `ete-2026`, ne lui est PAS égal — le tiret n'est pas un espace.
    // C'est donc le `name` (« Été 2026 ») qui doit être passé, et lui matche :
    // le repli retire les diacritiques et la casse, rien d'autre.
    const jobId = await jobNeuf();
    const conversationId = await conversationNeuve('chat-accents');
    // Le libellé est écrit en capitales, le nom du projet ne l'est pas : seul
    // le repli (NFKD + minuscules) les rend égaux.
    await questionRepondue(jobId, 'ÉTÉ 2026');

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
