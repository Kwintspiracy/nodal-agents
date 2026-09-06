// checkpoint-wiring.test.ts — l'instantané est-il RÉELLEMENT pris avant une
// écriture, par le vrai executeTool ?
//
// Deux fois dans ce chantier, un test vert n'a rien prouvé parce qu'il exerçait
// la fonction et non le câblage : la garde de sandbox appelée directement, puis
// `preflight` déclaré par un faux outil. Les deux fois, retirer le branchement
// laissait la suite verte, et c'est une review qui l'a vu.
//
// Ce fichier attaque donc le câblage en premier : quels outils sont marqués,
// est-ce que l'instantané tombe une fois par tour, et est-ce qu'un échec REFUSE
// l'écriture au lieu de la laisser passer sans filet.

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, jobCheckpoints, and, eq } from '@nodal-agents/db';
import { executeTool } from '../execute';
import { listCheckpoints } from '@nodal-agents/checkpoints';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { officeMutationTargets } from '../builtin/office-ops';
import { fileWriteTool } from '../builtin/file-ops/file-write';
import { fileReadTool } from '../builtin/file-ops/file-read';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let root: string;
let store: string;
let ws: string;

/**
 * LE registre des builtins, construit comme le runner le construit — la seule
 * source de « quels outils écrivent ». Voir le describe plus bas : la liste
 * était écrite à la main et avait déjà perdu un outil.
 */
const registry = createToolRegistry();
registerBuiltins(registry);
const mutatingTools = registry.list().filter((t) => t.mutatesWorkspace === true);
const mutatingNames = mutatingTools.map((t) => t.name).sort();

/**
 * Un input minimal VALIDE par outil mutant, indexé par NOM — même contrat que
 * dans `intent-wiring.test.ts` : un outil mutant sans entrée ici fait ÉCHOUER
 * le test en se nommant, jamais un skip.
 */
const MINIMAL_INPUT: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  // Le représentant des vingt outils Office, qui partagent UN hook
  // d'intention (office-ops/index.ts) et passent par le même seam.
  docx_create: { path: 'rapport.docx', paragraphs: [{ text: 'Bonjour' }] },
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

  // Le fournisseur de CLI est coupé POUR CET AGENT : `code_task` échoue
  // aussitôt après l'instantané, sans lancer de CLI. L'instantané, lui, est
  // déjà pris — c'est précisément ce que le test constate.
  await db
    .update(agents)
    .set({ cliDefaults: { claude: { enabled: false } } })
    .where(eq(agents.id, seed.agentId));
});

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nodal-cpw-'));
  store = join(root, 'checkpoints');
  ws = join(root, 'ws');
  await mkdir(ws, { recursive: true });
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
    jobId: seed.jobId,
    workspaces: [{ label: 'shared', path: ws }],
    checkpointsRoot: store,
    turn: 1,
    ...over,
  } as unknown as ToolContext;
}

const opts = { approvalRules: [], onApprovalRequired: async () => {} } as never;

