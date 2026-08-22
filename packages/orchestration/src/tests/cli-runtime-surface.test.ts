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
import { agents, agentAssignments, eq } from '@nodal-agents/db';

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

describe('aucune consigne portant sur un outil absent', () => {
  // La review a mesuré 23 mentions d'outils Nodal dans le prompt cli-runtime —
  // et AUCUNE n'était un fait : « you MUST call mark_memory_outdated », « use
  // assign_* when… », « after every file_write, call file_read ». Un agent
  // Claude Code n'a aucun de ces outils : son argv porte --strict-mcp-config et
  // un --disallowedTools purement soustractif, sans --allowedTools ni
  // --mcp-config. Chaque ligne était donc un ordre inexécutable.
  const ABSENTS = [
    'assign_',
    'create_task',
    'list_tasks',
    'return_result',
    'skill_view',
    'run_skill_script',
    'save_memory',
    'query_memory',
    'mark_memory_outdated',
    'file_read',
    'file_write',
    'file_edit',
    'file_list',
    'file_search',
  ];

  it("ne nomme AUCUN outil que la session n'a pas", async () => {
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    const trouves = ABSENTS.filter((t) => prompt.includes(t));
    expect(
      trouves,
      `outils Nodal nommés dans un prompt cli-runtime : ${trouves.join(', ')}`,
    ).toEqual([]);
  });

  it("garde l'équipe malgré tout — le bug d'origine reste corrigé", async () => {
    // Le risque du reformage : jeter le bénéfice avec les consignes. L'agent
    // doit toujours SAVOIR qui compose son équipe, il ne doit simplement plus
    // recevoir l'ordre de l'appeler.
    const prompt = await buildSystemPrompt(agent as never, db, {
      origin: 'api',
      surface: 'cli-runtime',
    } as never);
    expect(prompt, 'le sous-agent a disparu avec les consignes').toContain('sous-agent-test');
  });

  it('la surface Nodal ordinaire garde ses consignes', async () => {
    // Le reformage ne doit toucher QUE cli-runtime.
    const prompt = await buildSystemPrompt(agent as never, db, { origin: 'api' } as never);
    expect(prompt).toContain('assign_');
  });
});
