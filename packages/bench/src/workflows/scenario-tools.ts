// workflows/scenario-tools.ts — la liste FERMÉE des outils qu'un scénario laisse à l'équipe (décision 1B).
//
// Décision du propriétaire (18/10, « 1B ») : chaque scénario déclare les outils
// que l'équipe testée peut employer pendant ses essais. Un essai mesure Nodal
// sur une surface connue, et un scénario qui n'a pas besoin de commandes n'en a
// pas. C'est ce qui rend jouables, sans risque, les scénarios d'impression : le
// besoin `no-real-printer` (#855) n'est là que si aucun agent ne peut lancer
// de processus.
//
// LE MÉCANISME : la règle `block` du produit, outil par outil, agent par agent
// (`setApprovalRuleRepo` : la ligne de l'outil dans l'onglet Autonomie, le
// chemin de `blockedTools`). C'est le seul contrôle par outil que Nodal offre
// sur TOUS les outils d'un agent, quelle que soit leur origine : les outils
// toujours donnés (`ALWAYS_ON_TOOLS`, qu'aucune affectation ne retire), ceux des
// skills, des connecteurs, des serveurs MCP et de la délégation. Défaire une
// affectation de skill ou de connecteur ne fermerait ni les premiers ni les
// derniers, et changerait au passage la consigne du skill que le modèle lit.
// Un outil bloqué reste dans la liste que le job envoie au modèle, et son appel
// est REFUSÉ par l'exécution (`executeTool` : « blocked ») : il n'est pas
// disponible, et le dire coûte une ligne d'appel, jamais une action.
//
// AVANT CHAQUE ESSAI, la session (session.ts) pose un `block` sur chaque outil
// qu'un agent actif de l'espace tient et que la liste ne nomme pas, après
// avoir gardé la règle que l'agent avait sur cet outil ; APRÈS l'essai, quoi
// qu'il arrive, elle remet chacune de ces règles telle qu'elle était. Rien ne
// passe d'un essai à l'autre : la remise à zéro de la campagne compare ensuite
// l'équipe à sa configuration (`teamDrift`) et s'arrête sur tout `block` resté.
//
// Une entrée de la liste est un nom d'outil exact, ou un préfixe suivi de `*`
// (`xlsx_*`, `assign_*` pour les outils de délégation, dont les noms suivent
// l'équipe). Une entrée qui ne désigne aucun outil connu du produit est
// refusée, et `return_result` doit y être : il ne se bloque pas.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { nodalHomePath } from '@nodal-agents/shared/nodal-home';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { mcpToolPrefix } from '@nodal-agents/shared';
import { BENCH_PRINTER_SLUG, BENCH_PRINTER_TOOLS } from '../printer/identity';

// ─── Les familles, nommées une fois ──────────────────────────────────────────

/**
 * Ce que tout essai garde des outils toujours donnés : finir (`return_result`,
 * qui ne se bloque pas), demander (`ask_user` : le juge mesure qu'on n'a rien
 * demandé, le bloquer cacherait la question), lire un skill et le manuel de
 * Nodal, et la mémoire, que chaque job de Nodal consulte (la bloquer mesurerait
 * un Nodal amputé). Les autres outils toujours donnés sont bloqués là où aucun
 * scénario n'en a besoin : `list_models`, `list_schedules`, `dashboard_publish`
 * (une page publiée hors du dossier de travail), `web_search` (sauf `WEB`) et
 * `declare_verification` (un outil `process`, sauf `COMMANDS`).
 */