describe('quels outils sont marqués', () => {
  it('la liste des outils marqués vient du REGISTRE, jamais d’une liste à la main', () => {
    // Ce test remplace une boucle sur `[file_write, file_edit, run_command,
    // code_task]`, écrite à la main — et qui avait DÉJÀ oublié
    // `run_skill_script`, marqué mutant depuis run-skill-script.ts:200. La
    // suite restait verte : personne ne relit un test qui passe. Le registre
    // n'oublie pas, lui.
    expect(mutatingNames.length).toBeGreaterThan(0);
    expect(
      mutatingNames,
      'run_skill_script écrit dans le workspace et doit être photographié',
    ).toContain('run_skill_script');
  });

  it('ne marque PAS ceux qui n’écrivent pas', () => {
    // Le contrôle du correctif trop large. `attach_connector` exige une
    // approbation et ne touche aucun fichier : déduire le marqueur de la
    // configuration d'approbation aurait photographié celui-là et raté
    // file_write — exactement à l'envers. Les deux outils sont repris DU
    // registre, pas importés : ce qui est asserté est ce que le runner voit.
    for (const name of ['attach_connector', 'file_read']) {
      const tool = registry.get(name);
      expect(tool, `${name} n'est pas dans le registre`).toBeDefined();
      expect(
        tool?.mutatesWorkspace ?? false,
        `${name} est marqué alors qu'il n'écrit pas dans le workspace`,
      ).toBe(false);
    }
  });

  it('chaque outil marqué DU REGISTRE reçoit réellement un instantané', async () => {
    // Le marqueur n'est pas le filet : c'est `executeTool` qui photographie.
    // Chaque outil marqué passe donc par le VRAI seam et son workspace est
    // relu sur le disque. Un outil mutant ajouté demain rougit ici sans
    // qu'aucune liste ne soit à mettre à jour.
    // Les outils Office partagent un hook et un seam : un représentant
    // (docx_create) suffit, les autres ont leur propre hook et leur input.
    const covered = mutatingTools.filter(
      (t) => t.resolveMutationTargets !== officeMutationTargets || t.name === 'docx_create',
    );
    const sansInput = covered.map((t) => t.name).filter((name) => !(name in MINIMAL_INPUT));
    expect(
      sansInput,
      `outils mutants sans input minimal dans MINIMAL_INPUT : ${sansInput.join(', ')} — ` +
        'ajoutez une entrée, ne les sautez pas',
    ).toEqual([]);

    const rules: ApprovalRule[] = mutatingNames.map((toolName) => ({
      id: `rule-${toolName}`,
      toolName,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    })) as ApprovalRule[];
    const approved: ExecuteOptions = { approvalRules: rules, onApprovalRequired: async () => {} };

    for (const [i, tool] of covered.entries()) {
      const input = MINIMAL_INPUT[tool.name];
      if (!input) throw new Error(`input minimal manquant pour ${tool.name}`);

      // Un workspace ET un tour distincts par outil : le mémo par tour
      // (`checkpointedTurns`) rendrait sinon les quatre appels suivants
      // gratuits, et le test vert sans rien photographier.
      const cible = join(root, `mutant-${tool.name}`);
      await mkdir(cible, { recursive: true });
      await writeFile(join(cible, 'a-editer.txt'), 'avant');

      const res = await executeTool(
        tool,
        input,
        ctx({ workspaces: [{ label: 'shared', path: cible }] as never, turn: 10 + i }),
        approved,
      );
      expect(res.outcome, `${tool.name} s’est arrêté à l’approbation, pas au seam`).not.toBe(
        'awaiting_approval',
      );

      expect(
        (await listCheckpoints(store, cible)).length,
        `${tool.name} a écrit sans filet — aucun instantané pour son workspace`,
      ).toBeGreaterThan(0);
    }
  });
});

describe('le câblage dans executeTool', () => {
  it('prend un instantané AVANT que le fichier change', async () => {
    await writeFile(join(ws, 'existant.txt'), 'avant');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'nouveau.txt', content: 'apres' },
      ctx(),
      opts,
    );
    expect(res.outcome).toBe('success');

    const cps = await listCheckpoints(store, ws);
    expect(cps.length, "aucun instantané n'a été pris avant l'écriture").toBeGreaterThan(0);
    expect(cps[0]!.label).toContain('file_write');
  });

  it('ne prend PAS d’instantané pour un outil non marqué', async () => {
    await writeFile(join(ws, 'a.txt'), 'contenu');
    await executeTool(fileReadTool as never, { path: 'a.txt' }, ctx(), opts);
    expect(await listCheckpoints(store, ws)).toHaveLength(0);
  });

  it('un seul instantané par tour, pas un par appel', async () => {
    // Un tour avec huit éditions est UNE unité de travail. Huit instantanés
    // enterreraient celui qui sert.
    await executeTool(fileWriteTool as never, { path: 'a.txt', content: '1' }, ctx(), opts);
    await executeTool(fileWriteTool as never, { path: 'b.txt', content: '2' }, ctx(), opts);
    await executeTool(fileWriteTool as never, { path: 'c.txt', content: '3' }, ctx(), opts);

    expect(await listCheckpoints(store, ws)).toHaveLength(1);
  });

  it('reprend un instantané au tour suivant', async () => {
    await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx({ turn: 1 }),
      opts,
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'b.txt', content: '2' },
      ctx({ turn: 2 }),
      opts,
    );
    expect(await listCheckpoints(store, ws)).toHaveLength(2);
  });

  it('sans magasin configuré, l’écriture passe — sans prétendre à un filet', async () => {
    // Contextes légers (tests, tours de chat). Refuser là serait casser des
    // chemins qui n'ont jamais eu de filet et n'en promettent pas.
    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'x' },
      ctx({ checkpointsRoot: undefined }),
      opts,
    );
    expect(res.outcome).toBe('success');
  });

  it('REFUSE l’écriture quand l’instantané échoue', async () => {
    // Le contrat entier. Un filet qui échoue en silence est pire que pas de
    // filet : c'est celui que le propriétaire croyait avoir.
    //
    // Magasin rendu inutilisable : un chemin dont le parent est un FICHIER.
    const bloque = join(root, 'fichier-pas-dossier');
    await writeFile(bloque, 'je ne suis pas un dossier');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'x' },
      ctx({ checkpointsRoot: join(bloque, 'checkpoints') }),
      opts,
    );

    expect(res.outcome, "l'écriture est passée alors que l'instantané a échoué").toBe('error');
    if (res.outcome !== 'error') return;
    expect(res.error).toMatch(/checkpoint_failed/);
  });
});

