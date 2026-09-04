// intent-wiring.test.ts — le CÂBLAGE de l'intention, par ÉNUMÉRATION DU
// REGISTRE.
//
// La différence avec `intent.test.ts` tient en une phrase : là-bas les outils
// sont NOMMÉS un par un, ici ils sont DÉCOUVERTS. Une liste écrite à la main
// est une garde qui vieillit en silence — la preuve est dans ce dépôt :
// `checkpoint-wiring.test.ts` énumérait `[file_write, file_edit, run_command,
// code_task]` et avait déjà oublié `run_skill_script`, marqué mutant depuis
// run-skill-script.ts:200. Personne ne relit un test vert.
//
// Donc : `registry.list().filter(mutatesWorkspace)`, le VRAI `executeTool`, et
// des lignes `job_deliverable_verification_state` relues en base. Un outil
// mutant ajouté demain sans surface ni hook fait rougir ce fichier sans
// qu'aucune liste n'ait à être mise à jour — et s'il n'a pas d'input minimal
// ici, le test échoue EN LE NOMMANT plutôt que de le sauter.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, agents, jobDeliverableVerificationState, eq } from '@nodal-agents/db';
import { normalizePath, projectKey, surfaceForTool } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;

/**
 * LE registre des builtins, construit comme le runner le construit. Tout ce
 * fichier part de lui : aucune liste d'outils n'est écrite à la main.
 */
const registry = createToolRegistry();
registerBuiltins(registry);
const mutatingTools = registry.list().filter((t) => t.mutatesWorkspace === true);
const mutatingNames = mutatingTools.map((t) => t.name).sort();

/**
 * Un input minimal VALIDE par outil mutant, indexé par NOM.
 *
 * La table est indexée et non ordonnée pour une raison : un outil mutant du
 * registre absent d'ici ne se saute pas, il fait ÉCHOUER le test en se
 * nommant. Le coût d'un outil mutant ajouté demain est donc une entrée à
 * écrire, pas un trou silencieux dans la garde.
 *
 * Les inputs visent le plus court chemin jusqu'au seam : `run_skill_script`
 * cite une skill inexistante et `code_task` un fournisseur coupé en base —
 * les deux échouent APRÈS l'intention, ce qui est exactement le comportement
 * sous test (une tentative qui n'écrit rien laisse le projet sale).
 */
const MINIMAL_INPUT: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  file_write: { path: 'nouveau.txt', content: 'x' },
  file_edit: { path: 'a-editer.txt', old_string: 'avant', new_string: 'apres' },
  run_command: { purpose: 'test', command: 'echo ok' },
  run_skill_script: { purpose: 'test', skill: 'skill-inexistante', script: 'scripts/x.js' },
  code_task: { purpose: 'test', provider: 'claude', task: 'ne rien faire', mode: 'write' },
};

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  // Le fournisseur de CLI est coupé POUR CET AGENT, en base : `code_task`
  // refuse aussitôt après le seam, sans jamais lancer de CLI. Un test qui
  // dépendrait du CLI installé sur la machine ne prouverait rien de stable.
  await db
    .update(agents)
    .set({ cliDefaults: { claude: { enabled: false } } })
    .where(eq(agents.id, seed.agentId));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-intent-wiring-'));
});

afterEach(async () => {
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

/**
 * Un dossier attaché NEUF, portant un manifeste — la racine EST donc le
 * projet, et les cinq outils convergent sur UNE clé attendue au lieu que
 * chacun dépende de la forme de l'arborescence.
 */
async function freshWorkspace(name: string): Promise<string> {
  const ws = join(root, name);
  await mkdir(ws, { recursive: true });
  await writeFile(join(ws, 'package.json'), '{}');
  // `file_edit` exige un fichier existant ; les autres outils l'ignorent.
  await writeFile(join(ws, 'a-editer.txt'), 'avant');
  return ws;
}

/** Un job NEUF : « les lignes de ce job » devient une assertion exacte. */
async function freshJob(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'intent wiring',
    })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(workspaces: readonly string[], jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: workspaces.map((path, i) => ({ label: i === 0 ? 'shared' : `ws${i}`, path })),
    turn: 1,
  } as unknown as ToolContext;
}

