// mcp-provenance.ts — un job descend-il d'un appel MCP ?
//
// Les jobs de provenance MCP n'obtiennent jamais les meta-tools (décision
// Quentin 23/08 : demander du travail ≠ reconfigurer la plateforme). La
// provenance est HÉRITÉE le long de `parentJobId`, sinon un job MCP la perd en
// un `create_task` vers la racine.
//
// FAIL-CLOSED, et c'est le point que la review a retourné contre ma première
// version : elle bornait la marche à 5 sauts et s'arrêtait en silence sur un
// parent manquant — donc une chaîne assez longue (fabricable librement via
// /api/agent, qui accepte un parentJobId arbitraire de la même entité) ou un
// parent purgé par la rétention suffisait à RÉCUPÉRER les meta-tools. Une
// garde qui s'ouvre quand elle ne sait pas n'est pas une garde.
//
// Désormais : provenance indéterminable ⇒ traité comme MCP. Le coût est
// qu'un job légitime à la chaîne cassée (parent purgé) perd ses meta-tools —
// il peut toujours travailler, et la reconfiguration reste disponible sur les
// surfaces à humain visible (dashboard, chat, dont les jobs racine n'ont pas
// de parent et ne marchent donc jamais ici). Perdre un outil de config par
// prudence est un inconfort ; l'accorder par ignorance est une faille.

import { agentJobs, eq } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';

/**
 * Large au-delà de toute chaîne légitime (maxDelegationDepth = 3, plus les
 * sauts tâche→job). Ce n'est PAS la borne de sécurité — l'épuiser conclut
 * « indéterminable », donc restreint.
 */
const MAX_ANCESTOR_HOPS = 10;

export async function isMcpOriginJob(
  db: AnyDrizzleDb,
  job: { channel: string | null; parentJobId: string | null },
): Promise<boolean> {
  if (job.channel === 'mcp') return true;
  let ancestorId = job.parentJobId;
  for (let hop = 0; hop < MAX_ANCESTOR_HOPS; hop++) {
    if (!ancestorId) return false; // racine atteinte : provenance établie, non-MCP
    const [ancestor] = await db
      .select({ channel: agentJobs.channel, parentJobId: agentJobs.parentJobId })
      .from(agentJobs)
      .where(eq(agentJobs.id, ancestorId))
      .limit(1);
    // Parent manquant (purgé par la rétention, ou id forgé) : la provenance est
    // INDÉTERMINABLE. Fermer, pas ouvrir.
    if (!ancestor) return true;
    if (ancestor.channel === 'mcp') return true;
    ancestorId = ancestor.parentJobId;
  }
  // Chaîne plus longue que toute chaîne légitime : soit une corruption, soit
  // une fabrication (la route /api/agent accepte un parent arbitraire). Dans
  // les deux cas, indéterminable ⇒ fermé.
  return true;
}
