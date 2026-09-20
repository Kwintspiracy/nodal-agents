// classify-written-file-once.test.ts — un fichier écrit est classé UNE fois.
//
// Le défaut (relecture après coup de la PR #66 par le relecteur C, dette #88) :
// `file_write` et `file_edit` appelaient `deliverableTypeForWrittenFile` DEUX
// fois — dans `resolveMutationTargets`, qui décide sous quelle clé l'intention
// range l'état de vérification, puis dans `execute()`, qui décide de la clé que
// porte la carte. Entre les deux, la table `code_projects` peut changer : un
// autre travail déclare le dossier, ou quelqu'un le déclare depuis l'écran.
//
// Les deux sens sont muets à l'écran, et c'est tout le sujet :
//
//   document → code_project : l'état est rangé sous la clé DU FICHIER, la carte
//     repart sans `deliverable_key`, `DeliverableNote` n'affiche rien ;
//   code_project → document : l'état est rangé sous la clé DU PROJET, la carte
//     porte celle du fichier, et aucun état `(job, clé)` ne lui répond.
//
// Pas de faux vert : un état devenu introuvable sans qu'un écran le dise, donc
// un repli silencieux (invariant #4).
//
// CE QUI EST SIMULÉ, ET CE QUI NE L'EST PAS. Le classement reste le VRAI —
// `importOriginal` rend la fonction réelle, appelée telle quelle. La seule
// chose injectée est le changement de la table, déclenché juste après un
// classement : la course devient déterministe au lieu d'être laissée au hasard
// de deux connexions. Les assertions portent sur des RÉSULTATS — la ligne
// d'état relue en base, et la sortie de l'outil — jamais sur un compte d'appels.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agentJobs,
  codeProjects,
  entities,
  jobDeliverableVerificationState,
  and,
  eq,
} from '@nodal-agents/db';
import { normalizePath, projectKey } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { fileEditTool } from '../builtin/file-ops/file-edit';
import type { ExecuteOptions, ToolContext } from '../types';
import type * as WrittenFileType from '../verification/written-file-type';

/**
 * Le geste qui change la table, armé par le test et tiré une seule fois, juste
 * APRÈS un classement. Une seule fois : c'est un changement, pas une boucle —
 * si l'outil classait trois fois, le troisième classement verrait le même état
 * que le second, et le test resterait honnête.
 */
const course = vi.hoisted(() => ({
  apres: null as null | (() => Promise<void>),
  /** Une panne de la base, armée pour le PROCHAIN classement et un seul. */
  leveUneFois: null as null | string,
}));

vi.mock('../verification/written-file-type', async (importOriginal) => {
  const reel = await importOriginal<typeof WrittenFileType>();
  return {
    ...reel,
    deliverableTypeForWrittenFile: async (
      ...args: Parameters<typeof reel.deliverableTypeForWrittenFile>
    ) => {
      const panne = course.leveUneFois;
      course.leveUneFois = null;
      if (panne !== null) throw new Error(panne);
      const type = await reel.deliverableTypeForWrittenFile(...args);
      const geste = course.apres;
      course.apres = null;
      if (geste) await geste();
      return type;
    },
  };
});

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let ws: string;
let jobId: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-classify-'));
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
  course.apres = null;
  course.leveUneFois = null;

  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'classify once',
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  jobId = job.id;

  await db.update(entities).set({ verificationSurfaces: {} }).where(eq(entities.id, seed.entityId));
  await db.delete(codeProjects).where(eq(codeProjects.entityId, seed.entityId));
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

function ctx(): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: ws }],
    turn: 1,
  } as unknown as ToolContext;
}

const opts: ExecuteOptions = { approvalRules: [], onApprovalRequired: async () => {} };

/**
 * D1 : écraser un fichier EXISTANT du partagé demande une approbation, et
 * `file_edit` vise toujours un fichier existant. La règle explicite la lève —
 * ce test-ci parle du classement, pas de la porte d'approbation.
 */
