// intent.test.ts — l'intention de mutation est-elle RÉELLEMENT posée, par le
// vrai `executeTool`, AVANT que le disque change ?
//
// Le fichier attaque le CÂBLAGE, pas la fonction. Quatre fois dans ce chantier
// un test vert n'a rien prouvé parce qu'il exerçait le helper directement :
// retirer le branchement laissait la suite verte. Ici tout passe donc par
// `executeTool`, avec les vrais outils, et TOUTES les assertions sont des
// lignes relues en base ou des fichiers constatés sur le disque.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, stat, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  agents,
  codeProjects,
  entities,
  jobDeliverableVerificationState,
  and,
  eq,
} from '@nodal-agents/db';
import { projectKey, normalizePath } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { writeMutationIntent } from '../verification/intent';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { fileEditTool } from '../builtin/file-ops/file-edit';
import { runCommandTool } from '../builtin/run-command';
import { runSkillScriptTool } from '../builtin/run-skill-script';
import { codeTaskTool } from '../builtin/code-task';
import { OFFICE_TOOLS } from '../builtin/office-ops';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

// `@electric-sql/pglite` n'est PAS une dépendance de ce paquet (le harnais la
// porte) : le type de la poignée est repris de la signature du harnais.
type TestPg = Awaited<ReturnType<typeof spinUpTestDb>>['pg'];

let db: TestDb;
let pg: TestPg;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  pg = res.pg;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-intent-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });

  // Un job NEUF par test : « zéro ligne pour ce job » devient une assertion
  // exacte au lieu d'un filtre sur des clés.
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'intent test',
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  jobId = job.id;

  // Le réglage d'espace revient au défaut (tout coché) — un test qui décoche
  // une surface ne doit pas décider pour les suivants.
  await db.update(entities).set({ verificationSurfaces: {} }).where(eq(entities.id, seed.entityId));
  await db.update(agents).set({ cliDefaults: null }).where(eq(agents.id, seed.agentId));
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
    ...over,
  } as unknown as ToolContext;
}

const opts: ExecuteOptions = { approvalRules: [], onApprovalRequired: async () => {} };

/** Les outils sous approbation par défaut tournent ici sur une règle explicite. */
function autoApprove(toolName: string): ExecuteOptions {
  const rule: ApprovalRule = {
    id: `rule-${toolName}`,
    toolName,
    action: 'auto_approve',
    agentId: seed.agentId,
    entityId: seed.entityId,
  };
  return { approvalRules: [rule], onApprovalRequired: async () => {} };
}

async function statesOf(job: string) {
  return db
    .select()
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, job));
}

async function projectRow(key: string) {
  const [row] = await db
    .select()
    .from(codeProjects)
    .where(and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, key)));
  return row;
}

const keyOf = (p: string): string => projectKey(normalizePath(p));

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

