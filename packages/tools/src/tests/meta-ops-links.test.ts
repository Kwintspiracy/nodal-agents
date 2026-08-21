// meta-ops-links.test.ts — les cinq méta-outils qui RETIRENT ou DONNENT une
// capacité à un agent.
//
// Ces outils sont ce qu'un agent peut s'appliquer à lui-même ou à ses pairs :
// retirer un connecteur, un serveur MCP, une skill, un sous-agent, ou en
// rattacher un. Le runner n'expose les outils d'une ressource QUE via ces
// tables de lien — supprimer la mauvaise ligne ne casse rien visiblement, ça
// rend juste un agent silencieusement moins capable, à la prochaine exécution.
//
// Trois questions à chaque fois, et une seule compte vraiment :
//
//   - la bonne ligne part-elle ? (facile)
//   - les VOISINES restent-elles ? (c'est là que se logent les régressions)
//   - un slug d'une autre entité peut-il servir de levier ? (l'étanchéité)
//
// `detach_agent` a en plus une promesse écrite dans sa description — « l'agent
// lui-même n'est PAS supprimé » — qui mérite d'être vérifiée plutôt que crue.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import {
  eq,
  and,
  agents,
  agentAssignments,
  agentConnectorAssignments,
  agentMcpServers,
  agentSkillAssignments,
  agentSkills,
  connectors,
  entities,
  mcpServers,
  users,
} from '@nodal-agents/db';
import type { ToolContext } from '../types.ts';
import { detachAgentTool } from '../builtin/meta-ops/detach-agent.ts';
import { detachConnectorTool } from '../builtin/meta-ops/detach-connector.ts';
import { detachMcpTool } from '../builtin/meta-ops/detach-mcp.ts';
import { detachSkillTool } from '../builtin/meta-ops/detach-skill.ts';
import { attachConnectorTool } from '../builtin/meta-ops/attach-connector.ts';

let db: TestDb;
let seed: Awaited<ReturnType<typeof seedMinimal>>;

/** Décor de l'entité voisine — sert à prouver l'étanchéité, jamais à écrire. */
let foreignEntityId: string;
let foreignAgentId: string;
let foreignConnectorId: string;

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    ...overrides,
  };
}

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);

  const [otherUser] = await db
    .insert(users)
    .values({ email: `voisin-${crypto.randomUUID()}@example.com` })
    .returning();
  const [otherEntity] = await db
    .insert(entities)
    .values({
      userId: otherUser!.id,
      name: 'Entité voisine',
      slug: `voisine-${crypto.randomUUID()}`,
    })
    .returning();
  foreignEntityId = otherEntity!.id;

  const [otherAgent] = await db
    .insert(agents)
    .values({
      entityId: foreignEntityId,
      name: 'Agent voisin',
      slug: 'agent-voisin',
      personality: 'p',
    })
    .returning();
  foreignAgentId = otherAgent!.id;

  const [otherConnector] = await db
    .insert(connectors)
    .values({
      entityId: foreignEntityId,
      name: 'Connecteur voisin',
      slug: 'connecteur-voisin',
      authType: 'api_key',
    })
    .returning();
  foreignConnectorId = otherConnector!.id;
});

/** Un agent de plus dans l'entité de la session, avec un slug propre au test. */
async function makeAgent(slug: string, name = slug) {
  const [row] = await db
    .insert(agents)
    .values({ entityId: seed.entityId, name, slug, personality: 'p' })
    .returning();
  return row!;
}

async function makeConnector(slug: string, name = slug) {
  const [row] = await db
    .insert(connectors)
    .values({ entityId: seed.entityId, name, slug, authType: 'api_key' })
    .returning();
  return row!;
}

async function makeMcp(slug: string, name = slug) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      entityId: seed.entityId,
      name,
      slug,
      transport: 'http',
      url: 'https://exemple.test/mcp',
    })
    .returning();
  return row!;
}

