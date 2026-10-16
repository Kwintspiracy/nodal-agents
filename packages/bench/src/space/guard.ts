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
// CE QUI N'EST PAS COUVERT, et la commande le DIT à chaque fois (`scope`) au
// lieu de le laisser croire. La liste n'est pas tenue ici : c'est la
// déclaration `egress` de chaque outil que Nodal sert (le catalogue
// `servedToolDefinitions` d'@nodal-agents/orchestration, où un test la rend
// obligatoire) — un processus lancé (shell, script de skill, CLI de code,
// commandes de vérification), internet, un fournisseur de modèle. S'y ajoutent les
// runtimes CLI (Claude Code, Codex : leurs outils ne passent pas par la liste
// de Nodal), et les déclencheurs webhook, ni copiés ni couverts. Ces outils
// restent, les scénarios de code en ont besoin ; `notCovered` nomme ceux que
// l'équipe tient vraiment, et chaque agent en runtime CLI.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentId, EntityId } from '@nodal-agents/orchestration';
import type { ToolEgress } from '@nodal-agents/tools';
import { requireBenchSpace } from './space';

/** Ce que veut dire, pour un outil intégré, chaque `egress` que le contrôle ne couvre pas. */
const NOT_COVERED_EGRESS: Partial<Record<ToolEgress, string>> = {
  process: 'a process they start',
  internet: 'the internet',
  'model-provider': 'a model provider',
};

/**
 * Les outils que Nodal sert et qui atteignent le réseau d'eux-mêmes, hors
 * canal : nom → egress. Lus du catalogue complet (`servedToolDefinitions` :
 * le registre, les fabriques par job, les outils de délégation), la MÊME
 * liste que le test qui rend la déclaration obligatoire.
 */
async function networkBuiltins(): Promise<Map<string, ToolEgress>> {
  const { servedToolDefinitions } = await import('@nodal-agents/orchestration');
  return new Map(
    servedToolDefinitions()
      .filter((t) => t.egress !== undefined && t.egress in NOT_COVERED_EGRESS)
      .map((t) => [t.name, t.egress!] as const)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/** La phrase que la commande imprime, que le contrôle passe ou non, lue des déclarations. */
export async function checkScope(): Promise<string> {
  const byEgress = new Map<ToolEgress, string[]>();
  for (const [name, egress] of await networkBuiltins()) {
    byEgress.set(egress, [...(byEgress.get(egress) ?? []), name]);
  }
  const parts = [...byEgress].map(
    ([egress, names]) => `${names.join(', ')} (${NOT_COVERED_EGRESS[egress]!})`,
  );
  return (
    'This check covers channels (tokens and bindings), connectors and MCP servers, and the root ' +
    'grants that add one. It does not cover the built-in tools that reach the network on their ' +
    `own: ${parts.join('; ')}; nor CLI runtimes (Claude Code, Codex), whose tools are not ` +
    "Nodal's. Webhook triggers are not copied, and not covered."
  );
}

export interface SendCheck {
  ok: boolean;
  /** Une ligne par trou, lisible, sans secret : chacune refuse l'essai. */
  findings: string[];
  /** Ce que le contrôle ne peut pas voir, nommé : ne refuse pas l'essai. */
  notCovered: string[];
  /** Ce que le contrôle couvre et ne couvre pas, en une phrase. */
  scope: string;
}

/** Ce qui, dans l'espace du banc, peut parler au monde. Ne modifie rien. */
export async function checkSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<SendCheck> {
  const d = await import('@nodal-agents/db');
  const { computeAgentToolOrigins } = await import('@nodal-agents/orchestration');
  const id = spaceId ?? (await requireBenchSpace(db)).id;
  const findings: string[] = [];
  const notCovered: string[] = [];
  const network = await networkBuiltins();
  const holders = new Map<string, string[]>();

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
    const { names, outbound } = await computeAgentToolOrigins(a.id as AgentId, id as EntityId, db, {
      hasDeliveryRecipient: true,
    });
    for (const n of names) {
      if (network.has(n)) holders.set(n, [...(holders.get(n) ?? []), a.slug]);
    }
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
  for (const [tool, egress] of network) {
    const who = holders.get(tool);
    if (who) notCovered.push(`${tool} (${egress}): held by ${who.join(', ')}`);
  }
  return { ok: findings.length === 0, findings, notCovered, scope: await checkScope() };
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
  lines.push(c.scope);
  return lines.join('\n');
}

/** Le contrôle d'avant essai : il refuse, en nommant chaque trou. */
export async function assertSpaceCannotSend(db: AnyDrizzleDb, spaceId?: string): Promise<void> {
  const r = await checkSpaceCannotSend(db, spaceId);
  if (!r.ok) {
    throw new Error(
      `bench_space_can_send: the trial does not start, the bench team can reach outside Nodal:\n` +
        r.findings.map((f) => `  - ${f}`).join('\n') +
        `\n${r.scope}`,
    );
  }
}
