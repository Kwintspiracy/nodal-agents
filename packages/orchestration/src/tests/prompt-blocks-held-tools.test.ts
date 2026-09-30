// prompt-blocks-held-tools.test.ts — deux blocs du prompt qui PRESCRIVENT un
// outil ne se rendent qu'à l'agent qui le tient (lot 2, voie H, #638).
//
// La règle est celle du socle (`hasRequiredBuiltins` / `namesOnlyHeldTools`,
// agent-baseline.ts) : un bloc qui promet un outil absent est pire que pas de
// bloc. Deux blocs y échappaient encore :
//
//   · l'index `## Skills` annonçait toute skill assignée, même celle dont les
//     `requiredBuiltins` manquaient au job — `skill_view` rendait ensuite une
//     procédure dont chaque étape ratait (carte du prompt, §1.4) ;
//   · `## Git` ordonnait `git status` à un agent sans `run_command` ni
//     `code_task` : 600 caractères sur le dossier personnel du propriétaire,
//     « detached HEAD, 65 modified entries », pour un root qui ne pouvait
//     rien en faire (job 04c3d763, 30/09, avant #641).
//
// Les assertions portent sur le TEXTE rendu, jamais sur des appels.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentSkills, agentSkillAssignments, entities, users } from '@nodal-agents/db';
import { ALWAYS_ON_TOOLS } from '@nodal-agents/tools';
import { buildSystemPrompt } from '../system-prompt';
import { resolveBuiltinToolNames } from '../builtin-tool-names';
import type { JobContext } from '../system-prompt';
import type { Agent, AgentId, EntityId } from '../types';

let db: TestDb;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
});

let n = 0;
const uniq = (p: string): string => `${p}-${Date.now()}-${++n}`;

async function seedAgent(role: 'agent' | 'orchestrator' = 'agent'): Promise<Agent> {
  const [user] = await db
    .insert(users)
    .values({ email: `${uniq('held')}@ex.com` })
    .returning();
  const [entity] = await db
    .insert(entities)
    .values({ userId: user!.id, name: 'T', slug: uniq('e-held') })
    .returning();
  const [row] = await db
    .insert(agents)
    .values({
      entityId: entity!.id,
      name: 'Held',
      slug: uniq('held'),
      personality: 'p',
      role,
    })
    .returning();
  return {
    id: row!.id as AgentId,
    name: 'Held',
    slug: row!.slug,
    role,
    personality: 'p',
    entityId: entity!.id as EntityId,
    model: 'claude-sonnet-4-6-20260217',
    active: true,
    orchestratorMode: null,
    memoryTokenBudget: 0,
  };
}

async function assign(agent: Agent, slug: string, requiredBuiltins: string[]): Promise<void> {
  const [skill] = await db
    .insert(agentSkills)
    .values({
      entityId: agent.entityId as string,
      name: `Skill ${slug}`,
      slug,
      description: `does ${slug}`,
      content: `Use ${slug}.`,
      requiredBuiltins,
    })
    .returning();
  await db.insert(agentSkillAssignments).values({
    entityId: agent.entityId as string,
    agentId: agent.id as string,
    skillId: skill!.id,
  });
}

// Deux outils du groupe tableur, tous deux enregistrés dans ce build.
const XLSX_BUILTINS = ['xlsx_create', 'xlsx_read'] as const;

const GIT = { root: 'C:/Users/owner', branch: null, head: null, dirtyCount: 65 };

