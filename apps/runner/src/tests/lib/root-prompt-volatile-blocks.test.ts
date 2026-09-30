// root-prompt-volatile-blocks.test.ts — le prompt d'un root type Alfred, construit
// de bout en bout sur un espace partagé reconstitué (lot 2, voie H, #638).
//
// Le fait du 01/10 (main 7fae63ae, job a22e173f) : l'inventaire `## Shared
// workspace` du root annonçait `caviar-aubergines/ (3 files):
// caviar-aubergines.html, caviar-aubergines.pdf, photo.jpg`, et pour
// « Imprime une recette de caviar d'aubergines » le modèle a ouvert puis
// retouché ce fichier-là au lieu de faire la demande (file_edit → approbation
// → banc rouge 3/3), alors que la règle de #640 était dans le prompt.
//
// Ce test rejoue la chaîne réelle — l'inventaire du runner sur un vrai dossier,
// puis `buildSystemPrompt` avec la liste d'outils que la règle unique
// (`resolveBuiltinToolNames`, #636) donne à ce root — et lit le TEXTE rendu.
// Il imprime aussi la taille des blocs : c'est la mesure avant/après de la PR.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  agents,
  agentAssignments,
  agentSkills,
  agentSkillAssignments,
  entities,
  users,
} from '@nodal-agents/db';
import { systemSkills } from '@nodal-agents/catalog';
import { buildSystemPrompt, resolveBuiltinToolNames } from '@nodal-agents/orchestration';

import {
  buildSharedWorkspaceInventory,
  inventoryForContext,
} from '../../lib/workspace-inventory.ts';

let db: TestDb;
let shared: string;

// L'espace partagé du propriétaire le 01/10, dossier par dossier, avec des
// comptes réduits : ce qui compte est la FORME (un dossier au nom d'une
// demande passée, ses fichiers nommés comme le livrable, des dossiers de
// moyens, un fichier à la racine).
const SHARED_TREE: Record<string, string[]> = {
  _archive: ['strawberry_redhead_yacht_nsfw.json', 'dossiers-bruit/a.txt'],
  'AI Consensus & Routing': ['Mémoire agentique dans les harnais multi-LLM et multi-agents.md'],
  'caviar-aubergines': ['caviar-aubergines.html', 'caviar-aubergines.pdf', 'photo.jpg'],
  documents: ['carte-ongules-france.html', 'cicada3301_report.html', 'convertisseur-devises.html'],
  'nodal-agents-film': ['nodal-agents-film.mp4', 'render.py', 'frames/0001.png'],
  'nodal-bench': ['iris.csv', 'ventes-bench.xlsx'],
  notes: ['bonjour.html'],
  outputs: ['08b9107b_000.png', '2_balcony_night/a.png'],
  rapports: ['2026-09-25-sandbox-isolement-des-agents.md'],
  scripts: ['_analyze_2026_earnings.py', '_gen_redhead.py'],
  telegram: ['199791464/photo.jpg'],
  workflows: [],
};
const ROOT_FILE = 'budget-septembre.xlsx';
const EVERY_FILE_NAME = [
  ...Object.values(SHARED_TREE)
    .flat()
    .map((p) => p.split('/').pop()!),
  ROOT_FILE,
];

const GIT = { root: 'C:/Users/owner', branch: null, head: null, dirtyCount: 65 };

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  shared = await mkdtemp(join(tmpdir(), 'nodal-root-prompt-'));
  for (const [dir, files] of Object.entries(SHARED_TREE)) {
    await mkdir(join(shared, dir), { recursive: true });
    for (const f of files) {
      await mkdir(join(shared, dir, f, '..'), { recursive: true });
      await writeFile(join(shared, dir, f), 'x');
    }
  }
  await writeFile(join(shared, ROOT_FILE), 'x');
});

afterAll(async () => {
  await rm(shared, { recursive: true, force: true });
});

let n = 0;
const uniq = (p: string): string => `${p}-${Date.now()}-${++n}`;

