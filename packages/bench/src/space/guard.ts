// space/guard.ts — avant chaque essai : l'équipe du banc ne peut rien envoyer
// hors de Nodal, et aucun canal n'est lié à l'espace.
//
// C'est la prévention STRUCTURELLE qui remplace le garde-fou du banc sur les
// noms d'outils appelés après coup : un essai ne démarre pas si un agent de
// l'espace TIENT un outil qui sort de Nodal. Le calcul est celui du produit,
// jamais une liste de noms : `computeAgentToolOrigins` (@nodal-agents/
// orchestration) donne, pour chaque agent, les outils qu'un job recevrait et
// ce qui les lui prête — un jeton ou une liaison de canal (les outils de
// livraison), un connecteur (un service tiers), un serveur MCP. Les liaisons
// de canal de l'espace sont refusées en plus, toutes, même désactivées : une
// liaison est un canal ouvert sur le monde, qu'un geste suffit à réactiver.
//
// Ce que la vérification NE couvre PAS, dit plutôt que tu : les outils intégrés
// qui touchent le réseau sans être un canal (`web_search`, et `run_command`
// quand un agent a un shell). Le produit ne les classe pas comme « envoi »,
// et une liste de noms inventée ici serait la mauvaise réponse.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentId, EntityId } from '@nodal-agents/orchestration';
import { requireBenchSpace } from './space';

export interface SendCheck {
  ok: boolean;
  /** Une ligne par trou, lisible, sans secret. */
  findings: string[];
}

/** Ce qui, dans l'espace du banc, peut parler au monde. Ne modifie rien. */
export async function checkSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<SendCheck> {
  const d = await import('@nodal-agents/db');
  const { computeAgentToolOrigins } = await import('@nodal-agents/orchestration');
  const id = spaceId ?? (await requireBenchSpace(db)).id;
  const findings: string[] = [];

  const team = await db
    .select({ id: d.agents.id, slug: d.agents.slug })
    .from(d.agents)
    .where(d.eq(d.agents.entityId, id))
    .orderBy(d.agents.slug);
  const slugOf = new Map(team.map((a) => [a.id, a.slug]));

  const bindings = await db
    .select({ agentId: d.channelBindings.agentId, channel: d.channelBindings.channel })
    .from(d.channelBindings)
    .where(
      team.length === 0
        ? d.eq(d.channelBindings.entityId, id)
        : d.or(
            d.eq(d.channelBindings.entityId, id),
            d.inArray(
              d.channelBindings.agentId,
              team.map((a) => a.id),
            ),
          ),
    );
  for (const b of bindings) {
    findings.push(`${b.channel} channel bound to agent ${slugOf.get(b.agentId) ?? b.agentId}`);
  }

  for (const a of team) {
    const { outbound } = await computeAgentToolOrigins(a.id as AgentId, id as EntityId, db, {
      hasDeliveryRecipient: true,
    });
    const byVia = new Map<string, Set<string>>();
    for (const o of outbound) {
      const key = `${o.via} (${o.origin})`;
      byVia.set(key, (byVia.get(key) ?? new Set()).add(o.tool));
    }
    for (const [via, tools] of byVia) {
      findings.push(
        `agent ${a.slug} can send outside Nodal through ${via}: ${[...tools].sort().join(', ')}`,
      );
    }
  }
  return { ok: findings.length === 0, findings };
}

/** Le contrôle d'avant essai : il refuse, en nommant chaque trou. */
export async function assertSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<void> {
  const r = await checkSpaceCannotSend(db, spaceId);
  if (!r.ok) {
    throw new Error(
      `bench_space_can_send: the trial does not start, the bench team can reach outside Nodal:\n` +
        r.findings.map((f) => `  - ${f}`).join('\n'),
    );
  }
}