describe('multi-workspace — le constat 1 de la review', () => {
  it('photographie le workspace VISÉ, pas seulement le premier', async () => {
    // Le câblage prenait ctx.workspaces[0].path, alors que file_write résout sa
    // cible par label. Un agent tenant [shared, autre] qui écrit dans `autre/`
    // obtenait un instantané de `shared` — l'écriture passait, et restaurer ne
    // rendait rien. Le test d'origine ne configurait qu'UN workspace : il ne
    // pouvait pas voir le défaut.
    const autre = join(root, 'autre');
    await mkdir(autre, { recursive: true });
    await writeFile(join(autre, 'cible.txt'), 'avant');

    const res = await executeTool(
      fileWriteTool as never,
      { path: 'autre/cible.txt', content: 'apres' },
      ctx({
        workspaces: [
          { label: 'shared', path: ws } as never,
          { label: 'autre', path: autre } as never,
        ],
      }),
      opts,
    );
    expect(res.outcome).toBe('success');

    const cps = await listCheckpoints(store, autre);
    expect(cps.length, "le workspace réellement écrit n'a pas été photographié").toBeGreaterThan(0);
  });

  it('couvre le second workspace même après avoir couvert le premier dans le même tour', async () => {
    // La clé de tour contenait le workspace choisi ; une fois `shared` couvert,
    // toute écriture suivante du tour était réputée protégée, y compris dans un
    // AUTRE workspace.
    const autre = join(root, 'autre2');
    await mkdir(autre, { recursive: true });
    const deux = [
      { label: 'shared', path: ws } as never,
      { label: 'autre2', path: autre } as never,
    ];

    await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx({ workspaces: deux }),
      opts,
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'autre2/b.txt', content: '2' },
      ctx({ workspaces: deux }),
      opts,
    );

    expect(
      (await listCheckpoints(store, autre)).length,
      'le second workspace est resté sans filet',
    ).toBeGreaterThan(0);
  });
});

describe('workspace injoignable — le constat 2 de la passe 2', () => {
  it("n'empêche PAS d'écrire dans un workspace sain", async () => {
    // Le correctif « photographier tous les workspaces » avait cree ce defaut :
    // un agent tenant [shared, archive] ne pouvait plus ecrire dans `shared`
    // parce que `archive` etait sur un disque demonte. L ecriture etait refusee
    // alors que sa cible reelle etait saine et deja couverte.
    const fantome = join(root, 'jamais-cree');
    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: 'ok' },
      ctx({
        workspaces: [
          { label: 'shared', path: ws } as never,
          { label: 'archive', path: fantome } as never,
        ],
      }),
      opts,
    );
    expect(res.outcome, 'un workspace injoignable a bloque une ecriture saine').toBe('success');
    expect(
      (await listCheckpoints(store, ws)).length,
      'la cible saine reste couverte',
    ).toBeGreaterThan(0);
  });
});

// ─── P11 — la photo devient RETROUVABLE ──────────────────────────────────────
//
// Le sha ne vivait que dans une ligne de console. Ce qui est vérifié ici est la
// LIGNE relue en base, et que son sha est bien celui que le magasin porte —
// pas qu'une insertion a été tentée.

