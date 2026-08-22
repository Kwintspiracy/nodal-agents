// cli-runtime-surface.test.ts — un agent en runtime CLI reçoit-il ce que
// l'orchestration assemble ?
//
// Signalé en test réel : « les infos des sous-agents ne sont pas prises en
// compte si je ne les ajoute pas manuellement dans le system prompt ». C'était
// exact, et la cause n'était pas le bloc d'équipe : `run-job.ts` et
// `run-chat.ts` passaient `agentRow.personality` BRUT à la CLI, sans jamais
// appeler `buildSystemPrompt`. L'agent perdait donc d'un coup l'équipe, la
// mémoire, les skills, l'inventaire du workspace et la posture git — pendant
// que les rattachements étaient bien en base.
//
// Ce fichier teste la surface. Le câblage lui-même — que run-job appelle bien
// buildSystemPrompt — est vérifié dans apps/runner.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { buildSystemPrompt } from '../system-prompt';
import {
  agents,
  agentAssignments,
  agentSkills,
  agentSkillAssignments,
  agentMemory,
  agentWorkspaces,
  eq,
} from '@nodal-agents/db';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agent: Record<string, unknown>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  // Un sous-agent réellement rattaché, comme dans la base de Quentin.
  const [sub] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Sous Agent Test',
      slug: 'sous-agent-test',
      personality: 'Je fais des choses.',
      model: 'test-model',
      role: 'agent',
      active: true,
    })
    .returning();
  await db.insert(agentAssignments).values({
    entityId: seed.entityId,
    orchestratorId: seed.agentId,
    subAgentId: (sub as { id: string }).id,
  });

  // Un skill REELLEMENT assigne a l agent teste. Sans lui, la branche skills
  // du prompt n est jamais exercee — c est exactement pourquoi la review a
  // trouve `skill_view` encore present dans un prompt cli-runtime alors que
  // le test jurait le contraire.
  const [sk] = await db
    .insert(agentSkills)
    .values({
      entityId: seed.entityId,
      slug: 'skill-test',
      name: 'Skill Test',
      description: 'Fait une chose precise.',
      content: 'MARQUEUR_CONTENU_SKILL — les instructions completes du skill.',
    })
    .returning();
  await db.insert(agentSkillAssignments).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    skillId: (sk as { id: string }).id,
  });

  // Une memoire reelle : sans elle le bloc memoire ne se rend pas du tout et
  // sa branche n est jamais exercee — meme piege que la fixture sans skill.
  await db.insert(agentMemory).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    fact: 'MARQUEUR_FAIT_MEMOIRE',
    importance: 5,
  });

  // Un workspace reel, meme raison : sans lui buildWorkspacesBlock rend '' et
  // l assertion sur l API fichiers ne teste rien.
  await db.insert(agentWorkspaces).values({
    entityId: seed.entityId,
    agentId: seed.agentId,
    label: 'shared',
    path: 'D:/tmp/ws-test',
  });

  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId)).limit(1);
  agent = row as Record<string, unknown>;
});