async function makeSkill(slug: string, name = slug) {
  const [row] = await db
    .insert(agentSkills)
    .values({ entityId: seed.entityId, name, slug, content: '# skill' })
    .returning();
  return row!;
}

let compteur = 0;
beforeEach(() => {
  compteur += 1;
});
const suffixe = () => `t${compteur}-${crypto.randomUUID().slice(0, 8)}`;

// ─── detach_connector ────────────────────────────────────────────────────────

describe('detach_connector', () => {
  it('retire le lien visé et laisse celui de l’autre connecteur du même agent', async () => {
    const s = suffixe();
    const cible = await makeConnector(`notion-${s}`);
    const voisin = await makeConnector(`slack-${s}`);
    await db.insert(agentConnectorAssignments).values([
      { entityId: seed.entityId, agentId: seed.agentId, connectorId: cible.id },
      { entityId: seed.entityId, agentId: seed.agentId, connectorId: voisin.id },
    ]);

    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await detachConnectorTool.execute(
      { connectorSlug: cible.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);

    const restants = await db
      .select()
      .from(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, seed.agentId));
    expect(restants.map((l) => l.connectorId)).not.toContain(cible.id);
    expect(
      restants.map((l) => l.connectorId),
      'le lien voisin a été emporté',
    ).toContain(voisin.id);
  });

  it('ne retire RIEN chez une autre entité, même avec le bon slug', async () => {
    // Le connecteur du voisin est lié à l'agent du voisin. Depuis notre
    // contexte, son slug ne doit rien résoudre du tout.
    await db.insert(agentConnectorAssignments).values({
      entityId: foreignEntityId,
      agentId: foreignAgentId,
      connectorId: foreignConnectorId,
    });

    const r = await detachConnectorTool.execute(
      { connectorSlug: 'connecteur-voisin', agentSlug: 'agent-voisin' },
      makeCtx(),
    );
    expect(r.ok).toBe(false);

    const liens = await db
      .select()
      .from(agentConnectorAssignments)
      .where(eq(agentConnectorAssignments.agentId, foreignAgentId));
    expect(liens, 'un lien d’une autre entité a été supprimé').toHaveLength(1);
  });

  it('est idempotent — détacher deux fois ne lève pas', async () => {
    const s = suffixe();
    const c = await makeConnector(`gmail-${s}`);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
    await db
      .insert(agentConnectorAssignments)
      .values({ entityId: seed.entityId, agentId: seed.agentId, connectorId: c.id });

    const premier = await detachConnectorTool.execute(
      { connectorSlug: c.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    const second = await detachConnectorTool.execute(
      { connectorSlug: c.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(premier.ok).toBe(true);
    expect(second.ok, 'le second détachement a échoué').toBe(true);
  });
});

// ─── detach_mcp ──────────────────────────────────────────────────────────────

describe('detach_mcp', () => {
  it('retire le lien visé et laisse l’autre serveur MCP du même agent', async () => {
    const s = suffixe();
    const cible = await makeMcp(`stripe-${s}`);
    const voisin = await makeMcp(`linear-${s}`);
    await db.insert(agentMcpServers).values([
      { entityId: seed.entityId, agentId: seed.agentId, mcpServerId: cible.id },
      { entityId: seed.entityId, agentId: seed.agentId, mcpServerId: voisin.id },
    ]);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await detachMcpTool.execute(
      { mcpSlug: cible.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);

    const restants = await db
      .select()
      .from(agentMcpServers)
      .where(eq(agentMcpServers.agentId, seed.agentId));
    expect(restants.map((l) => l.mcpServerId)).not.toContain(cible.id);
    expect(
      restants.map((l) => l.mcpServerId),
      'le lien voisin a été emporté',
    ).toContain(voisin.id);
  });

  it('laisse le serveur MCP lui-même en place — seul le lien disparaît', async () => {
    // Détacher n'est pas supprimer : la ressource doit rester rattachable.
    const s = suffixe();
    const m = await makeMcp(`notion-mcp-${s}`);
    await db
      .insert(agentMcpServers)
      .values({ entityId: seed.entityId, agentId: seed.agentId, mcpServerId: m.id });
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    await detachMcpTool.execute({ mcpSlug: m.slug, agentSlug: agentRow!.slug }, makeCtx());

    expect((await db.select().from(mcpServers).where(eq(mcpServers.id, m.id))).length).toBe(1);
  });

  it('refuse un slug inconnu et nomme la ressource introuvable', async () => {
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
    const r = await detachMcpTool.execute(
      { mcpSlug: 'mcp-qui-nexiste-pas', agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('mcp-qui-nexiste-pas');
  });
});

// ─── detach_skill ────────────────────────────────────────────────────────────

describe('detach_skill', () => {
  it('retire l’assignation mais NE SUPPRIME PAS la skill', async () => {
    // La skill est une ressource de l'espace ; la détacher d'un agent ne doit
    // pas la faire disparaître pour les autres.
    const s = suffixe();
    const skill = await makeSkill(`veille-${s}`);
    const autre = await makeAgent(`agent-b-${s}`);
    await db.insert(agentSkillAssignments).values([
      { entityId: seed.entityId, agentId: seed.agentId, skillId: skill.id },
      { entityId: seed.entityId, agentId: autre.id, skillId: skill.id },
    ]);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await detachSkillTool.execute(
      { skillSlug: skill.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);

    // La skill existe toujours…
    expect((await db.select().from(agentSkills).where(eq(agentSkills.id, skill.id))).length).toBe(
      1,
    );
    // …l'assignation de l'agent visé est partie…
    expect(
      (
        await db
          .select()
          .from(agentSkillAssignments)
          .where(
            and(
              eq(agentSkillAssignments.agentId, seed.agentId),
              eq(agentSkillAssignments.skillId, skill.id),
            ),
          )
      ).length,
    ).toBe(0);
    // …et celle de l'autre agent est intacte.
    expect(
      (
        await db
          .select()
          .from(agentSkillAssignments)
          .where(
            and(
              eq(agentSkillAssignments.agentId, autre.id),
              eq(agentSkillAssignments.skillId, skill.id),
            ),
          )
      ).length,
      'l’assignation d’un autre agent a été emportée',
    ).toBe(1);
  });

  it('refuse une skill d’une autre entité', async () => {
    const [foreignSkill] = await db
      .insert(agentSkills)
      .values({
        entityId: foreignEntityId,
        name: 'Skill voisine',
        slug: 'skill-voisine',
        content: '# x',
      })
      .returning();
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await detachSkillTool.execute(
      { skillSlug: 'skill-voisine', agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok).toBe(false);

    expect(
      (await db.select().from(agentSkills).where(eq(agentSkills.id, foreignSkill!.id))).length,
    ).toBe(1);
  });
});

// ─── detach_agent ────────────────────────────────────────────────────────────

describe('detach_agent', () => {
  it('retire le sous-agent de MON équipe sans supprimer l’agent', async () => {
    // La description de l'outil promet « the agent itself is NOT deleted ».
    // C'est une promesse faite au LLM : elle doit être vraie.
    const s = suffixe();
    const sousAgent = await makeAgent(`sous-agent-${s}`);
    await db.insert(agentAssignments).values({
      entityId: seed.entityId,
      orchestratorId: seed.agentId,
      subAgentId: sousAgent.id,
    });

    const r = await detachAgentTool.execute({ agentSlug: sousAgent.slug }, makeCtx());
    expect(r.ok, r.ok ? '' : r.error).toBe(true);

    expect(
      (
        await db
          .select()
          .from(agentAssignments)
          .where(
            and(
              eq(agentAssignments.orchestratorId, seed.agentId),
              eq(agentAssignments.subAgentId, sousAgent.id),
            ),
          )
      ).length,
    ).toBe(0);
    expect(
      (await db.select().from(agents).where(eq(agents.id, sousAgent.id))).length,
      'l’agent lui-même a été supprimé — la description ment',
    ).toBe(1);
  });

  it('ne défait QUE mon lien — l’équipe d’un autre orchestrateur reste', async () => {
    // Deux orchestrateurs peuvent déléguer au même sous-agent. Un DELETE qui
    // oublierait `orchestratorId` désorganiserait l'équipe du voisin.
    const s = suffixe();
    const sousAgent = await makeAgent(`partage-${s}`);
    const autreOrch = await makeAgent(`orchestrateur-${s}`);
    await db.insert(agentAssignments).values([
      { entityId: seed.entityId, orchestratorId: seed.agentId, subAgentId: sousAgent.id },
      { entityId: seed.entityId, orchestratorId: autreOrch.id, subAgentId: sousAgent.id },
    ]);

    await detachAgentTool.execute({ agentSlug: sousAgent.slug }, makeCtx());

    const restants = await db
      .select()
      .from(agentAssignments)
      .where(eq(agentAssignments.subAgentId, sousAgent.id));
    expect(restants, 'le lien d’un autre orchestrateur a été emporté').toHaveLength(1);
    expect(restants[0]!.orchestratorId).toBe(autreOrch.id);
  });

  it('refuse un agent d’une autre entité', async () => {
    const r = await detachAgentTool.execute({ agentSlug: 'agent-voisin' }, makeCtx());
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('agent-voisin');
  });
});

// ─── attach_connector ────────────────────────────────────────────────────────

describe('attach_connector', () => {
  it('crée le lien avec le bon entityId — sans lui le runner n’expose rien', async () => {
    const s = suffixe();
    const c = await makeConnector(`airtable-${s}`);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await attachConnectorTool.execute(
      { connectorSlug: c.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok, r.ok ? '' : r.error).toBe(true);

    const [lien] = await db
      .select()
      .from(agentConnectorAssignments)
      .where(
        and(
          eq(agentConnectorAssignments.agentId, seed.agentId),
          eq(agentConnectorAssignments.connectorId, c.id),
        ),
      );
    expect(lien, 'aucun lien écrit — le connecteur resterait invisible').toBeDefined();
    expect(lien!.entityId).toBe(seed.entityId);
  });

  it('est idempotent — deux rattachements laissent UNE ligne', async () => {
    const s = suffixe();
    const c = await makeConnector(`hubspot-${s}`);
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    await attachConnectorTool.execute(
      { connectorSlug: c.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    const second = await attachConnectorTool.execute(
      { connectorSlug: c.slug, agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(second.ok, second.ok ? '' : second.error).toBe(true);

    const liens = await db
      .select()
      .from(agentConnectorAssignments)
      .where(
        and(
          eq(agentConnectorAssignments.agentId, seed.agentId),
          eq(agentConnectorAssignments.connectorId, c.id),
        ),
      );
    expect(liens).toHaveLength(1);
  });

  it('refuse un connecteur d’une autre entité — aucun lien n’est créé', async () => {
    // Le levier le plus tentant : donner à MON agent le connecteur — donc la
    // clé API — d'un autre espace.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));

    const r = await attachConnectorTool.execute(
      { connectorSlug: 'connecteur-voisin', agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok).toBe(false);

    const liens = await db
      .select()
      .from(agentConnectorAssignments)
      .where(
        and(
          eq(agentConnectorAssignments.agentId, seed.agentId),
          eq(agentConnectorAssignments.connectorId, foreignConnectorId),
        ),
      );
    expect(liens, 'un connecteur d’une autre entité a été rattaché').toHaveLength(0);
  });

  it('nomme le remède quand le connecteur n’existe pas', async () => {
    // L'outil s'adresse à un LLM : un message qui dit quoi faire ensuite évite
    // une boucle de tentatives identiques.
    const [agentRow] = await db.select().from(agents).where(eq(agents.id, seed.agentId));
    const r = await attachConnectorTool.execute(
      { connectorSlug: 'connecteur-fantome', agentSlug: agentRow!.slug },
      makeCtx(),
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error).toContain('create_connector');
  });
});
