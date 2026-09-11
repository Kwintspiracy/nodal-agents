// chat-surface-cost.test.ts — la surface `chat` ne reçoit que ce qu'elle peut
// obéir, et ça coûte deux fois moins de jetons.
//
// Mesuré le 12/09/2026 sur la base de Quentin : le prompt système d'un tour de
// chat pesait ~9 000 jetons, dont ~3 900 de skills « baseline » et ~1 800 de
// bloc d'équipe. Or, sur cette surface, l'agent a UN outil : `run_task`. Il ne
// peut ni lire un fichier avant de l'écrire (« Verify before done », « Safe
// tool use », « Workspace hygiene »), ni `save_memory` (« Memory discipline »),
// ni `assign_*` (le bloc d'équipe). Chaque « you MUST » de ces textes était un
// ordre inexécutable — exactement le défaut fermé pour `cli-runtime`, et par la
// même règle : un texte qui prescrit des outils absents de la surface ne s'y
// injecte pas.
//
// La règle vit dans le CATALOGUE (invariant #3) : chaque skill système déclare
// les surfaces où son texte peut être suivi. Ici, on prouve ce que le prompt
// assemblé contient et ne contient plus — et on le mesure.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentAssignments, eq } from '@nodal-agents/db';
import { buildSystemPrompt } from '../system-prompt';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let agent: Record<string, unknown>;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  const [sub] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Sous Agent Chat',
      slug: 'sous-agent-chat',
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
  await db.update(agents).set({ role: 'orchestrator' }).where(eq(agents.id, seed.agentId));
  const [row] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
  agent = row as Record<string, unknown>;
});

const chat = () =>
  buildSystemPrompt(agent as never, db, { origin: 'dashboard', surface: 'chat' } as never);
const job = () => buildSystemPrompt(agent as never, db, { origin: 'api' } as never);

describe('la surface chat ne reçoit que ce qu’elle peut obéir', () => {
  it('les skills baseline qui prescrivent des outils de fichiers sont absentes du chat, présentes sur un job', async () => {
    const c = await chat();
    const j = await job();
    for (const titre of ['## Verify before done', '## Safe tool use', '## Workspace hygiene']) {
      expect(j, `${titre} manque sur un job`).toContain(titre);
      expect(
        c,
        `${titre} injecté sur le chat, où l'agent n'a aucun outil de fichier`,
      ).not.toContain(titre);
    }
  });

  it('« Language mirror » reste : parler la langue de l’utilisateur ne demande aucun outil', async () => {
    expect(await chat()).toContain('## Language mirror');
  });

  it('la discipline de mémoire (save_memory) est absente du chat', async () => {
    expect(await job()).toContain('## Memory discipline');
    expect(await chat()).not.toContain('## Memory discipline');
  });

  it('le bloc d’équipe est une CONNAISSANCE, et dit comment faire faire le travail : run_task', async () => {
    const c = await chat();
    expect(c).toContain('## Your team');
    expect(c).toContain('Sous Agent Chat');
    // Pas de manuel de délégation : ces outils n'existent pas ici.
    expect(c).not.toContain('`assign_<agent>`');
    expect(c).not.toContain('`create_task` — parallel fan-out');
    // Mais pas non plus « tu ne peux rien leur confier » : le chat escalade.
    expect(c).not.toContain('there is no way for you to hand work to them');
    expect(c).toContain('run_task');
  });

  it('coûte au moins 40 % de moins qu’un job — mesuré, pas promis', async () => {
    const c = (await chat()).length;
    const j = (await job()).length;
    expect(c, `chat ${c} car. vs job ${j} car.`).toBeLessThan(j * 0.6);
  });
});