export const BASE = [
  'return_result',
  // La mécanique qui charge les outils différés du job : elle ne donne rien
  // qu'il n'ait déjà, et un outil bloqué reste bloqué une fois chargé.
  'load_tools',
  'ask_user',
  'skill_view',
  'nodal_docs',
  'save_memory',
  'query_memory',
  'search_history',
  'mark_memory_helpful',
  'mark_memory_outdated',
] as const;
/** Les fichiers du dossier de travail (toujours donnés), et ranger un projet. */
export const FILES = [
  'file_read',
  'file_write',
  'file_edit',
  'file_list',
  'file_search',
  'register_project',
] as const;
/** Confier à un coéquipier : les outils de délégation, dont les noms suivent l'équipe. */
export const TEAM = ['assign_*'] as const;
/** Chercher et lire le web : la recherche du produit et les connecteurs de lecture du Chercheur. */
export const WEB = ['web_search', 'tavily_*', 'firecrawl_*'] as const;
/** Lancer un processus : tout outil que le produit range `egress: 'process'`. */
export const COMMANDS = [
  'run_command',
  'run_skill_script',
  'code_task',
  'declare_verification',
] as const;
export const XLSX = ['xlsx_*'] as const;
export const DOCX = ['docx_*'] as const;
export const PPTX = ['pptx_*'] as const;
/** L'imprimante du banc (#794), sous le nom que le runner donne à ses outils. */
export const PRINTER = [`${mcpToolPrefix(BENCH_PRINTER_SLUG)}__*`] as const;

/** Une liste, à partir de familles et de noms. */
export function toolList(...parts: ReadonlyArray<readonly string[]>): readonly string[] {
  return [...new Set(parts.flat())];
}

// ─── Ce qu'une entrée désigne ────────────────────────────────────────────────

/** Une entrée désigne-t-elle cet outil ? Exacte, ou préfixe suivi de `*`. */
export function entryMatches(entry: string, toolName: string): boolean {
  return entry.endsWith('*') ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry;
}

/** La liste laisse-t-elle cet outil à l'équipe ? */
export function listAllows(list: readonly string[], toolName: string): boolean {
  return list.some((e) => entryMatches(e, toolName));
}

/**
 * Tous les noms d'outils que le produit sait servir : les outils de Nodal
 * (`servedToolDefinitions`, délégation comprise : `assign_teammate`), les
 * opérations des connecteurs du registre, et ceux de l'imprimante du banc.
 */
async function knownToolNames(): Promise<string[]> {
  const { servedToolDefinitions } = await import('@nodal-agents/orchestration');
  const { ADAPTER_REGISTRY } = await import('@nodal-agents/runner-adapters');
  return [
    ...servedToolDefinitions().map((t) => t.name),
    ...Object.values(ADAPTER_REGISTRY).flatMap((e) => e.operations.map((o) => o.slug)),
    ...BENCH_PRINTER_TOOLS.map((t) => `${mcpToolPrefix(BENCH_PRINTER_SLUG)}__${t}`),
  ];
}

/** La forme d'une liste : des entrées sans doublon, `return_result` compris. */
const ListShape = z
  .array(z.string().regex(/^[a-z][a-z0-9_]*\*?$/, 'a tool name, or a prefix followed by *'))
  .min(1)
  .refine((l) => new Set(l).size === l.length, 'an entry is listed twice')
  .refine((l) => l.includes('return_result'), 'return_result cannot be blocked: list it');

/**
 * La liste validée, ou une erreur qui nomme chaque entrée refusée : la forme,
 * puis une entrée qui ne désigne aucun outil connu du produit.
 */
export async function parseScenarioTools(scenario: string, list: unknown): Promise<string[]> {
  const shape = ListShape.safeParse(list);
  if (!shape.success)
    throw new Error(
      `scenario_tools_invalid: ${scenario}: ${shape.error.issues.map((i) => i.message).join('; ')}`,
    );
  const known = await knownToolNames();
  const unknown = shape.data.filter((e) => !known.some((n) => entryMatches(e, n)));
  if (unknown.length > 0)
    throw new Error(
      `scenario_tools_invalid: ${scenario}: no tool of the product is named ${unknown.join(', ')}`,
    );
  return shape.data;
}

/**
 * L'empreinte de la liste : douze caractères du SHA-256 de ses entrées
 * triées. Portée par chaque ligne de résultat (`scenarioToolsFingerprint`),
 * comme celle de la configuration : deux lignes ne se comparent qu'à surface
 * connue.
 */
export function scenarioToolsFingerprint(list: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...list].sort()))
    .digest('hex')
    .slice(0, 12);
}