describe('l’intention de mutation, posée par executeTool', () => {
  // ── v7-A : le type de livrable vient de l'outil ──────────────────────────
  //
  // Le défaut corrigé ici : le type était écrit en dur à `code_project`, donc
  // un classeur écrit dans un dépôt salissait LE DÉPÔT. La finalisation
  // relançait `pnpm test` pour prouver un `.xlsx`, et le `.xlsx` n'était
  // vérifié par rien. MUTATION : remettre `deliverableType: 'code_project'`
  // dans `officeMutationTargets` fait rougir les deux tests qui suivent.

  const officeTool = (name: string) => {
    const tool = OFFICE_TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`outil office introuvable: ${name}`);
    return tool;
  };

  it('un .xlsx écrit dans un projet de code salit LE FICHIER, pas le projet', async () => {
    await writeFile(join(ws, 'package.json'), '{}');

    const res = await executeTool(
      officeTool('xlsx_create') as never,
      { path: 'rapport.xlsx', sheet: 'Feuille1' },
      ctx(),
      opts,
    );
    expect(res.outcome).toBe('success');
    expect(await exists(join(ws, 'rapport.xlsx'))).toBe(true);

    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.deliverableType).toBe('office_file');
    expect(row.canonicalKey).toBe(keyOf(join(ws, 'rapport.xlsx')));
    expect(row.dirtyGeneration).toBe(1);
    expect(row.decisionStatus).toBe('dirty');

    // LE point du lot : le projet n'a pas bougé. Aucune ligne `code_projects`
    // créée, donc aucun epoch à faire vieillir et aucune preuve à relancer.
    expect(await projectRow(keyOf(ws))).toBeUndefined();
    expect(rows.some((r) => r.deliverableType === 'code_project')).toBe(false);
  });

  it('code puis classeur dans le même dossier ⇒ DEUX livrables distincts', async () => {
    await writeFile(join(ws, 'package.json'), '{}');

    await executeTool(
      fileWriteTool as never,
      { path: 'src.ts', content: 'const a = 1;' },
      ctx(),
      opts,
    );
    await executeTool(
      officeTool('xlsx_create') as never,
      { path: 'donnees.xlsx', sheet: 'F1' },
      ctx(),
      opts,
    );

    const rows = (await statesOf(jobId)).sort((a, b) =>
      a.deliverableType.localeCompare(b.deliverableType),
    );
    expect(rows.map((r) => r.deliverableType)).toEqual(['code_project', 'office_file']);
    expect(rows[0]!.canonicalKey).toBe(keyOf(ws));
    expect(rows[1]!.canonicalKey).toBe(keyOf(join(ws, 'donnees.xlsx')));
    // Une seule écriture de code : l'epoch du projet vaut 1, pas 2. Le
    // classeur ne fait pas vieillir la configuration du dépôt.
    expect((await projectRow(keyOf(ws)))?.verificationEpoch).toBe(1);
  });

  it('un type de livrable sans règle de canonicalisation est REFUSÉ', async () => {
    // `document` est réservé par le plan, sans canonicaliseur branché. Une clé
    // inventée ici donnerait un état qui ne désigne rien : l'intention échoue,
    // et le seam refusera l'écriture.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const outcome = await writeMutationIntent(ctx(), {
        surface: 'fileOps',
        targets: [{ kind: 'file', path: join(ws, 'note.md'), deliverableType: 'document' }],
      });
      expect(outcome).toEqual({ kind: 'failed', code: 'intent_type_unsupported' });
      expect(
        err.mock.calls
          .map((c) => String(c[0]))
          .some((l) => l.includes('VERIFICATION_INTENT_TYPE_UNSUPPORTED type=document')),
      ).toBe(true);
    } finally {
      err.mockRestore();
    }
    expect(await statesOf(jobId)).toHaveLength(0);
    expect(await projectRow(keyOf(ws))).toBeUndefined();
  });

  it('file_write pose l’intention sur le PROJET ENGLOBANT', async () => {
    // Le dossier attaché porte un manifeste : c'est LUI le projet, et une
    // écriture trois niveaux plus bas le salit lui, pas `sub`.
    await writeFile(join(ws, 'package.json'), '{}');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'sub/deep/f.txt', content: 'x', create_dirs: true },
      ctx(),
      opts,
    );
    expect(res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.deliverableType).toBe('code_project');
    expect(row.canonicalKey).toBe(keyOf(ws));
    expect(row.dirtyGeneration).toBe(1);
    expect(row.decisionStatus).toBe('dirty');
    expect(normalizePath(row.displayPathSnapshot ?? '')).toBe(normalizePath(ws));

    const project = await projectRow(keyOf(ws));
    expect(project?.verificationEpoch).toBe(1);
  });

  it('crée la ligne code_projects qui n’existait pas', async () => {
    // La table est VIDE par défaut : elle n'existe que si le propriétaire a
    // renommé, masqué ou configuré. Sans cette création, la finalisation
    // verrouillerait puis lirait des lignes inexistantes.
    expect(await projectRow(keyOf(ws))).toBeUndefined();

    await executeTool(fileWriteTool as never, { path: 'a.txt', content: 'x' }, ctx(), opts);

    const project = await projectRow(keyOf(ws));
    expect(project).toBeDefined();
    expect(project!.entityId).toBe(seed.entityId);
    expect(project!.projectKey).toBe(keyOf(ws));
    expect(normalizePath(project!.projectPath)).toBe(normalizePath(ws));
  });

  it('deux écritures dans le MÊME tour ⇒ dirty_generation 2', async () => {
    // Preuve qu'il n'y a PAS de mémo par tour. Le checkpoint en a un (un
    // instantané git coûte cher) ; une intention est un UPDATE, et la seconde
    // écriture passerait sinon pour prouvée par la preuve de la première.
    await writeFile(join(ws, '.git'), '');

    await executeTool(fileWriteTool as never, { path: 'a.txt', content: '1' }, ctx(), opts);
    await executeTool(fileWriteTool as never, { path: 'b.txt', content: '2' }, ctx(), opts);

    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.dirtyGeneration).toBe(2);
    expect((await projectRow(keyOf(ws)))?.verificationEpoch).toBe(2);
  });

  it('run_command salit TOUT le périmètre d’écriture', async () => {
    // Un shell n'est pas un écrivain adressé. La commande est lancée DANS
    // `zeta` — et `alpha` doit être sale quand même : `cd ..`, un chemin
    // absolu ou un script appelé par le script écrivent où ils veulent. Se
    // limiter au cwd rendrait l'intention exacte dans le cas facile et FAUSSE
    // dans celui qui compte.
    await mkdir(join(ws, 'zeta'), { recursive: true });
    await mkdir(join(ws, 'alpha'), { recursive: true });

    const res = await executeTool(
      runCommandTool as never,
      { purpose: 'test', command: 'echo ok', cwd: 'zeta' },
      ctx(),
      autoApprove('run_command'),
    );
    expect(
      res.outcome === 'error' ? res.error : res.outcome,
      'la commande n’a pas atteint l’exécution',
    ).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey).sort()).toEqual(
      [keyOf(join(ws, 'alpha')), keyOf(join(ws, 'zeta'))].sort(),
    );
    for (const row of rows) expect(row.dirtyGeneration).toBe(1);

    // L'ordre rendu par le résolveur EST l'ordre de verrouillage : il doit être
    // croissant, pas celui du readdir ni celui des workspaces.
    const intent = await writeMutationIntent(ctx(), {
      surface: 'shell',
      targets: [{ kind: 'dir', path: ws, deliverableType: 'code_project' }],
    });
    expect(intent.kind).toBe('written');
    if (intent.kind !== 'written') return;
    expect(intent.deliverables.map((d) => d.key)).toEqual(
      [...intent.deliverables.map((d) => d.key)].sort(),
    );
  });

  it('file_edit pose l’intention sur le projet du fichier édité', async () => {
    await writeFile(join(ws, 'package.json'), '{}');
    await mkdir(join(ws, 'src'), { recursive: true });
    await writeFile(join(ws, 'src', 'a.ts'), 'const a = 1;\n');

    const res = await executeTool(
      fileEditTool as never,
      { path: 'src/a.ts', old_string: 'const a = 1;', new_string: 'const a = 2;' },
      ctx(),
      // D1 : réécrire un fichier existant du workspace partagé passe par
      // l'approbation ; la règle explicite la lève ici.
      autoApprove('file_edit'),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey)).toEqual([keyOf(ws)]);
    expect(rows[0]!.dirtyGeneration).toBe(1);
  });

  it('run_skill_script salit tout le périmètre AVANT même que le script soit autorisé', async () => {
    // L'intention est posée au seam, avant `tool.execute` : le refus
    // d'autorisation du script (GATE 2) arrive APRÈS, et le périmètre reste
    // conservativement sale — une tentative qui n'écrit rien reste sale.
    await mkdir(join(ws, 'alpha'), { recursive: true });
    await mkdir(join(ws, 'beta'), { recursive: true });

    const res = await executeTool(
      runSkillScriptTool as never,
      { purpose: 'test', skill: 'skill-inexistante', script: 'scripts/x.js' },
      ctx(),
      autoApprove('run_skill_script'),
    );
    expect(res.outcome).toBe('error');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey).sort()).toEqual(
      [keyOf(join(ws, 'alpha')), keyOf(join(ws, 'beta'))].sort(),
    );
  });

  it('racine attachée vide (ni manifeste ni sous-dossier) ⇒ aucune cible, l’écriture passe', async () => {
    // Le trou est NOMMÉ : un shell qui crée le PREMIER projet d'une racine
    // vide n'a rien à salir avant de l'avoir créé (le modèle « projet = enfant
    // direct » ; l'intention sur la racine elle-même est refusée par le plan,
    // elle créerait une clé que l'onglet Code ne montre jamais).
    const res = await executeTool(
      runCommandTool as never,
      { purpose: 'test', command: 'echo ok' },
      ctx(),
      autoApprove('run_command'),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    expect(await statesOf(jobId)).toHaveLength(0);
    expect(await projectRow(keyOf(ws))).toBeUndefined();
  });

  it('racine attachée par un LIEN (jonction / symlink) ⇒ l’intention est posée, sous l’identité LEXICALE de la racine', async () => {
    // Le symptôme de la CI Windows (PR #46) : `os.tmpdir()` y rend la forme
    // courte 8.3, `resolveAndCheckPath` rend la forme réelle, et la cible ne
    // tombait « dans » aucune racine. Un lien reproduit exactement cet écart
    // sur toutes les plateformes : la racine est le lien, la cible résolue
    // est le vrai dossier. L'identité rendue est celle de la racine TELLE
    // QU'ÉCRITE (le lien) : c'est celle que l'onglet Code dérive — nommer le
    // dossier réel ferait deux lignes code_projects pour un même projet
    // (revue Codex PR #46, passe 2).
    await writeFile(join(ws, 'package.json'), '{}');
    const link = join(root, 'ws-link');
    await symlink(ws, link, process.platform === 'win32' ? 'junction' : 'dir');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'via-lien.txt', content: 'x' },
      ctx({ workspaces: [{ label: 'shared', path: link }] }),
      opts,
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonicalKey).toBe(keyOf(link));
    expect(rows[0]!.canonicalKey).not.toBe(keyOf(realpathSync.native(ws)));
    expect(normalizePath(rows[0]!.displayPathSnapshot ?? '')).toBe(normalizePath(link));
  });

  it('deux racines qui se contiennent (un lien vers le conteneur, et un projet du conteneur attaché à part) ⇒ la plus SPÉCIFIQUE nomme le projet', async () => {
    // Revue Codex PR #46, passe 3 : prendre la première racine dans l'ordre de
    // configuration rattachait la cible au lien (`/liens/depot/app`) alors
    // que l'outil et l'onglet Code la rattachent au projet attaché à part.
    const app = join(ws, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'package.json'), '{}');
    const link = join(root, 'lien-conteneur');
    await symlink(ws, link, process.platform === 'win32' ? 'junction' : 'dir');

    const res = await executeTool(
      fileWriteTool as never,
      // Le label `app` : l'outil résout la cible sous la racine la plus profonde.
      { path: 'app/x.txt', content: 'x' },
      ctx({
        workspaces: [
          { label: 'lien', path: link },
          { label: 'app', path: app },
        ],
      }),
      opts,
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey)).toEqual([keyOf(app)]);
  });

  it('une racine réelle PARENTE et une racine LIÉE plus spécifique ⇒ la liée nomme le projet (aucun raccourci lexical)', async () => {
    // Revue Codex PR #46, passe 4 : la cible réelle tombe sous la racine
    // parente (attachée telle quelle) ET sous la racine liée (un lien vers
    // un sous-dossier). Le raccourci « déjà sous une racine lexicale » la
    // laissait au parent ; la règle unique par chemins réels choisit la plus
    // spécifique — celle que l'onglet Code dérive pour le label employé.
    const app = join(ws, 'app');
    await mkdir(app, { recursive: true });
    await writeFile(join(app, 'package.json'), '{}');
    const linkToApp = join(root, 'lien-app');
    await symlink(app, linkToApp, process.platform === 'win32' ? 'junction' : 'dir');

    const res = await executeTool(
      fileWriteTool as never,
      // Le label `app` : l'outil résout sous la racine liée, la cible réelle
      // tombe aussi sous la racine parente.
      { path: 'app/x.txt', content: 'x' },
      ctx({
        workspaces: [
          { label: 'conteneur', path: ws },
          { label: 'app', path: linkToApp },
        ],
      }),
      opts,
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey)).toEqual([keyOf(linkToApp)]);
  });

  it('plafond de 12 projets par racine, dossiers cachés exclus', async () => {
    for (let i = 1; i <= 13; i++) {
      await mkdir(join(ws, `p${String(i).padStart(2, '0')}`), { recursive: true });
    }
    // Des dossiers cachés qui ne sont PAS des manifestes (`.git` en est un :
    // il ferait de la racine elle-même le projet, ce qui est un autre cas).
    await mkdir(join(ws, '.cache'), { recursive: true });
    await mkdir(join(ws, '.venv'), { recursive: true });

    const res = await executeTool(
      runCommandTool as never,
      { purpose: 'test', command: 'echo ok' },
      ctx(),
      autoApprove('run_command'),
    );
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const keys = (await statesOf(jobId)).map((r) => r.canonicalKey).sort();
    expect(keys).toHaveLength(12);
    expect(keys).toEqual(
      Array.from({ length: 12 }, (_, i) =>
        keyOf(join(ws, `p${String(i + 1).padStart(2, '0')}`)),
      ).sort(),
    );
    expect(keys.some((k) => k.endsWith('/.cache') || k.endsWith('/.venv'))).toBe(false);
  });

  it('code_task en READ ne pose rien, en WRITE salit le projet du cwd', async () => {
    // Le contrôle qui empêche ce test d'être vide : le même appel, le même
    // chemin de code, un seul mot qui change. Si la lecture ne posait rien
    // parce que l'appel n'atteignait jamais le seam, l'écriture ne poserait
    // rien non plus.
    await writeFile(join(ws, 'package.json'), '{}');
    // Le fournisseur est coupé POUR CET AGENT, en base : `execute` refuse
    // aussitôt après le seam, sans jamais lancer de CLI. Un test qui
    // dépendrait du CLI installé sur la machine ne prouverait rien de stable.
    await db
      .update(agents)
      .set({ cliDefaults: { claude: { enabled: false } } })
      .where(eq(agents.id, seed.agentId));

    const call = {
      purpose: 'test',
      provider: 'claude',
      task: 'ne rien faire',
    };

    const read = await executeTool(
      codeTaskTool as never,
      { ...call, mode: 'read' },
      ctx(),
      autoApprove('code_task'),
    );
    // Le CLI n'est pas installé sur la machine de test : l'appel échoue APRÈS
    // le seam. Ce qui compte est qu'il ne se soit pas arrêté à l'approbation.
    expect(read.outcome).toBe('error');
    expect(await statesOf(jobId)).toHaveLength(0);
    expect(await projectRow(keyOf(ws))).toBeUndefined();

    const write = await executeTool(
      codeTaskTool as never,
      { ...call, mode: 'write' },
      ctx(),
      autoApprove('code_task'),
    );
    expect(write.outcome).toBe('error');
    const rows = await statesOf(jobId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.canonicalKey).toBe(keyOf(ws));
    expect(rows[0]!.dirtyGeneration).toBe(1);
  });
});