function autoApprove(toolName: string): ExecuteOptions {
  return {
    approvalRules: [
      {
        id: `rule-${toolName}`,
        toolName,
        action: 'auto_approve',
        agentId: seed.agentId,
        entityId: seed.entityId,
      },
    ],
    onApprovalRequired: async () => {},
  };
}

const keyOf = (p: string): string => projectKey(normalizePath(p));

async function etats() {
  const rows = await db
    .select()
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, jobId));
  return rows.map((r) => [r.deliverableType, r.canonicalKey] as const);
}

async function declarerProjet(dossier: string) {
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath: normalizePath(dossier),
    projectKey: keyOf(dossier),
    kind: 'code',
    registeredAt: new Date(),
    registeredFrom: 'spaces',
  });
}

async function retirerProjet(dossier: string) {
  await db
    .delete(codeProjects)
    .where(
      and(eq(codeProjects.entityId, seed.entityId), eq(codeProjects.projectKey, keyOf(dossier))),
    );
}

/** La clé que la carte porte, ou `null` — jamais `undefined`, pour une égalité lisible. */
function cleDeLaCarte(res: Awaited<ReturnType<typeof executeTool>>): string | null {
  const output = (res as { output?: { deliverable_key?: string } }).output;
  return output?.deliverable_key ?? null;
}

describe('un fichier écrit est classé une seule fois @cap:verifier-un-livrable/moteur', () => {
  it('file_write — le dossier DEVIENT un projet après le hook : la carte garde la clé de l’état', async () => {
    const dossier = join(ws, 'dossier');
    await mkdir(dossier, { recursive: true });
    // Le classement du hook voit une table vide ⇒ `document`. Juste après, le
    // dossier est déclaré projet de code : un second classement dirait
    // `code_project`, et la carte repartirait sans clé.
    course.apres = () => declarerProjet(dossier);

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'dossier/rapport.md', content: '# Rapport\n' },
      ctx(),
      opts,
    );

    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    expect({ etat: await etats(), carte: cleDeLaCarte(res) }).toEqual({
      etat: [['document', keyOf(join(dossier, 'rapport.md'))]],
      carte: keyOf(join(dossier, 'rapport.md')),
    });
  });

  it('file_write — le projet DISPARAÎT après le hook : la carte ne porte pas une clé orpheline', async () => {
    const projet = join(ws, 'projet');
    await mkdir(projet, { recursive: true });
    await declarerProjet(projet);
    // Le hook voit le projet déclaré ⇒ `code_project`, et l'état est rangé sous
    // la clé DU PROJET. La déclaration est ensuite retirée : un second
    // classement dirait `document`, et la carte porterait la clé du FICHIER —
    // une clé qu'aucune ligne d'état ne porte.
    course.apres = () => retirerProjet(projet);

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'projet/x.ts', content: 'export const x = 1;\n' },
      ctx(),
      opts,
    );

    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    expect({ etat: await etats(), carte: cleDeLaCarte(res) }).toEqual({
      etat: [['code_project', keyOf(projet)]],
      carte: null,
    });
  });

  it('file_edit — le dossier DEVIENT un projet après le hook : la carte garde la clé de l’état', async () => {
    const dossier = join(ws, 'notes');
    await mkdir(dossier, { recursive: true });
    await writeFile(join(dossier, 'journal.md'), 'avant\n', 'utf8');
    course.apres = () => declarerProjet(dossier);

    const res = await executeTool(
      fileEditTool as never,
      { path: 'notes/journal.md', old_string: 'avant', new_string: 'après' },
      ctx(),
      autoApprove('file_edit'),
    );

    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    expect({ etat: await etats(), carte: cleDeLaCarte(res) }).toEqual({
      etat: [['document', keyOf(join(dossier, 'journal.md'))]],
      carte: keyOf(join(dossier, 'journal.md')),
    });
  });

  it('file_edit — le projet DISPARAÎT après le hook : la carte ne porte pas une clé orpheline', async () => {
    const projet = join(ws, 'depot');
    await mkdir(projet, { recursive: true });
    await writeFile(join(projet, 'y.ts'), 'const y = 0;\n', 'utf8');
    await declarerProjet(projet);
    course.apres = () => retirerProjet(projet);

    const res = await executeTool(
      fileEditTool as never,
      { path: 'depot/y.ts', old_string: 'const y = 0;', new_string: 'const y = 1;' },
      ctx(),
      autoApprove('file_edit'),
    );

    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    expect({ etat: await etats(), carte: cleDeLaCarte(res) }).toEqual({
      etat: [['code_project', keyOf(projet)]],
      carte: null,
    });
  });
});

