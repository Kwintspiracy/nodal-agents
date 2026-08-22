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