// ─── Poser la liste avant un essai, la retirer après ─────────────────────────

/**
 * Le journal des règles que la liste remplace, dans l'état du banc (à côté de
 * son verrou, `bench/` du dossier de Nodal de la stack) : écrit AVANT la
 * première règle posée, effacé seulement après une remise réussie. Un banc tué
 * en plein essai le laisse ; la session suivante remet tout depuis lui avant
 * quoi que ce soit (`recoverScenarioTools`). Sans lui, une règle bornée à un
 * dossier que la liste avait remplacée serait perdue : l'écriture de la règle
 * réécrit sa condition (revue de #863, passe 1).
 */
export function scenarioToolsJournal(): string {
  return nodalHomePath('bench', 'scenario-tools.journal.json');
}

/** Un nom d'outil qui n'existe pas : il vise le palier `<serveur>__*` de la chaîne de règles. */
const ANY_TOOL_OF_SERVER = 'any_tool_the_list_does_not_name';

/**
 * Les outils qu'un job de l'agent recevrait vraiment : la liste du runner
 * (`resolveAgentToolNames`, @nodal-agents/orchestration, dont un test prouve
 * qu'elle égale celle d'`executeJob`), délégation, tâches (`create_task`,
 * `list_tasks`) et `load_tools` compris.
 */
export async function agentToolNames(db: AnyDrizzleDb, agentId: string): Promise<string[]> {
  const { resolveAgentToolNames } = await import('@nodal-agents/orchestration');
  return [...(await resolveAgentToolNames(db, agentId))].sort();
}

/**
 * Les préfixes d'outils des serveurs MCP actifs attribués à l'agent, que leurs
 * outils soient connus ou non : un serveur dont la liste d'outils est vide ou
 * périmée peut en offrir que personne n'a encore vus (le runner s'y connecte au
 * lancement du job). Une liste les ferme par le palier `<serveur>__*` de la
 * chaîne de règles, qui couvre aussi ces outils-là.
 */
async function heldMcpPrefixes(db: AnyDrizzleDb, agentId: string): Promise<string[]> {
  const d = await import('@nodal-agents/db');
  const rows = await db
    .select({ slug: d.mcpServers.slug, active: d.mcpServers.active })
    .from(d.agentMcpServers)
    .innerJoin(d.mcpServers, d.eq(d.mcpServers.id, d.agentMcpServers.mcpServerId))
    .where(d.eq(d.agentMcpServers.agentId, agentId));
  return [
    ...new Set(rows.filter((r) => r.active !== false).map((r) => mcpToolPrefix(r.slug))),
  ].sort();
}

/**
 * Comment la liste traite un serveur MCP : `open` (une entrée en ouvre tous
 * les outils, `<serveur>__*`), `close` (aucune entrée ne le nomme : son palier
 * est bloqué), ou `partial` (des outils nommés un à un : ses autres outils,
 * peut-être inconnus, ne se ferment pas sans fermer ceux-là ; refusé).
 */
function serverTreatment(list: readonly string[], prefix: string): 'open' | 'close' | 'partial' {
  if (listAllows(list, `${prefix}__${ANY_TOOL_OF_SERVER}`)) return 'open';
  return list.some((e) => e.startsWith(`${prefix}__`)) ? 'partial' : 'close';
}

type RuleAction = 'auto_approve' | 'require_approval' | 'block';

/** Une règle que la liste remplace : l'agent, l'outil (ou le palier d'un serveur), et ce qu'elle était. */
const ClosedSchema = z
  .object({
    agentId: z.string(),
    toolName: z.string(),
    before: z
      .object({
        action: z.enum(['auto_approve', 'require_approval', 'block']),
        conditionJson: z.record(z.string(), z.string()),
      })
      .strict()
      .nullable(),
  })
  .strict();
type Closed = z.infer<typeof ClosedSchema>;

const JournalSchema = z
  .object({ entityId: z.string(), scenario: z.string(), closed: z.array(ClosedSchema) })
  .strict();