describe("surface 'cli-runtime'", () => {
  it("porte l'équipe — LE bug signalé", async () => {
    // Sans ça, un orchestrateur avec neuf sous-agents rattachés ignore leur
    // existence, et la seule façon de les lui dire est de les recopier à la
    // main dans sa personnalité.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, "le sous-agent rattaché n'apparaît pas").toContain('sous-agent-test');
  });

  it("porte la ligne d'identité — ce que le cast avait fait disparaître", async () => {
    // Ce test existe à cause d'un bug de MA propre PR, invisible ici jusqu'à ce
    // qu'on le cherche : l'appelant côté runner ne construisait qu'un sous-
    // ensemble de l'agent (id / entityId / personality), sans `name`, et
    // passait le tout via un cast. La ligne d'identité disparaissait donc du
    // prompt en production, alors que ce fichier — qui charge la ligne ENTIÈRE
    // depuis la base — la voyait toujours. Le trou était chez l'appelant, pas
    // dans buildSystemPrompt : tester la pièce ne teste pas le câblage.
    //
    // L'appelant est désormais tenu par le type (CliRuntimeAgentRow extends
    // Agent). Cette assertion garde l'autre moitié : que le prompt de cette
    // surface porte bien l'ancrage d'identité, sans quoi un agent finit par
    // parler à la place de ses propres sous-agents.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, "la ligne d'identité manque").toContain(`You are ${String(agent['name'])}`);
  });

  it("n'annonce PAS les outils intégrés de Nodal", async () => {
    // Cet agent EST une CLI de code : sa palette est celle du CLI (Read, Write,
    // Bash…), pas celle de Nodal. Lui annoncer `file_write` l'invite à appeler
    // quelque chose qui n'existe pas de son côté.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, 'le bloc des outils integres est present').not.toContain(
      '## Built-in capabilities',
    );
  });

  it('garde la personnalité de l’agent intacte', async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt).toContain(String(agent['personality']));
  });

  it('ne change RIEN pour un agent ordinaire', async () => {
    // Le contrôle du correctif trop large : la surface par défaut doit garder
    // le bloc des outils intégrés.
    const prompt = await buildSystemPrompt(agent as never, db, { origin: 'api' } as never);
    expect(prompt, 'la surface par defaut a perdu ses outils integres').toContain(
      '## Built-in capabilities',
    );
  });

  it("laisse la surface 'chat' se comporter comme avant", async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'dashboard',
      surface: 'chat',
    } as never);
    expect(prompt).not.toContain('## Built-in capabilities');
  });
});

describe('les blocs composés par Nodal ne donnent aucun ordre inexécutable', () => {
  // La review avait mesuré 23 mentions d'outils absents dans le prompt
  // cli-runtime, et AUCUNE n'était un fait : « you MUST call
  // mark_memory_outdated », « use assign_* when… », « after every file_write,
  // call file_read ». Une session Claude Code n'a aucun de ces outils.
  //
  // L'assertion porte sur les PHRASES exactes que Nodal compose, pas sur la
  // simple présence d'un nom d'outil quelque part. La première version
  // vérifiait l'absence totale, et c'était intenable pour une raison qui
  // compte : les skills catalogue de type `baseline` contiennent eux aussi des
  // impératifs Nodal (« call `file_write` IMMEDIATELY »). Ceux-là relèvent de
  // la couche agent, pas du runtime — invariant #3, on corrige au catalogue,
  // jamais en rustinant le prompt. Le trou est consigné dans la PR.
  const ORDRES_NODAL = [
    'assign tool `assign_', // roster : nomme un outil de délégation inexistant
    'you MUST call `skill_view', // skills : précondition impossible
    'DO NOT call `query_memory`', // mémoire : consigne sur un outil absent
    'When using file_read / file_write', // workspace : API Nodal
  ];

  it('aucun de ces ordres sur la surface cli-runtime', async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    const trouves = ORDRES_NODAL.filter((o) => prompt.includes(o));
    expect(trouves, `ordres inexécutables encore composés : ${trouves.join(' | ')}`).toEqual([]);
  });

  it('inline le CONTENU du skill, faute de pouvoir le charger à la demande', async () => {
    // Constat de la passe 2 : le prompt annonçait des skills sans donner ni leur
    // contenu ni un chemin ouvrable. L'agent connaissait le nom d'une capacité
    // qu'il ne pouvait pas atteindre — le même défaut que la délégation.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, 'le contenu du skill manque').toContain('MARQUEUR_CONTENU_SKILL');
  });

  it('garde la discipline générale du baseline', async () => {
    // Le baseline avait été supprimé EN ENTIER pour cette surface, sur une
    // affirmation fausse de ma part : il serait « entièrement » bâti autour des
    // builtins. En réalité il agrège aussi les skills catalogue `baseline` —
    // vérifier avant de déclarer terminé, hygiène du workspace, miroir de
    // langue — qui ne dépendent d'aucun outil.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, 'la discipline générale a été jetée avec les consignes').toContain(
      '## How you work (always)',
    );
  });

  it("garde l'équipe — le bug d'origine reste corrigé", async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt).toContain('sous-agent-test');
  });

  it('la surface Nodal ordinaire garde ses ordres', async () => {
    const prompt = await buildSystemPrompt(agent as never, db, { origin: 'api' } as never);
    for (const o of ORDRES_NODAL) {
      expect(prompt, `la surface ordinaire a perdu : ${o}`).toContain(o);
    }
  });
});