describe('job_checkpoints — la ligne du tour (P11)', () => {
  it('pose une ligne (travail, tour, dossier, sha) et le sha est celui du magasin', async () => {
    const res = await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx({ turn: 41 }),
      opts,
    );
    expect(res.outcome).toBe('success');

    const lignes = await db
      .select()
      .from(jobCheckpoints)
      .where(and(eq(jobCheckpoints.jobId, seed.jobId), eq(jobCheckpoints.turn, 41)));
    expect(lignes).toHaveLength(1);
    expect(lignes[0]!.workspace).toBe(ws);

    const cps = await listCheckpoints(store, ws);
    expect(cps.length).toBeGreaterThan(0);
    expect(lignes[0]!.sha, 'la ligne ne pointe pas l instantané réellement pris').toBe(cps[0]!.sha);
  });

  it('une seule ligne pour trois écritures du même tour', async () => {
    await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx({ turn: 42 }),
      opts,
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'b.txt', content: '2' },
      ctx({ turn: 42 }),
      opts,
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'c.txt', content: '3' },
      ctx({ turn: 42 }),
      opts,
    );

    const lignes = await db
      .select()
      .from(jobCheckpoints)
      .where(and(eq(jobCheckpoints.jobId, seed.jobId), eq(jobCheckpoints.turn, 42)));
    expect(lignes).toHaveLength(1);
  });

  it('un tour dont l arbre n a pas bougé porte le sha de l instantané EXISTANT', async () => {
    // `snapshot` rend null quand rien n a change : sans reprise du sha de tete,
    // ce tour n aurait aucune ligne — et l ecran ne pourrait rien comparer alors
    // que l etat d avant est parfaitement connu.
    //
    // Deux tours qui ecrivent chacun un `.log` — un motif que le magasin EXCLUT
    // (voir EXCLUDES dans checkpoints.ts). L arbre de travail change donc, mais
    // l arbre PHOTOGRAPHIE reste identique : exactement le cas ou `snapshot`
    // rend null. Deux noms distincts parce qu ecraser un fichier existant
    // passerait par la porte d approbation et n executerait rien.
    await executeTool(
      fileWriteTool as never,
      { path: 'un.log', content: 'a' },
      ctx({ turn: 51 }),
      opts,
    );
    await executeTool(
      fileWriteTool as never,
      { path: 'deux.log', content: 'b' },
      ctx({ turn: 52 }),
      opts,
    );

    const ligne = async (turn: number) =>
      db
        .select()
        .from(jobCheckpoints)
        .where(and(eq(jobCheckpoints.jobId, seed.jobId), eq(jobCheckpoints.turn, turn)));

    const t51 = await ligne(51);
    const t52 = await ligne(52);
    expect(t51).toHaveLength(1);
    expect(t52, 'un tour sur un arbre inchangé est resté sans ligne').toHaveLength(1);
    // Le second instantané n a rien réenregistré : les deux tours pointent le
    // même commit, qui EST l état d avant des deux.
    expect(t52[0]!.sha).toBe(t51[0]!.sha);
    expect(await listCheckpoints(store, ws)).toHaveLength(1);
  });

  it('sans numéro de tour, AUCUNE ligne — un diff « du tour » n aurait pas de sens', async () => {
    const avant = await db
      .select()
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, seed.jobId));
    const res = await executeTool(
      fileWriteTool as never,
      { path: 'sans-tour.txt', content: '1' },
      ctx({ turn: undefined }),
      opts,
    );
    expect(res.outcome).toBe('success');
    // L instantané, lui, est bien pris : c est la LIGNE qui n a pas de sens.
    expect((await listCheckpoints(store, ws)).length).toBeGreaterThan(0);
    const apres = await db
      .select()
      .from(jobCheckpoints)
      .where(eq(jobCheckpoints.jobId, seed.jobId));
    expect(apres.length).toBe(avant.length);
  });

  it('une ligne par DOSSIER attaché sur le même tour', async () => {
    const autre = join(root, 'p11-autre');
    await mkdir(autre, { recursive: true });
    await executeTool(
      fileWriteTool as never,
      { path: 'a.txt', content: '1' },
      ctx({
        turn: 61,
        workspaces: [
          { label: 'shared', path: ws } as never,
          { label: 'p11-autre', path: autre } as never,
        ],
      }),
      opts,
    );
    const lignes = await db
      .select()
      .from(jobCheckpoints)
      .where(and(eq(jobCheckpoints.jobId, seed.jobId), eq(jobCheckpoints.turn, 61)));
    expect(lignes.map((l) => l.workspace).sort()).toEqual([autre, ws].sort());
  });
});