export interface AppliedScenarioTools {
  /** Par agent (slug) : les outils, et les paliers `<serveur>__*`, que la liste a fermés. */
  readonly closed: Readonly<Record<string, readonly string[]>>;
  /** Remet chaque règle touchée telle qu'elle était, puis efface le journal. Idempotent. */
  restore(): Promise<void>;
}

/** Remet des règles telles qu'elles étaient (ou les retire), à rebours. */
async function putBack(
  db: AnyDrizzleDb,
  entityId: string,
  closed: readonly Closed[],
): Promise<void> {
  const d = await import('@nodal-agents/db');
  for (const c of [...closed].reverse()) {
    const r = await d.setApprovalRuleRepo(db, entityId, {
      agentId: c.agentId,
      toolName: c.toolName,
      action: c.before?.action ?? null,
      scope: 'agent',
      conditionJson: c.before?.conditionJson ?? {},
      confirmWidening: true,
    });
    if ('refused' in r)
      throw new Error(`scenario_tools_restore_refused: ${c.toolName}: ${r.refused}`);
  }
}

/**
 * Pose la liste du scénario sur l'espace : un `block` sur chaque outil qu'un
 * agent actif recevrait et qu'elle ne nomme pas, et sur le palier
 * `<serveur>__*` de chaque serveur MCP qu'elle ne nomme pas. Les règles
 * remplacées sont journalisées AVANT la première écriture. Vérifie ensuite,
 * par la règle de l'exécution (`matchApprovalRule`), que rien ne reste ouvert
 * hors liste ; sinon tout est remis et l'essai ne part pas.
 */
export async function applyScenarioTools(
  db: AnyDrizzleDb,
  entityId: string,
  scenario: string,
  rawList: readonly string[],
  journal: string = scenarioToolsJournal(),
): Promise<AppliedScenarioTools> {
  const list = await parseScenarioTools(scenario, rawList);
  if (existsSync(journal))
    throw new Error(
      `scenario_tools_journal_pending: ${journal} holds rules an earlier trial replaced; recover them first (recoverScenarioTools)`,
    );
  const d = await import('@nodal-agents/db');
  const agents = await db
    .select({ id: d.agents.id, slug: d.agents.slug, active: d.agents.active })
    .from(d.agents)
    .where(d.eq(d.agents.entityId, entityId))
    .orderBy(d.agents.slug);

  // 1. Ce que la liste ferme, et la règle que chaque fermeture remplace : lu, rien n'est écrit.
  const plan: Closed[] = [];
  const closed: Record<string, string[]> = {};
  for (const a of agents.filter((x) => x.active !== false)) {
    const targets: string[] = [];
    for (const prefix of await heldMcpPrefixes(db, a.id)) {
      const how = serverTreatment(list, prefix);
      if (how === 'partial')
        throw new Error(
          `scenario_tools_partial_mcp: ${scenario} names some tools of the MCP server ${prefix} one by one; its other tools, possibly unknown yet, cannot be closed without closing those: list ${prefix}__* or none`,
        );
      if (how === 'close') targets.push(`${prefix}__*`);
    }
    for (const t of await agentToolNames(db, a.id)) {
      // Un outil connu d'un serveur fermé par son palier a aussi sa propre règle :
      // une règle d'outil exacte (« sans demande ») l'emporte sur le palier.
      if (!listAllows(list, t)) targets.push(t);
    }
    for (const toolName of targets) {
      const [row] = await db
        .select({ action: d.approvalRules.action, conditionJson: d.approvalRules.conditionJson })
        .from(d.approvalRules)
        .where(
          d.and(
            d.eq(d.approvalRules.entityId, entityId),
            d.eq(d.approvalRules.agentId, a.id),
            d.eq(d.approvalRules.toolName, toolName),
          ),
        );
      plan.push({
        agentId: a.id,
        toolName,
        before: row
          ? {
              action: row.action as RuleAction,
              conditionJson: (row.conditionJson ?? {}) as Record<string, string>,
            }
          : null,
      });
    }
    closed[a.slug] = targets;
  }

  // 2. Le journal, avant la première règle écrite.
  mkdirSync(dirname(journal), { recursive: true });
  writeFileSync(journal, `${JSON.stringify({ entityId, scenario, closed: plan }, null, 1)}\n`);

  const written: Closed[] = [];
  const restore = async (): Promise<void> => {
    await putBack(db, entityId, written.splice(0));
    rmSync(journal, { force: true });
  };
  try {
    for (const c of plan) {
      written.push(c);
      const r = await d.setApprovalRuleRepo(db, entityId, {
        agentId: c.agentId,
        toolName: c.toolName,
        action: 'block',
        scope: 'agent',
        conditionJson: {},
      });
      if ('refused' in r) throw new Error(`scenario_tools_refused: ${c.toolName}: ${r.refused}`);
    }
    const open = await openOutsideList(db, entityId, list);
    if (open.length > 0)
      throw new Error(
        `scenario_tools_not_applied: ${scenario}: still open outside its list: ${open.join(', ')}`,
      );
  } catch (e) {
    await restore();
    throw e;
  }
  return { closed, restore };
}

