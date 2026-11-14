// job/exchange-record.ts — ce que le runner écrit des outils d'un échange passé (#1075).
//
// LE DÉFAUT. Un échange redonné à un agent portait ses mots et pas ce que ses
// outils avaient fait. La seule trace structurelle, `[Actions performed in this
// exchange: …]`, n'était écrite que pour 21 noms d'outils intégrés tenus à la
// main (`STATE_CHANGING_TOOLS`) : un outil MCP, un outil de fichier,
// `run_command` ne laissaient rien. Un modèle rigoureux lisait alors son propre
// message plein de résultats précis, sans aucun appel avant lui, le prenait
// pour une invention, le désavouait devant la personne et refaisait le
// travail. Mesuré sur l'appel réel : avec les noms des outils ET les deux
// premières lignes du résultat de l'outil qui agit, le modèle retrouve son
// travail 5 fois sur 5, pour +193 jetons d'entrée (+0,5 %).
//
// LA RÈGLE, pour tout outil et sans liste tenue à la main :
//   [Actions performed in this exchange: tool_a, tool_b ×2, tool_c]
//   tool_b → <les deux premières lignes non vides de ce que l'appel a rendu>
// Chaque outil appelé est nommé. Chaque appel d'un outil qui n'est PAS DÉCLARÉ
// en lecture seule est cité (une ligne `nom → début`). « Déclaré » se lit sur
// la déclaration de l'outil et nulle part ailleurs : le `riskLevel` d'un outil
// du produit, le `risk` de l'opération d'un connecteur, le `readOnlyHint`
// d'un outil MCP. Un outil qui ne déclare rien, ou que plus rien ne connaît,
// agit : le relevé en montre plus, jamais moins.
//
// UN CONSTRUCTEUR, TROIS LECTEURS : le fil d'un canal et l'historique d'un job
// lancé depuis une conversation de chat (thread-history.ts), et l'historique
// du tour de chat lui-même, tableau de bord et appareils (run-chat-turn.ts).
// Le travail d'un job délégué suit la même règle, sous la même borne.
//
// BORNES DITES (invariant #4) : RESULT_HEAD_MAX_CHARS par citation, au plus
// MAX_QUOTED_RESULTS citations par échange, les DERNIÈRES ; celles qui
// tombent sont comptées sur une ligne.
//
// PRÉFIXE STABLE : le relevé d'un échange passé est le même, octet pour octet,
// d'un tour au suivant (cache de prompt). Il ne vient que de ce que le job a
// rangé et des déclarations, dans un ordre déterministe : un job terminé ne
// range plus rien, son relevé ne bouge plus. Celui d'un job encore en cours dit
// ce qu'il a fait jusque-là, comme son résultat ; ce qu'un tour sait d'un
// travail qui tourne est un autre sujet.
//
// UNE CITATION EST UNE DONNÉE. Les premiers caractères du résultat d'un outil
// web ou MCP peuvent être écrits par un tiers. La citation tient sur UNE ligne
// qui commence toujours par le nom de l'outil et la flèche : elle ne peut ni
// ouvrir une ligne du relevé à elle, ni se faire passer pour une entrée du
// runner. Le cadre de la plateforme est retiré, les secrets masqués
// (tool-acts.ts, `resultHead`).

import { eq, inArray } from '@nodal-agents/db';
import { agentJobs, mcpServers } from '@nodal-agents/db';
import { servedToolDefinitions } from '@nodal-agents/orchestration';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { mcpToolNamespace } from '@nodal-agents/shared';
import type { RunnerDeps } from '../deps.ts';
import {
  formatInlineDelegationEntry,
  formatTaskLedgerEntry,
  loadInlineDelegationLedger,
  loadTaskLedger,
  type InlineDelegationEntry,
  type TaskLedgerEntry,
} from './task-ledger.ts';
import { jobActs, resultHead, toolNames, type JobActs } from './tool-acts.ts';

/** Au plus ce nombre de résultats cités par échange : les derniers. */
export const MAX_QUOTED_RESULTS = 8;

/** Vrai quand l'outil de ce nom se DÉCLARE en lecture seule. */
export type DeclaredReadOnly = (toolName: string) => boolean;

/** Ce que le relevé d'un échange dit : le job de tête, et ce qu'il a délégué. */
export interface ExchangeFacts {
  own: JobActs;
  tasks: readonly TaskLedgerEntry[];
  inline: readonly InlineDelegationEntry[];
}

/**
 * Les lignes du relevé d'un échange : les outils du job de tête, puis chaque
 * délégation, chacune suivie des résultats cités de ses appels qui agissent.
 * Un échange sans aucun appel et sans délégation n'a aucune ligne.
 */