/**
 * Une règle explicite par outil mutant, DÉRIVÉE du registre.
 *
 * `run_command`, `run_skill_script`, `code_task` et l'édition d'un fichier
 * partagé passent par l'approbation ; sans règle ils rendraient
 * `awaiting_approval`, donc aucune intention, et le test rougirait pour une
 * raison qui n'est pas celle qu'il examine.
 */
function autoApproveMutating(): ExecuteOptions {
  const rules: ApprovalRule[] = mutatingNames.map((toolName) => ({
    id: `rule-${toolName}`,
    toolName,
    action: 'auto_approve',
    agentId: seed.agentId,
    entityId: seed.entityId,
  })) as ApprovalRule[];
  return { approvalRules: rules, onApprovalRequired: async () => {} };
}

async function statesOf(jobId: string) {
  return db
    .select()
    .from(jobDeliverableVerificationState)
    .where(eq(jobDeliverableVerificationState.jobId, jobId));
}

const keyOf = (p: string): string => projectKey(normalizePath(p));

describe('l’intention, par énumération du registre', () => {
  it('le registre expose bien des outils mutants, dont celui que la liste à la main oubliait', () => {
    // Le contrôle du test lui-même : une boucle sur une liste vide serait
    // verte et ne prouverait rien.
    expect(mutatingNames.length).toBeGreaterThan(0);
    expect(
      mutatingNames,
      'run_skill_script écrit dans le workspace depuis run-skill-script.ts:200',
    ).toContain('run_skill_script');
  });

  it('tout outil mutant du registre a une surface — sinon executeTool le REFUSE', () => {
    // `takeMutationIntent` rend `intent_surface_unmapped` pour un outil mutant
    // absent de VERIFICATION_SURFACE_TOOLS : il n'écrirait plus du tout. La
    // règle est donc vérifiée ici, sur le registre entier, plutôt que
    // découverte en production par un outil devenu inutilisable.
    const sansSurface = mutatingNames.filter((name) => surfaceForTool(name) === null);
    expect(
      sansSurface,
      `outils mutants hors VERIFICATION_SURFACE_TOOLS : ${sansSurface.join(', ')}`,
    ).toEqual([]);
  });

  it('chaque outil mutant du registre pose une ligne d’état sale sur le projet attendu', async () => {
    const sansInput = mutatingNames.filter((name) => !(name in MINIMAL_INPUT));
    expect(
      sansInput,
      `outils mutants sans input minimal dans MINIMAL_INPUT : ${sansInput.join(', ')} — ` +
        'ajoutez une entrée, ne les sautez pas',
    ).toEqual([]);

    for (const tool of mutatingTools) {
      const input = MINIMAL_INPUT[tool.name];
      if (!input) throw new Error(`input minimal manquant pour ${tool.name}`);

      // Un workspace ET un job neufs par outil : les lignes lues ensuite ne
      // peuvent venir que de CET appel.
      const ws = await freshWorkspace(tool.name);
      const jobId = await freshJob();

      const res = await executeTool(tool, input, ctx([ws], jobId), autoApproveMutating());
      expect(res.outcome, `${tool.name} s’est arrêté à l’approbation, pas au seam`).not.toBe(
        'awaiting_approval',
      );

      const rows = await statesOf(jobId);
      expect(
        rows.map((r) => r.canonicalKey),
        `${tool.name} n’a sali aucun projet — son passage par le seam n’est pas câblé`,
      ).toEqual([keyOf(ws)]);
      const row = rows[0];
      if (!row) throw new Error(`aucune ligne d’état pour ${tool.name}`);
      expect(row.deliverableType, tool.name).toBe('code_project');
      expect(row.decisionStatus, tool.name).toBe('dirty');
      expect(row.dirtyGeneration, tool.name).toBeGreaterThanOrEqual(1);
      expect(normalizePath(row.displayPathSnapshot ?? ''), tool.name).toBe(normalizePath(ws));
    }
  });
});