// ─── Constat de Quentin sur la revue de #213, porté par #211 ─────────────────
//
// Le hook rattrapait TOUT : sa `catch` couvrait la résolution du chemin ET le
// classement, qui lit `code_projects`. Une panne passagère de la base faisait
// donc rendre AUCUNE cible — la forme documentée d'un chemin irrésolu, où
// `execute` échoue quelques lignes plus bas sur la même erreur et où il n'y a
// donc rien à ranger. Ici, rien n'échouait : l'écriture partait, `execute`
// reclassait pour son compte, et la carte repartait avec une clé de livrable
// qu'aucune ligne d'état ne réclamait. Un repli silencieux (invariant #4), et
// la seule variante de la course de #66 que ce fichier ne couvrait pas.
//
// La `catch` ne couvre plus que la résolution du chemin. Un classement qui
// lève REMONTE, le seam refuse l'appel (`intent_targets_failed`) et le dit.
describe('un classement qui LÈVE au hook ne devient pas une écriture sans état', () => {
  it('file_write — la base tombe au hook : l’appel est refusé et rien n’est écrit', async () => {
    const cible = join(ws, 'rapport.md');
    course.leveUneFois = 'PANNE_PASSAGERE_CODE_PROJECTS';

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'rapport.md', content: '# Rapport\n' },
      ctx(),
      opts,
    );

    expect(res.outcome).toBe('error');
    expect(res.outcome === 'error' ? res.error : '').toContain(
      'verification_intent_failed: intent_targets_failed',
    );
    expect(await etats(), 'une ligne d’état a été posée sur un appel refusé').toEqual([]);
    await expect(
      readFile(cible, 'utf8'),
      'le fichier a été écrit alors que l’intention a échoué',
    ).rejects.toThrow();
  });

  it('file_edit — même panne, même refus : le fichier garde son contenu', async () => {
    const projet = join(ws, 'depot');
    await mkdir(projet, { recursive: true });
    await writeFile(join(projet, 'z.ts'), 'const z = 0;\n', 'utf8');
    course.leveUneFois = 'PANNE_PASSAGERE_CODE_PROJECTS';

    const res = await executeTool(
      fileEditTool as never,
      { path: 'depot/z.ts', old_string: 'const z = 0;', new_string: 'const z = 1;' },
      ctx(),
      autoApprove('file_edit'),
    );

    expect(res.outcome).toBe('error');
    expect(await etats()).toEqual([]);
    expect(await readFile(join(projet, 'z.ts'), 'utf8')).toBe('const z = 0;\n');
  });

  // L'autre moitié, et la raison pour laquelle la `catch` existe : un chemin
  // hors périmètre ne rend toujours aucune cible, sans lever. `execute` rend
  // alors l'erreur que l'agent peut lire, au lieu d'un code d'intention.
  it('un chemin hors périmètre ne rend toujours aucune cible, et échoue à l’exécution', async () => {
    // Absolu et hors de tout dossier attaché : `resolveAndCheckPath` lève, et
    // c'est le seul cas que la `catch` du hook doit encore avaler.
    const res = await executeTool(
      fileWriteTool as never,
      { path: join(root, 'dehors.md'), content: 'x' },
      ctx(),
      opts,
    );

    // L'outil, lui, RÉPOND — et sa réponse est un échec déclaré, porteur du
    // message que l'agent peut lire. Ce n'est pas un code d'intention.
    expect(res.outcome).toBe('success');
    const sortie = (res as { output?: { ok?: boolean; reason?: string } }).output;
    expect(sortie?.ok).toBe(false);
    expect(sortie?.reason ?? '').not.toContain('verification_intent_failed');
    expect(await etats()).toEqual([]);
  });
});
