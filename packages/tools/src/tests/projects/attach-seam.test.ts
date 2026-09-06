// attach-seam.test.ts — le CÂBLAGE du registre, par le VRAI seam.
//
// `attach.test.ts` prouve la RÈGLE ; ce fichier prouve qu'elle est BRANCHÉE.
// La distinction a coûté quatre fois au dépôt (lot du 27/08) : un test qui
// appelle la fonction directement reste vert quand le site d'appel disparaît.
// Ici, rien n'appelle `attachProductionToProject` : on passe par `executeTool`
// avec le vrai `file_write`, un workspace temporaire réel, et on relit les
// TROIS traces — le fichier sur le disque, la ligne `tool_calls`, le
// `project_id` du job.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, approvalRequests, codeProjects, toolCalls, eq } from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { createToolRegistry } from '../../registry';
import { registerBuiltins } from '../../builtin';
import { executeTool } from '../../execute';
import { MAX_WRITE_BYTES } from '../../builtin/file-ops/workspace';
import type { ExecuteOptions, ToolContext } from '../../types';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let racine = '';

const registry = createToolRegistry();
registerBuiltins(registry);

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  // `realpath` : sur Windows, `tmpdir()` peut rendre la forme courte 8.3 alors
  // que les outils résolvent en forme longue. Le terrain est donc pris sous sa
  // forme réelle, comme un propriétaire qui attache un dossier existant.
  racine = normalizePath(realpathSync.native(await mkdtemp(join(tmpdir(), 'nodal-attach-seam-'))));
});

afterEach(async () => {
  try {
    await rm(racine, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'seam' })
    .returning({ id: agentJobs.id });
  if (!job) throw new Error('insert job');
  return job.id;
}

async function projetEnregistre(path: string): Promise<string> {
  const [row] = await db
    .insert(codeProjects)
    .values({
      entityId: seed.entityId,
      projectPath: path,
      projectKey: projectKey(path),
      displayName: 'Projet X',
      agentId: seed.agentId,
      registeredAt: new Date(),
      registeredFrom: 'spaces',
    })
    .returning({ id: codeProjects.id });
  if (!row) throw new Error('insert projet');
  return row.id;
}

function ctx(workspacePath: string, jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'terrain', path: workspacePath }],
    turn: 1,
  } as unknown as ToolContext;
}

function options(): ExecuteOptions {
  return {
    approvalRules: [
      {
        id: 'rule-file-write',
        toolName: 'file_write',
        action: 'auto_approve',
        agentId: seed.agentId,
        entityId: seed.entityId,
      },
    ] as ExecuteOptions['approvalRules'],
    onApprovalRequired: async () => {},
  };
}

async function projetDuJob(jobId: string): Promise<string | null> {
  const [row] = await db
    .select({ projectId: agentJobs.projectId })
    .from(agentJobs)
    .where(eq(agentJobs.id, jobId));
  if (!row) throw new Error('job introuvable');
  return row.projectId;
}

