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
  it('un job sans les requiredBuiltins d’une skill ne se la voit pas annoncer ; avec, si', async () => {
    const agent = await seedAgent('orchestrator');
    const sheets = uniq('sheets');
    const shell = uniq('shell');
    const prose = uniq('prose');
    await assign(agent, sheets, [...XLSX_BUILTINS]);
    await assign(agent, shell, ['run_command']);
    // Sans requiredBuiltins : jamais concernée, comme au socle.
    await assign(agent, prose, []);

    const sansTableur = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...ALWAYS_ON_TOOLS, 'run_command'],
    } as JobContext);
    expect(sansTableur).toContain('## Skills (load before acting)');
    expect(sansTableur, 'skill annoncée sans ses outils').not.toContain(`skill_view('${sheets}')`);
    expect(sansTableur).toContain(`skill_view('${shell}')`);
    expect(sansTableur).toContain(`skill_view('${prose}')`);

    // Un outil manquant sur plusieurs suffit à la retirer : la skill prescrit
    // tout son jeu, pas un seul de ses outils.
    const tableurPartiel = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...ALWAYS_ON_TOOLS, XLSX_BUILTINS[0]!],
    } as JobContext);
    expect(tableurPartiel).not.toContain(`skill_view('${sheets}')`);
    expect(tableurPartiel, 'la skill shell reste sans run_command').not.toContain(
      `skill_view('${shell}')`,
    );

    const avecTout = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...ALWAYS_ON_TOOLS, ...XLSX_BUILTINS, 'run_command'],
    } as JobContext);
    expect(avecTout).toContain(`skill_view('${sheets}')`);
    expect(avecTout).toContain(`skill_view('${shell}')`);
  });

  it('aucune skill retenue : pas de titre `## Skills` vide', async () => {
    const agent = await seedAgent();
    await assign(agent, uniq('sheets'), [...XLSX_BUILTINS]);
    const prompt = await buildSystemPrompt(agent, db, {
      origin: 'api',
      availableToolNames: [...ALWAYS_ON_TOOLS],
    } as JobContext);
    expect(prompt).not.toContain('## Skills');
  });

  it('sur le chat, la liste suit les outils du JOB auquel il passe la main, pas le seul run_task', async () => {
    // Le chat ne tient que `run_task` : filtrer sur ses outils à lui viderait
    // la liste de toute skill outillée, alors que le job qui la chargera en a
    // les outils. Une skill dont l'outil n'existe pas dans ce build, elle,
    // n'est tenue par aucun job : elle disparaît aussi du chat.
    const agent = await seedAgent('orchestrator');
    const sheets = uniq('sheets');
    const ghost = uniq('ghost');
    await assign(agent, sheets, [...XLSX_BUILTINS]);
    await assign(agent, ghost, ['no_such_builtin_in_this_build']);

    const chat = await buildSystemPrompt(agent, db, {
      origin: 'dashboard',
      surface: 'chat',
    } as JobContext);
    expect(chat).toContain('## Skills');
    expect(chat, 'le job tient xlsx_* : la skill est à lui').toContain(`\`${sheets}\``);
    expect(chat, 'aucun job ne tient cet outil').not.toContain(ghost);
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
