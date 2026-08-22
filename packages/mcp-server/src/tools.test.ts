// tools.test.ts — le serveur expose-t-il les outils de CET agent, et rien d'autre ?
//
// C'est la propriété qui décide de tout : un serveur MCP est un point d'entrée
// qui crée des jobs. S'il exposait un catalogue global, il annulerait le modèle
// d'autorisation de Nodal (invariant #9 : aucune liste par défaut, tout est
// calculé depuis la base par agent).
//
// Le test qui ne prouverait rien : vérifier que la liste n'est pas vide.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agents, agentAssignments } from '@nodal-agents/db';
import { listExposableTools, isDeferredToC2 } from './tools';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let solitaireId: string;

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  // Un agent AVEC un sous-agent rattaché.
  const [sub] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Chercheur',
      slug: 'chercheur',
      personality: 'Je cherche.',
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

  // Et un agent SANS aucun rattachement — le contrôle.
  const [solo] = await db
    .insert(agents)
    .values({
      entityId: seed.entityId,
      name: 'Solitaire',
      slug: 'solitaire',
      personality: 'Je travaille seul.',
      model: 'test-model',
      role: 'agent',
      active: true,
    })
    .returning();
  solitaireId = (solo as { id: string }).id;
});

describe('la liste exposée vient de la base, par agent', () => {
  it("expose l'assign du sous-agent RÉELLEMENT rattaché", async () => {
    const noms = (await listExposableTools(seed.agentId, db)).map((t) => t.name);
    expect(noms, "le sous-agent rattaché n'est pas exposé").toContain('assign_chercheur');
  });

  it("n'expose AUCUN assign pour un agent sans équipe", async () => {
    // LA propriété qui compte. Un serveur qui exposerait un `assign_*` générique
    // à tout le monde laisserait un agent confier du travail à des agents qui ne
    // sont pas les siens.
    const noms = (await listExposableTools(solitaireId, db)).map((t) => t.name);
    const assigns = noms.filter((n) => n.startsWith('assign_'));
    expect(assigns, `un agent sans équipe expose ${assigns.join(', ')}`).toEqual([]);
  });

  it("n'expose pas l'équipe d'un AUTRE agent", async () => {
    const noms = (await listExposableTools(solitaireId, db)).map((t) => t.name);
    expect(noms, "l'équipe d'un autre agent a fuité").not.toContain('assign_chercheur');
  });

  it('expose toujours les outils de tâches, eux', async () => {
    // Ceux-là ne dépendent pas d'un rattachement : créer une tâche est ce qui
    // reste possible sans équipe.
    const noms = (await listExposableTools(solitaireId, db)).map((t) => t.name);
    expect(noms).toContain('create_task');
    expect(noms).toContain('list_tasks');
  });
});

describe('ce qui est listé mais pas encore exécutable', () => {
  it('marque assign_* comme reporté, et rien d’autre', () => {
    // Refuser à l'exécution tout en LISTANT est un choix : l'outil existe dans
    // la base de cet agent, le client a le droit de savoir pourquoi il ne peut
    // pas s'en servir. Le taire donnerait le même symptôme qu'un droit manquant.
    expect(isDeferredToC2('assign_chercheur')).toBe(true);
    expect(isDeferredToC2('create_task')).toBe(false);
    expect(isDeferredToC2('list_tasks')).toBe(false);
  });
});