export function exchangeRecordLines(facts: ExchangeFacts, readOnly: DeclaredReadOnly): string[] {
  const ownNames = toolNames(facts.own);
  const sections: Array<{ header: string | null; acts: JobActs }> = [
    {
      header: ownNames === '' ? null : `[Actions performed in this exchange: ${ownNames}]`,
      acts: facts.own,
    },
    ...facts.tasks.map((t) => ({ header: formatTaskLedgerEntry(t), acts: t })),
    ...facts.inline.map((d) => ({ header: formatInlineDelegationEntry(d), acts: d })),
  ];
  const quoted = sections.map((s) =>
    s.acts.calls.filter((c) => !readOnly(c.name)).map((c) => `${c.name} → ${resultHead(c.output)}`),
  );
  const total = quoted.reduce((n, q) => n + q.length, 0);
  let skip = Math.max(0, total - MAX_QUOTED_RESULTS);
  const left = skip;
  const lines: string[] = [];
  sections.forEach((s, i) => {
    if (s.header !== null) lines.push(s.header);
    for (const line of quoted[i]!) {
      if (skip > 0) {
        skip -= 1;
        if (skip === 0) lines.push(`[${left} earlier tool results not quoted]`);
        continue;
      }
      lines.push(line);
    }
  });
  return lines;
}

/**
 * Les relevés d'une série d'échanges, par id de job : le job, ses délégations
 * terminées, et la déclaration de chaque outil dans l'espace du job. Un job
 * sans appel ni délégation n'a pas de relevé.
 */
export async function loadExchangeRecords(
  db: RunnerDeps['db'],
  jobIds: readonly (string | null)[],
): Promise<Map<string, string[]>> {
  const records = new Map<string, string[]>();
  const ids = [...new Set(jobIds.filter((id): id is string => !!id))];
  if (ids.length === 0) return records;
  const jobs = await db
    .select({
      id: agentJobs.id,
      entityId: agentJobs.entityId,
      task: agentJobs.task,
      messages: agentJobs.messages,
      toolsUsed: agentJobs.toolsUsed,
    })
    .from(agentJobs)
    .where(inArray(agentJobs.id, ids));
  const taskLedger = await loadTaskLedger(db, ids);
  const inlineLedger = await loadInlineDelegationLedger(db, ids);
  const declarations = new Map<string | null, DeclaredReadOnly>();
  for (const job of jobs) {
    let readOnly = declarations.get(job.entityId);
    if (!readOnly) {
      readOnly = await loadDeclaredReadOnly(db, job.entityId);
      declarations.set(job.entityId, readOnly);
    }
    const lines = exchangeRecordLines(
      {
        own: jobActs(job),
        tasks: taskLedger.get(job.id) ?? [],
        inline: inlineLedger.get(job.id) ?? [],
      },
      readOnly,
    );
    if (lines.length > 0) records.set(job.id, lines);
  }
  return records;
}

/**
 * La déclaration des outils que la plateforme sert sans base : ceux du
 * produit (`servedToolDefinitions`, le catalogue complet que lisent déjà le
 * test `egress` et le banc) et les opérations des connecteurs
 * (`ADAPTER_REGISTRY`, d'où chaque outil de connecteur tient son risque). Lue
 * une fois : ce sont des déclarations de code.
 */
let platformReadOnly: ReadonlySet<string> | null = null;
function platformDeclaredReadOnly(): ReadonlySet<string> {
  if (platformReadOnly) return platformReadOnly;
  const names = new Set<string>();
  for (const tool of servedToolDefinitions()) if (tool.riskLevel === 'read') names.add(tool.name);
  for (const adapter of Object.values(ADAPTER_REGISTRY)) {
    for (const op of adapter.operations) if (op.risk === 'read') names.add(op.slug);
  }
  platformReadOnly = names;
  return names;
}

/**
 * Qui se déclare en lecture seule dans l'espace `entityId` : les outils de la
 * plateforme, et les outils MCP de ses serveurs par leur `readOnlyHint`. Un
 * nom que plusieurs serveurs de l'espace prêtent n'est en lecture seule que si
 * TOUS le déclarent : le relevé en montre plus, jamais moins.
 *
 * Le `readOnlyHint` d'un serveur n'abaisse jamais la porte d'approbation
 * (adapter-mcp, MCP-001) ; ici il ne décide que de ce que le relevé cite.
 */
export async function loadDeclaredReadOnly(
  db: RunnerDeps['db'],
  entityId: string | null,
): Promise<DeclaredReadOnly> {
  const platform = platformDeclaredReadOnly();
  const mcp = new Map<string, boolean>();
  if (entityId) {
    const servers = await db
      .select({ slug: mcpServers.slug, availableTools: mcpServers.availableTools })
      .from(mcpServers)
      .where(eq(mcpServers.entityId, entityId));
    for (const server of servers) {
      const tools = Array.isArray(server.availableTools)
        ? (server.availableTools as unknown[])
        : [];
      for (const t of tools) {
        const tool = t as { name?: unknown; annotations?: { readOnlyHint?: unknown } | null };
        if (typeof tool?.name !== 'string') continue;
        const name = mcpToolNamespace(server.slug) + tool.name;
        const declared = tool.annotations?.readOnlyHint === true;
        mcp.set(name, (mcp.get(name) ?? true) && declared);
      }
    }
  }
  return (toolName) => mcp.get(toolName) ?? platform.has(toolName);
}