describe('la sonde — ce que le seam fait d’un outil marqué', () => {
  /**
   * La sonde porte un nom MAPPÉ dans `VERIFICATION_SURFACE_TOOLS`
   * (`run_command` ⇒ surface `shell`) : sans surface, le seam refuserait
   * l'exécution et la sonde ne prouverait rien de ce qu'elle vient prouver.
   *
   * Elle vit dans un registre SÉPARÉ, jamais dans celui des builtins : le
   * test d'énumération ci-dessus doit continuer de voir les cinq vrais outils
   * et eux seuls.
   */
  const PROBE_NAME = 'run_command';

  function probeOptions(): ExecuteOptions {
    return {
      approvalRules: [
        {
          id: 'rule-sonde',
          toolName: PROBE_NAME,
          action: 'auto_approve',
          agentId: seed.agentId,
          entityId: seed.entityId,
        },
      ] as ApprovalRule[],
      onApprovalRequired: async () => {},
    };
  }

  it('un outil mutant SANS hook retombe sur TOUS les workspaces', async () => {
    // Le repli de `takeMutationIntent` quand un outil ne déclare pas
    // `resolveMutationTargets` : conservatif, c'est le bon côté où se tromper
    // — un projet sali pour rien coûte une preuve, un projet manqué coûte une
    // livraison non vérifiée.
    const a = await freshWorkspace('ws-a');
    const b = await freshWorkspace('ws-b');
    const jobId = await freshJob();

    const probes = createToolRegistry();
    probes.register({
      name: PROBE_NAME,
      description: 'sonde',
      inputSchema: z.object({}),
      riskLevel: 'write',
      mutatesWorkspace: true,
      // PAS de resolveMutationTargets — c'est tout le sujet.
      execute: async () => ({ ok: true }),
    });
    const probe = probes.get(PROBE_NAME);
    if (!probe) throw new Error('sonde non enregistrée');
    expect(probe, 'la sonde a écrasé l’outil du registre des builtins').not.toBe(
      registry.get(PROBE_NAME),
    );

    const res = await executeTool(probe, {}, ctx([a, b], jobId), probeOptions());
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');

    const rows = await statesOf(jobId);
    expect(rows.map((r) => r.canonicalKey).sort()).toEqual([keyOf(a), keyOf(b)].sort());
    for (const row of rows) expect(row.dirtyGeneration).toBe(1);
  });

  it('l’intention PRÉCÈDE l’exécution', async () => {
    // La seule façon de prouver un ORDRE sans lire le code : faire regarder
    // l'exécution elle-même. L'`execute` de la sonde SELECTe sa propre ligne
    // d'état et la rend. Si le seam posait l'intention APRÈS `tool.execute`,
    // la requête ne verrait rien et l'output serait vide.
    const ws = await freshWorkspace('ws-ordre');
    const jobId = await freshJob();

    const probes = createToolRegistry();
    probes.register({
      name: PROBE_NAME,
      description: 'sonde',
      inputSchema: z.object({}),
      riskLevel: 'write',
      mutatesWorkspace: true,
      execute: async (_input: Record<string, never>, c: ToolContext) => {
        const rows = await c.db
          .select()
          .from(jobDeliverableVerificationState)
          .where(eq(jobDeliverableVerificationState.jobId, jobId));
        return {
          vu: rows.map((r) => ({ cle: r.canonicalKey, generation: r.dirtyGeneration })),
        };
      },
    });
    const probe = probes.get(PROBE_NAME);
    if (!probe) throw new Error('sonde non enregistrée');

    const res = await executeTool(probe, {}, ctx([ws], jobId), probeOptions());
    expect(res.outcome === 'error' ? res.error : res.outcome).toBe('success');
    if (res.outcome !== 'success') return;

    const output = res.output as { vu: ReadonlyArray<{ cle: string; generation: number }> };
    expect(
      output.vu,
      'l’exécution n’a vu aucune ligne d’état : l’intention est posée APRÈS la mutation',
    ).toHaveLength(1);
    expect(output.vu[0]?.cle).toBe(keyOf(ws));
    expect(output.vu[0]?.generation).toBe(1);
  });
});