describe('le registre au seam d’exécution', () => {
  it('file_write dans un projet enregistré : le fichier, la ligne d’audit ET le rattachement', async () => {
    const terrain = racine;
    // Un manifeste : le terrain lui-même est le projet, comme un dépôt attaché.
    await writeFile(join(terrain, 'package.json'), '{}');
    const projetPath = `${terrain}/projet-x`;
    await mkdir(projetPath, { recursive: true });
    const projetId = await projetEnregistre(projetPath);
    const jobId = await jobNeuf();

    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: 'projet-x/src/a.ts', content: 'export const a = 1;\n', create_dirs: true },
      ctx(terrain, jobId),
      options(),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    // 1. Le fichier est sur le disque, avec son contenu.
    expect(await readFile(join(projetPath, 'src', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');

    // 2. La ligne d'audit existe pour ce job.
    const audit = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, jobId));
    expect(audit.map((r) => r.toolName)).toContain('file_write');

    // 3. Le job porte le projet — la trace qui n'existait pas avant P5.
    expect(await projetDuJob(jobId)).toBe(projetId);
  });

  it('un chemin HORS terrain reste refusé, et n’attache rien', async () => {
    const terrain = racine;
    await writeFile(join(terrain, 'package.json'), '{}');
    // Le projet enregistré existe : si le rattachement se faisait sans regarder
    // la cible, ce test le verrait.
    await projetEnregistre(terrain);
    const jobId = await jobNeuf();

    const dehors = normalizePath(join(racine, '..', 'hors-terrain.txt'));
    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: dehors, content: 'interdit' },
      ctx(terrain, jobId),
      options(),
    );

    // L'outil refuse comme aujourd'hui : P5 ne change RIEN au périmètre.
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    const output = res.output as { ok: boolean; reason?: string };
    expect(output.ok).toBe(false);
    expect(output.reason ?? '').not.toBe('');

    // Le fichier n'existe pas, et aucun projet n'a été rattaché.
    await expect(readFile(dehors, 'utf8')).rejects.toThrow();
    expect(await projetDuJob(jobId)).toBeNull();
  });

  it('une écriture qui ÉCHOUE dans le projet ne rattache rien ; la suivante, réussie, rattache (revue passe 27)', async () => {
    const terrain = racine;
    await writeFile(join(terrain, 'package.json'), '{}');
    const projetId = await projetEnregistre(terrain);
    const jobId = await jobNeuf();
    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');

    // Trop gros : l'outil refuse (`ok: false`, un échec sous carte `text`) — la
    // cible était pourtant DANS le projet. Avant la passe 27, le job était
    // rattaché avant même que l'outil ne réponde.
    const tropGros = await executeTool(
      tool,
      { path: 'gros.txt', content: 'x'.repeat(MAX_WRITE_BYTES + 1) },
      ctx(terrain, jobId),
      options(),
    );
    expect(tropGros.outcome).toBe('success');
    if (tropGros.outcome !== 'success') return;
    expect((tropGros.output as { ok: boolean }).ok).toBe(false);
    await expect(readFile(join(terrain, 'gros.txt'), 'utf8')).rejects.toThrow();
    expect(await projetDuJob(jobId)).toBeNull();

    // La même cible, une écriture qui aboutit : c'est elle qui rattache.
    const petit = await executeTool(
      tool,
      { path: 'petit.txt', content: 'ok' },
      ctx(terrain, jobId),
      options(),
    );
    expect(petit.outcome).toBe('success');
    expect(await readFile(join(terrain, 'petit.txt'), 'utf8')).toBe('ok');
    expect(await projetDuJob(jobId)).toBe(projetId);
  });
});

describe('le registre au seam d’exécution — la DÉCLARATION (P5b)', () => {
  const ligneDeclaree = async (path: string) => {
    const [row] = await db
      .select({
        id: codeProjects.id,
        registeredAt: codeProjects.registeredAt,
        registeredFrom: codeProjects.registeredFrom,
        registeredJobId: codeProjects.registeredJobId,
        agentId: codeProjects.agentId,
      })
      .from(codeProjects)
      .where(eq(codeProjects.projectKey, projectKey(path)));
    return row ?? null;
  };

  it('file_write dans un dossier À MANIFESTE que personne n’a déclaré : la ligne est DÉCLARÉE par ce job, qui s’y rattache', async () => {
    const terrain = racine;
    // Le terrain n'a PAS de manifeste ; `app` en a un : c'est `app` le projet.
    const app = `${terrain}/app`;
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'package.json'), '{}');
    const jobId = await jobNeuf();

    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: 'app/src/a.ts', content: 'export const a = 1;\n', create_dirs: true },
      ctx(terrain, jobId),
      options(),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect((res.output as { ok: boolean }).ok).toBe(true);

    const row = await ligneDeclaree(app);
    expect(row, 'app n’a pas été déclaré').not.toBeNull();
    expect(row!.registeredAt).not.toBeNull();
    expect(row).toMatchObject({
      registeredFrom: 'conversation',
      registeredJobId: jobId,
      agentId: seed.agentId,
    });
    expect(await projetDuJob(jobId)).toBe(row!.id);
    // Le terrain, sans manifeste, n'est pas un projet.
    expect(await ligneDeclaree(terrain)).toBeNull();
  });

  it('une écriture qui ÉCHOUE dans un dossier à manifeste ne déclare rien', async () => {
    const terrain = racine;
    const app = `${terrain}/app`;
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'package.json'), '{}');
    const jobId = await jobNeuf();

    const tool = registry.get('file_write');
    if (!tool) throw new Error('file_write absent du registre');
    const res = await executeTool(
      tool,
      { path: 'app/gros.txt', content: 'x'.repeat(MAX_WRITE_BYTES + 1) },
      ctx(terrain, jobId),
      options(),
    );
    expect(res.outcome).toBe('success');
    if (res.outcome !== 'success') return;
    expect((res.output as { ok: boolean }).ok).toBe(false);

    // L'intention a pu poser sa ligne de COMPTABILITÉ ; elle n'est pas déclarée.
    const row = await ligneDeclaree(app);
    expect(row?.registeredAt ?? null).toBeNull();
    expect(await projetDuJob(jobId)).toBeNull();
  });
});

