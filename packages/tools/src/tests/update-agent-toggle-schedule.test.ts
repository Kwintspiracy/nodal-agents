// update-agent-toggle-schedule.test.ts — les deux derniers outils intégrés sans
// aucun test.
//
// Ils n'étaient pas les moins risqués, juste les derniers : `update_agent`
// réécrit la personnalité d'un agent — c'est-à-dire son prompt système — et
// `toggle_schedule` met en pause ou relance une tâche planifiée. Tous deux sont
// `riskLevel: 'write'` avec approbation par défaut, et tous deux tiennent leur
// portée par un unique `eq(entityId)` dans le SELECT.
//
// C'est cette ligne-là que les tests visent en priorité : sans elle, un agent
// qui connaît un slug modifie le prompt de l'agent d'un autre espace, ou coupe
// ses planifications. On asserte donc sur les LIGNES relues après coup, jamais
// sur le message de retour.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, and, agents, agentSchedules, entities, users } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import type { ToolContext } from '../types';
import { updateAgentTool } from '../builtin/meta-ops/update-agent';
import { toggleScheduleTool } from '../builtin/meta-ops/schedule-ops';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** L'espace d'à côté — jamais celui du contexte d'exécution. */
const voisin = { entityId: '', agentSlug: '', scheduleName: '' };

function ctx(): ToolContext {
  // Contexte complet, pas un cast : un `as ToolContext` sur un objet incomplet
  // masquerait l'ajout d'un champ obligatoire au lieu de le signaler ici.
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    jobChatId: null,
    db,
  };
}

beforeAll(async () => {
  const result = await spinUpTestDb();
  db = result.db;
  seed = await seedMinimal(db);

  const [autreUser] = await db
    .insert(users)
    .values({ email: `voisin-tools-${Date.now()}@example.com` })
    .returning();
  const [autreEntite] = await db
    .insert(entities)
    .values({
      userId: autreUser!.id,
      name: 'Espace voisin',
      slug: `voisin-tools-${Date.now()}`,
    })
    .returning();
  voisin.entityId = autreEntite!.id;

  voisin.agentSlug = `agent-voisin-${Date.now()}`;
  await db.insert(agents).values({
    entityId: voisin.entityId,
    name: 'Agent du voisin',
    slug: voisin.agentSlug,
    personality: 'Consigne du voisin.',
  });

  voisin.scheduleName = `veille-voisine-${Date.now()}`;
  await db.insert(agentSchedules).values({
    entityId: voisin.entityId,
    agentId: seed.agentId,
    name: voisin.scheduleName,
    cronExpr: '0 9 * * *',
    task: 'Rapport du matin',
    active: true,
  });
});

async function agentParSlug(slug: string) {
  const [row] = await db.select().from(agents).where(eq(agents.slug, slug));
  return row;
}

describe('update_agent', () => {
  it('réécrit la personnalité de l’agent visé — et le relit pour le prouver', async () => {
    const slug = `cible-${Date.now()}`;
    await db.insert(agents).values({
      entityId: seed.entityId,
      name: 'Cible',
      slug,
      personality: 'Avant.',
    });

    const res = await updateAgentTool.execute({ slug, personality: 'Après.' }, ctx());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect((await agentParSlug(slug))?.personality).toBe('Après.');
  });

  it('met à jour le nom sans toucher à la personnalité', async () => {
    const slug = `nom-seul-${Date.now()}`;
    await db.insert(agents).values({
      entityId: seed.entityId,
      name: 'Ancien nom',
      slug,
      personality: 'Ne doit pas bouger.',
    });

    await updateAgentTool.execute({ slug, name: 'Nouveau nom' }, ctx());

    const row = await agentParSlug(slug);
    expect(row?.name).toBe('Nouveau nom');
    expect(row?.personality, 'la personnalité a été écrasée au passage').toBe(
      'Ne doit pas bouger.',
    );
  });

  it('ne touche PAS l’agent d’un autre espace, même avec le bon slug', async () => {
    const res = await updateAgentTool.execute(
      { slug: voisin.agentSlug, personality: 'Consigne injectée.' },
      ctx(),
    );

    expect(res.ok).toBe(false);
    expect(
      (await agentParSlug(voisin.agentSlug))?.personality,
      'la personnalité du voisin a été réécrite',
    ).toBe('Consigne du voisin.');
  });

  it('refuse un appel qui ne demande aucun changement', async () => {
    const res = await updateAgentTool.execute({ slug: 'peu-importe' }, ctx());

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/nothing to update/i);
  });

  it('refuse un slug inconnu et n’invente pas d’agent', async () => {
    const avant = (await db.select().from(agents)).length;

    const res = await updateAgentTool.execute(
      { slug: 'agent-qui-nexiste-pas', name: 'Fantôme' },
      ctx(),
    );

    expect(res.ok).toBe(false);
    expect((await db.select().from(agents)).length).toBe(avant);
  });
});

describe('toggle_schedule', () => {
  /** Pose une planification dans l'espace du contexte. */
  async function planification(name: string, active: boolean) {
    await db.insert(agentSchedules).values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      name,
      cronExpr: '0 9 * * *',
      task: 'Rapport du matin',
      active,
      nextRun: active ? new Date('2030-01-01T09:00:00Z') : null,
    });
  }

  async function planifParNom(name: string) {
    const [row] = await db.select().from(agentSchedules).where(eq(agentSchedules.name, name));
    return row;
  }

  it('met en pause — la ligne passe à active=false', async () => {
    const name = `pause-${Date.now()}`;
    await planification(name, true);

    const res = await toggleScheduleTool.execute({ name, active: false }, ctx());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    expect((await planifParNom(name))?.active).toBe(false);
  });

  it('relance — et recalcule la prochaine exécution au lieu de la laisser périmée', async () => {
    const name = `reprise-${Date.now()}`;
    await planification(name, false);

    const res = await toggleScheduleTool.execute({ name, active: true }, ctx());

    expect(res.ok, res.ok ? '' : res.error).toBe(true);
    const row = await planifParNom(name);
    expect(row?.active).toBe(true);
    // Une reprise sans nextRun laisse une planification active qui ne part
    // jamais — le pire des deux mondes, et invisible dans l'interface.
    expect(row?.nextRun, 'reprise sans prochaine exécution calculée').toBeTruthy();
    expect(row!.nextRun!.getTime()).toBeGreaterThan(Date.now());
  });

  it('ne coupe PAS la planification d’un autre espace', async () => {
    const res = await toggleScheduleTool.execute(
      { name: voisin.scheduleName, active: false },
      ctx(),
    );

    expect(res.ok).toBe(false);
    const [row] = await db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.entityId, voisin.entityId),
          eq(agentSchedules.name, voisin.scheduleName),
        ),
      );
    expect(row?.active, 'la planification du voisin a été mise en pause').toBe(true);
  });

  it('refuse un nom inconnu', async () => {
    const res = await toggleScheduleTool.execute(
      { name: 'planification-qui-nexiste-pas', active: false },
      ctx(),
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/no schedule named/i);
  });
});