/** Un root orchestrateur, dix coéquipiers, les groupes d'outils donnés. */
async function seedRoot(groups: string[]) {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniq('root')}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'Owner', slug: uniq('e-root') })
    .returning();
  const entityId = entity!.id;
  const [root] = await db
    .insert(agents)
    .values({
      entityId,
      name: 'Alfred',
      slug: uniq('alfred'),
      personality: 'You are Alfred, the owner’s butler.',
      role: 'orchestrator',
    })
    .returning();
  for (let i = 0; i < 10; i++) {
    const [mate] = await db
      .insert(agents)
      .values({
        entityId,
        name: `Mate ${i}`,
        slug: uniq(`mate-${i}`),
        personality: `Teammate ${i}.`,
        role: 'agent',
      })
      .returning();
    await db
      .insert(agentAssignments)
      .values({ orchestratorId: root!.id, subAgentId: mate!.id, entityId });
  }
  // Les groupes tels que le catalogue les livre, plus une skill maison sans
  // outil (la `cwm-test` du propriétaire).
  const rows = [
    ...groups.map((slug) => {
      const s = systemSkills.find((x) => x.slug === slug)!;
      return {
        slug,
        name: s.name,
        description: s.description,
        content: s.content,
        requiredBuiltins: s.requiredBuiltins ?? [],
      };
    }),
    {
      slug: uniq('cwm-test'),
      name: 'CWM',
      description: 'Reviews flows with code world model',
      content: 'Review the flow.',
      requiredBuiltins: [],
    },
  ];
  for (const r of rows) {
    const [skill] = await db
      .insert(agentSkills)
      .values({ entityId, ...r })
      .returning();
    await db
      .insert(agentSkillAssignments)
      .values({ entityId, agentId: root!.id, skillId: skill!.id });
  }
  return {
    agent: {
      id: root!.id,
      name: 'Alfred',
      slug: root!.slug,
      role: 'orchestrator' as const,
      personality: root!.personality,
      entityId,
      model: 'claude-sonnet-4-6-20260217',
      active: true,
      orchestratorMode: null,
      memoryTokenBudget: 0,
    },
  };
}

async function rootPrompt(groups: string[]) {
  const { agent } = await seedRoot(groups);
  const tools = (await resolveBuiltinToolNames(db, agent.id)).names;
  const listing = await buildSharedWorkspaceInventory(shared);
  const prompt = await buildSystemPrompt(agent as never, db, {
    origin: 'telegram',
    task: 'Imprime une recette de caviar d’aubergines',
    workspaceInventory: inventoryForContext(shared, listing),
    workspaceGit: GIT,
    availableToolNames: tools,
  } as never);
  return { prompt, tools };
}

/** Une section `## X` du prompt, jusqu'à la suivante. */
function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(`\n${heading}\n`);
  if (start < 0) return '';
  const next = prompt.indexOf('\n## ', start + heading.length + 2);
  return prompt.slice(start, next < 0 ? undefined : next);
}

describe('prompt d’un root sur l’espace partagé du 01/10 @cap:travailler-sur-des-fichiers/moteur', () => {
  it('Alfred (tableur, shell, voix) : le livrable d’hier n’est plus nommé, les dossiers et leurs comptes restent', async () => {
    const { prompt, tools } = await rootPrompt([
      'command-execution',
      'spreadsheet-editing',
      'speech-generation',
    ]);
    const inventory = section(prompt, '## Shared workspace');
    console.warn(
      `[mesure H] Alfred — prompt ${prompt.length} car. ; Shared workspace ${inventory.length} ; ` +
        `Git ${section(prompt, '## Git').length} ; Skills ${section(prompt, '## Skills (load before acting)').length}`,
    );

    expect(inventory).toContain('- caviar-aubergines/ (3 files)');
    expect(inventory).toContain('- workflows/ (0 files)');
    expect(inventory).toContain('- 1 file at the root');
    for (const name of EVERY_FILE_NAME) {
      expect(prompt, `« ${name} » est nommé dans le prompt`).not.toContain(name);
    }

    // Ce root tient run_command (groupe « command-execution », #636) : le
    // bloc git et la skill restent, comme ses outils.
    expect(tools).toContain('run_command');
    expect(prompt).toContain('## Git');
    expect(prompt).toContain("skill_view('command-execution')");
    expect(prompt).toContain("skill_view('spreadsheet-editing')");
  });

  it('un root sans shell (tableur seul) : ni `## Git`, ni rien qui le suppose', async () => {
    const { prompt, tools } = await rootPrompt(['spreadsheet-editing']);
    console.warn(
      `[mesure H] root sans shell — prompt ${prompt.length} car. ; ` +
        `Shared workspace ${section(prompt, '## Shared workspace').length} ; Git ${section(prompt, '## Git').length}`,
    );
    expect(tools).not.toContain('run_command');
    expect(tools).not.toContain('code_task');
    expect(prompt).not.toContain('## Git');
    expect(prompt).not.toContain('65 modified entries');
    expect(prompt).toContain("skill_view('spreadsheet-editing')");
  });
});