// ─── P10b : « où écrire ? » de bout en bout ──────────────────────────────────
//
// Le geste complet, par le seam et rien d'autre : l'utilisateur a répondu à une
// question, l'agent crée le projet, puis il écrit dedans. Trois traces relues —
// le projet porté par le job, la ligne `tool_calls` du `file_write`, le fichier
// sur le disque.
describe('le registre au seam d’exécution — register_project puis file_write (P10b)', () => {
  it('la réponse crée le projet, et l’écriture suivante y atterrit', async () => {
    const terrain = racine;
    const jobId = await jobNeuf();

    // Ce que le clic de l'utilisateur a laissé en base (P10a).
    await db.insert(approvalRequests).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      toolCallId: `call-ask-${jobId}`,
      toolName: 'ask_user',
      // L'option EST le nom du projet, sans préfixe : c'est la question qui dit
      // que celle-là serait créée (revue Codex, passe 40).
      toolInput: {
        question: 'Où ranger cette synthèse ? « veille-ia » serait créé.',
        options: ['veille-ia', 'Something else'],
      },
      kind: 'question',
      status: 'approved',
      answer: 'veille-ia',
      resolvedAt: new Date(),
    });

    const reg = registry.get('register_project');
    if (!reg) throw new Error('register_project absent du registre');
    const creation = await executeTool(
      reg,
      { path: 'veille-ia', name: 'Veille IA' },
      ctx(terrain, jobId),
      options(),
    );
    expect(creation.outcome === 'error' ? creation.error : creation.outcome).toBe('success');
    if (creation.outcome !== 'success') return;
    const projet = creation.output as { ok: boolean; project_id: string; path: string };
    expect(projet.ok).toBe(true);

    // Le job porte le projet DÈS la création — sans quoi le tour suivant
    // reposerait la même question.
    expect(await projetDuJob(jobId)).toBe(projet.project_id);

    const write = registry.get('file_write');
    if (!write) throw new Error('file_write absent du registre');
    const res = await executeTool(
      write,
      { path: 'veille-ia/synthese.md', content: '# Synthèse\n' },
      ctx(terrain, jobId),
      options(),
    );
    expect(res.outcome).toBe('success');

    // 1. Le fichier est là, avec son contenu.
    expect(await readFile(join(terrain, 'veille-ia', 'synthese.md'), 'utf8')).toBe('# Synthèse\n');
    // 2. Les deux lignes d'audit existent, dans l'ordre du geste.
    const audit = await db
      .select({ toolName: toolCalls.toolName })
      .from(toolCalls)
      .where(eq(toolCalls.jobId, jobId))
      .orderBy(toolCalls.createdAt);
    expect(audit.map((r) => r.toolName)).toEqual(['register_project', 'file_write']);
    // 3. Le job porte toujours CE projet — le premier gagne, et c'est le bon.
    expect(await projetDuJob(jobId)).toBe(projet.project_id);
    expect(normalizePath(projet.path)).toBe(`${terrain}/veille-ia`);
  });
});