describe('index des skills : seulement celles dont le job tient les outils @cap:assigner-skill/moteur', () => {
  // Les listes d'outils ne sont PAS écrites à la main : elles viennent de la
  // règle que le runner applique (`resolveBuiltinToolNames`, #636), plus un
  // outil MCP comme en porte la liste complète d'un job. Une skill assignée
  // apporte ses builtins au job : le seul cas réel où l'un manque est un nom
  // que ce build n'enregistre pas (skill communautaire d'une autre version),
  // ou un nom qui n'est pas un builtin du tout (revue de #658, passe 1).
  const MCP_TOOL = 'notion__search';

  /** Les slugs annoncés par l'index, quel que soit le format de la surface. */
  const announced = (prompt: string, slugs: string[]): string[] =>
    slugs.filter((s) => prompt.includes(`skill_view('${s}')`) || prompt.includes(`\`${s}\``));

  async function rootWithSkills() {
    const agent = await seedAgent('orchestrator');
    const slugs = {
      shell: uniq('shell'),
      prose: uniq('prose'),
      ghost: uniq('ghost'),
      mcp: uniq('mcp'),
    };
    await assign(agent, slugs.shell, ['run_command']);
    // Sans requiredBuiltins : jamais concernée, comme au socle.
    await assign(agent, slugs.prose, []);
    await assign(agent, slugs.ghost, ['no_such_builtin_in_this_build']);
    await assign(agent, slugs.mcp, [MCP_TOOL]);
    const builtins = (await resolveBuiltinToolNames(db, agent.id as string)).names;
    return { agent, slugs, builtins };
  }

  it('un job annonce la skill dont il tient les builtins, jamais celle dont l’outil n’est pas un builtin tenu', async () => {
    const { agent, slugs, builtins } = await rootWithSkills();
    expect(builtins).toContain('run_command');
    expect(builtins).not.toContain('no_such_builtin_in_this_build');

    const job = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...builtins, MCP_TOOL],
    } as JobContext);
    expect(job).toContain('## Skills (load before acting)');
    expect(announced(job, Object.values(slugs))).toEqual([slugs.shell, slugs.prose]);
  });

  it('le chat annonce EXACTEMENT les skills du job auquel il passe la main', async () => {
    // Le chat ne tient que `run_task` : filtrer sur ses outils à lui viderait
    // la liste de toute skill outillée. Et une liste MCP qui ne compterait
    // que du côté job ferait diverger les deux surfaces.
    const { agent, slugs, builtins } = await rootWithSkills();
    const all = Object.values(slugs);
    const job = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...builtins, MCP_TOOL],
    } as JobContext);
    const chat = await buildSystemPrompt(agent, db, {
      origin: 'dashboard',
      surface: 'chat',
    } as JobContext);
    expect(chat).toContain('## Skills');
    expect(announced(chat, all)).toEqual(announced(job, all));
    expect(announced(chat, all)).toEqual([slugs.shell, slugs.prose]);
  });

  it('aucune skill retenue : pas de titre `## Skills` vide', async () => {
    const agent = await seedAgent();
    await assign(agent, uniq('ghost'), ['no_such_builtin_in_this_build']);
    const builtins = (await resolveBuiltinToolNames(db, agent.id as string)).names;
    const prompt = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: builtins,
    } as JobContext);
    expect(prompt).not.toContain('## Skills');
  });
});

describe('bloc `## Git` : seulement pour qui peut lancer git @cap:executer-une-commande/moteur', () => {
  it('absent sans run_command ni code_task, présent avec l’un ou l’autre', async () => {
    const agent = await seedAgent('orchestrator');
    const sans = await buildSystemPrompt(agent, db, {
      origin: 'api',
      workspaceGit: GIT,
      availableToolNames: [...ALWAYS_ON_TOOLS, ...XLSX_BUILTINS],
    } as JobContext);
    expect(sans, 'un bloc qui ordonne `git status` à qui ne peut pas le lancer').not.toContain(
      '## Git',
    );
    expect(sans).not.toContain('65 modified entries');

    for (const tool of ['run_command', 'code_task']) {
      const avec = await buildSystemPrompt(agent, db, {
        origin: 'api',
        workspaceGit: GIT,
        availableToolNames: [...ALWAYS_ON_TOOLS, tool],
      } as JobContext);
      expect(avec, tool).toContain('## Git');
      expect(avec, tool).toContain('65 modified entries');
    }
  });

  it('une session CLI de code garde le bloc : son shell est le sien, hors de la liste Nodal', async () => {
    const agent = await seedAgent();
    const cli = await buildSystemPrompt(agent, db, {
      origin: 'api',
      surface: 'cli-runtime',
      workspaceGit: GIT,
    } as JobContext);
    expect(cli).toContain('## Git');
  });
});
