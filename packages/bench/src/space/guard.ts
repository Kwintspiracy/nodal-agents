// space/guard.ts — avant chaque essai : aucun canal, aucun connecteur, aucun
// serveur MCP n'est à la portée de l'équipe du banc, et elle ne peut pas s'en
// ajouter un.
//
// C'est la prévention STRUCTURELLE qui remplace le garde-fou du banc sur les
// noms d'outils appelés après coup : un essai ne démarre pas si un agent de
// l'espace TIENT un tel outil. Le calcul est celui du produit, jamais une liste
// de noms : `computeAgentToolOrigins` (@nodal-agents/orchestration) donne, pour
// chaque agent, les outils qu'un job recevrait et ce qui les lui prête — un
// jeton ou une liaison de canal (les outils de livraison), un connecteur, un
// serveur MCP, ou un droit du racine qui en fait entrer un (`OUTWARD_GRANTS`).
// Les liaisons de canal de l'espace sont refusées en plus, toutes, même
// désactivées : une liaison est un canal qu'un geste suffit à rouvrir.
//
// CE QUI N'EST PAS COUVERT, et la commande le DIT à chaque fois (`CHECK_SCOPE`)
// au lieu de le laisser croire : le shell et les scripts de skill
// (`run_command`, `run_skill_script`), les runtimes CLI et `code_task` (Claude
// Code, Codex : leurs outils ne passent pas par la liste de Nodal), et
// `web_search`. Ils restent, les scénarios de code en ont besoin ; un agent de
// l'espace en runtime CLI est nommé un par un dans `notCovered`.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentId, EntityId } from '@nodal-agents/orchestration';
import { requireBenchSpace } from './space';

/** La phrase que la commande imprime, que le contrôle passe ou non. */
export const CHECK_SCOPE =
  'This check covers channels (tokens and bindings), connectors and MCP servers, and the root ' +
  'grants that add one. It does not cover the shell and skill scripts (run_command, ' +
  'run_skill_script), CLI runtimes and code_task (Claude Code, Codex), or web_search.';

export interface SendCheck {
  ok: boolean;
  /** Une ligne par trou, lisible, sans secret : chacune refuse l'essai. */
  findings: string[];
  /** Ce que le contrôle ne peut pas voir, nommé : ne refuse pas l'essai. */
  notCovered: string[];
}

/** Ce qui, dans l'espace du banc, peut parler au monde. Ne modifie rien. */
export async function checkSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<SendCheck> {
  const d = await import('@nodal-agents/db');
  const { computeAgentToolOrigins } = await import('@nodal-agents/orchestration');
  const id = spaceId ?? (await requireBenchSpace(db)).id;
  const findings: string[] = [];
  const notCovered: string[] = [];

  const team = await db
    .select({ id: d.agents.id, slug: d.agents.slug, runtime: d.agents.runtime })
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
    if (a.runtime !== 'nodal') {
      notCovered.push(`agent ${a.slug} (${a.runtime}): runs outside Nodal's tool list`);
    }
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
        `agent ${a.slug} reaches outside Nodal through ${via}: ${[...tools].sort().join(', ')}`,
      );
    }
  }
  return { ok: findings.length === 0, findings, notCovered };
}

/** Le résultat, tel que la commande l'imprime : ce qui est vu, ce qui ne l'est pas, la portée. */
export function renderCheck(c: SendCheck): string {
  const lines = c.ok
    ? ['Bench space: no channel, connector or MCP server is within reach, and none can be added.']
    : [
        'Bench space can reach outside Nodal; a trial would not start:',
        ...c.findings.map((f) => `  - ${f}`),
      ];
  if (c.notCovered.length > 0) {
    lines.push('Not covered:', ...c.notCovered.map((n) => `  - ${n}`));
  }
  lines.push(CHECK_SCOPE);
  return lines.join('\n');
}

/** Le contrôle d'avant essai : il refuse, en nommant chaque trou. */
export async function assertSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<void> {
  const r = await checkSpaceCannotSend(db, spaceId);
  if (!r.ok) {
    throw new Error(
      `bench_space_can_send: the trial does not start, the bench team can reach outside Nodal:\n` +
        r.findings.map((f) => `  - ${f}`).join('\n') +
        `\n${CHECK_SCOPE}`,
    );
  }
}