/**
 * Au départ d'une session : un journal resté (un banc tué en plein essai) est
 * remis avant toute autre chose, puis effacé. Rend le scénario et le nombre de
 * règles remises, ou null sans journal. Un journal illisible arrête la session
 * en le nommant : jamais une règle du propriétaire perdue en silence.
 */
export async function recoverScenarioTools(
  db: AnyDrizzleDb,
  journal: string = scenarioToolsJournal(),
): Promise<{ scenario: string; rules: number } | null> {
  if (!existsSync(journal)) return null;
  let parsed: z.infer<typeof JournalSchema>;
  try {
    parsed = JournalSchema.parse(JSON.parse(readFileSync(journal, 'utf8')));
  } catch (e) {
    throw new Error(
      `scenario_tools_journal_unreadable: ${journal}: ${String(e instanceof Error ? e.message : e)}; the rules it holds must be put back by hand before the bench runs again`,
    );
  }
  await putBack(db, parsed.entityId, parsed.closed);
  rmSync(journal, { force: true });
  return { scenario: parsed.scenario, rules: parsed.closed.length };
}

/**
 * Ce qu'un agent actif peut encore appeler hors de la liste, lu comme
 * l'exécution le juge (`matchApprovalRule`) : `agent:outil`, et
 * `agent:serveur__*` pour un serveur MCP dont un outil inconnu passerait.
 * Vide : la liste tient.
 */
export async function openOutsideList(
  db: AnyDrizzleDb,
  entityId: string,
  list: readonly string[],
): Promise<string[]> {
  const d = await import('@nodal-agents/db');
  const { matchApprovalRule } = await import('@nodal-agents/tools');
  const rules = await db
    .select({
      id: d.approvalRules.id,
      entityId: d.approvalRules.entityId,
      agentId: d.approvalRules.agentId,
      toolName: d.approvalRules.toolName,
      action: d.approvalRules.action,
      conditionJson: d.approvalRules.conditionJson,
    })
    .from(d.approvalRules)
    .where(d.eq(d.approvalRules.entityId, entityId));
  const agents = await db
    .select({ id: d.agents.id, slug: d.agents.slug, active: d.agents.active })
    .from(d.agents)
    .where(d.eq(d.agents.entityId, entityId))
    .orderBy(d.agents.slug);
  const blocked = (t: string, agentId: string): boolean =>
    matchApprovalRule(rules as never, t, agentId, entityId)?.action === 'block';
  const out: string[] = [];
  for (const a of agents.filter((x) => x.active !== false)) {
    for (const t of await agentToolNames(db, a.id)) {
      if (!listAllows(list, t) && !blocked(t, a.id)) out.push(`${a.slug}:${t}`);
    }
    for (const prefix of await heldMcpPrefixes(db, a.id)) {
      const probe = `${prefix}__${ANY_TOOL_OF_SERVER}`;
      if (!listAllows(list, probe) && !blocked(probe, a.id)) out.push(`${a.slug}:${prefix}__*`);
    }
  }
  return out;
}