describe('les refus et les silences interdits', () => {
  it('surface décochée ⇒ aucune ligne, trace posée, et le fichier EST écrit', async () => {
    // D8 : décochée ne veut pas dire bloquée. Le travail passe, hors
    // vérification, et le run le DIT — jamais un silence (inv. #4).
    await db
      .update(entities)
      .set({ verificationSurfaces: { fileOps: false } })
      .where(eq(entities.id, seed.entityId));

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'x' },
      ctx(),
      opts,
    );
    expect(res.outcome).toBe('success');
    expect(await exists(join(ws, 'a.txt'))).toBe(true);

    expect(await statesOf(jobId)).toHaveLength(0);
    expect(await projectRow(keyOf(ws))).toBeUndefined();

    const [job] = await db
      .select({ skipped: agentJobs.verificationSkippedSurfaces })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(job!.skipped).toEqual(['fileOps']);

    // Idempotent : une seconde écriture n'ajoute pas une seconde fois la clé.
    await executeTool(fileWriteTool as never, { path: 'b.txt', content: 'y' }, ctx(), opts);
    const [again] = await db
      .select({ skipped: agentJobs.verificationSkippedSurfaces })
      .from(agentJobs)
      .where(eq(agentJobs.id, jobId));
    expect(again!.skipped).toEqual(['fileOps']);
  });

  it('job terminal ⇒ rien n’est écrit sur sa décision, et l’écriture est REFUSÉE', async () => {
    // Un job annulé qui continue d'écrire n'est pas annulé, et aucune
    // finalisation ne repassera prouver ce qu'il change : le disque reste
    // intact, et rien n'est posé sur la décision.
    await db.update(agentJobs).set({ status: 'cancelled' }).where(eq(agentJobs.id, jobId));

    const outcome = await writeMutationIntent(ctx(), {
      surface: 'fileOps',
      targets: [{ kind: 'file', path: join(ws, 'a.txt'), deliverableType: 'code_project' }],
    });
    expect(outcome.kind).toBe('already_terminal');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'x' },
      ctx(),
      opts,
    );
    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') return;
    expect(res.error).toBe('verification_intent_failed: intent_already_terminal');
    expect(await exists(join(ws, 'a.txt')), 'un job terminal a écrit sur le disque').toBe(false);
    expect(await statesOf(jobId)).toHaveLength(0);
    expect(await projectRow(keyOf(ws))).toBeUndefined();
  });

  it('tour de chat (pas de jobId) ⇒ skipped no_job_context, code journalisé, rien en base', async () => {
    // Le runtime CLI chat n'a pas de job (T17) ; la ligne d'état a une FK NOT
    // NULL vers agent_jobs. Le helper le DIT par un code — jamais un return
    // muet — et ne pose rien : ni état, ni ligne code_projects.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await writeMutationIntent(
        { db, entityId: seed.entityId, jobId: null, workspaces: [{ label: 'shared', path: ws }] },
        {
          surface: 'cliRuntime',
          targets: [{ kind: 'dir', path: ws, deliverableType: 'code_project' }],
        },
      );
      expect(outcome).toEqual({ kind: 'skipped', reason: 'no_job_context', surface: 'cliRuntime' });
      const logged = warn.mock.calls.map((c) => String(c[0]));
      expect(logged.some((l) => l.includes('VERIFICATION_NO_JOB_CONTEXT surface=cliRuntime'))).toBe(
        true,
      );
    } finally {
      warn.mockRestore();
    }
    expect(await projectRow(keyOf(ws))).toBeUndefined();
  });

  it('entityId vide ⇒ REFUS, et le fichier n’existe pas', async () => {
    // Le runner construit `entityId: job.entityId ?? ''` en cinq points. Un
    // upsert `code_projects` avec entity_id = '' lèverait au milieu de la
    // transaction : ce cas se refuse, il ne se contourne pas.
    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'x' },
      ctx({ entityId: '' }),
      opts,
    );

    expect(res.outcome).toBe('error');
    if (res.outcome !== 'error') return;
    expect(res.error).toMatch(/^verification_intent_failed:/);
    expect(await exists(join(ws, 'a.txt')), 'le fichier a été écrit sans intention').toBe(false);
  });

  it('échec d’intention ⇒ l’écriture est REFUSÉE, rien sur le disque', async () => {
    // La table d'état retirée sous les pieds du helper. Le contrat entier : une
    // garde qui échoue en silence est pire que pas de garde.
    await pg.exec('ALTER TABLE job_deliverable_verification_state RENAME TO jdvs_hidden_for_test;');
    try {
      const res = await executeTool(
        fileWriteTool as never,
        { path: 'a.txt', content: 'x' },
        ctx(),
        opts,
      );
      expect(res.outcome).toBe('error');
      if (res.outcome !== 'error') return;
      expect(res.error).toMatch(/^verification_intent_failed:/);
      expect(await exists(join(ws, 'a.txt')), 'le fichier a été écrit sans intention').toBe(false);
    } finally {
      await pg.exec(
        'ALTER TABLE jdvs_hidden_for_test RENAME TO job_deliverable_verification_state;',
      );
    }

    // La transaction a ROULÉ EN ARRIÈRE : la ligne code_projects créée juste
    // avant l'échec ne survit pas, sinon l'epoch aurait avancé sans intention.
    expect(await projectRow(keyOf(ws))).toBeUndefined();
  });
});
