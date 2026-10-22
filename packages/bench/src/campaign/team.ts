// campaign/team.ts — l'équipe de l'instance telle que NODAL la voit, et son écart à la configuration.
//
// Chaque fait est lu par un lecteur du produit, pas recalculé ici : les outils
// d'un agent (`computeAgentToolOrigins`, la règle du runner), son bloc
// d'équipe (`buildTeamBlock`, le texte que le modèle reçoit, consignes de
// délégation comprises), la règle d'accord qui gagne pour un outil
// (`matchApprovalRule`, celle de l'exécution), ses liaisons de canal
// (`listChannelBindings`), les méta-outils de la racine (`metaToolsForAgent`).
// Un écart entre ce qu'ils disent et la configuration est nommé, champ par
// champ : c'est le contrôle d'après application, et celui d'avant chaque essai.

import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { AgentId, EntityId } from '@nodal-agents/orchestration';
import { metaToolsForAgent, parseRootGrants } from '@nodal-agents/shared';
import type { AppliedCampaign } from './apply';
import type { CampaignConfig } from './config';

export interface AgentView {
  readonly slug: string;
  readonly name: string;
  readonly entityId: string;
  readonly personality: string;
  readonly model: string | null;
  /** Le fournisseur de la clé primaire de l'agent ; null sans clé. */
  readonly provider: string | null;
  readonly role: string | null;
  readonly active: boolean;
  readonly runtime: string;
  readonly hasTelegramToken: boolean;
  /** Les skills attribués (les skills de base, injectés d'office, n'y sont pas). */
  readonly skills: string[];
  /** Les outils qu'un job de l'agent recevrait. */
  readonly tools: string[];
  /** Ceux qui atteignent l'extérieur de Nodal, et par quoi. */
  readonly outbound: Array<{ tool: string; origin: string; via: string }>;
  readonly connectors: Array<{ slug: string; operations: string[] | null }>;
  readonly folders: Array<{ label: string; path: string }>;
  /** Les coéquipiers, et la consigne affichée pour chacun (`agent_assignments`). */
  readonly team: Array<{ slug: string; instructions: string | null }>;
  /** Le bloc d'équipe du prompt, tel que le runner le construit. */
  readonly teamBlock: string;
  /** Les outils de délégation que le runner lui génère (`generateAssignTools`). */
  readonly delegationTools: string[];
  readonly channelBindings: number;
}

export interface WorkspaceView {
  readonly entityId: string;
  readonly name: string;
  readonly rootAgentId: string | null;
  /** Les méta-outils que la racine reçoit (créer un agent, un skill, un connecteur…). */
  readonly rootMetaTools: string[];
  readonly mcpServerEnabled: boolean;
  readonly reflectionEnabled: boolean;
  readonly autoRunPaused: boolean;
  readonly agents: AgentView[];
}

/** Ce qu'un espace de l'instance est, lu par les lecteurs du produit. */
export async function readWorkspaceView(
  db: AnyDrizzleDb,
  entityId: string,
): Promise<WorkspaceView> {
  const d = await import('@nodal-agents/db');
  const { computeAgentToolOrigins, buildTeamBlock, generateAssignTools } =
    await import('@nodal-agents/orchestration');
  const [ent] = await db
    .select({
      name: d.entities.name,
      rootAgentId: d.entities.rootAgentId,
      rootGrants: d.entities.rootGrants,
      mcpServerEnabled: d.entities.mcpServerEnabled,
      reflectionEnabled: d.entities.reflectionEnabled,
      autoRunPaused: d.entities.autoRunPaused,
    })
    .from(d.entities)
    .where(d.eq(d.entities.id, entityId));
  if (!ent) throw new Error(`campaign_workspace_missing: ${entityId}`);

  const rows = await db
    .select()
    .from(d.agents)
    .where(d.eq(d.agents.entityId, entityId))
    .orderBy(d.agents.slug);
  const slugOf = new Map(rows.map((r) => [r.id, r.slug]));
  const agents: AgentView[] = [];
  let rootMetaTools: string[] = [];
  for (const a of rows) {
    const [key] = a.llmKeyId
      ? await db
          .select({ provider: d.entityLlmKeys.provider })
          .from(d.entityLlmKeys)
          .where(d.eq(d.entityLlmKeys.id, a.llmKeyId))
      : [];
    const skills = await db
      .select({ slug: d.agentSkills.slug })
      .from(d.agentSkillAssignments)
      .innerJoin(d.agentSkills, d.eq(d.agentSkills.id, d.agentSkillAssignments.skillId))
      .where(d.eq(d.agentSkillAssignments.agentId, a.id));
    const { names, outbound } = await computeAgentToolOrigins(
      a.id as AgentId,
      entityId as EntityId,
      db,
      { hasDeliveryRecipient: true },
    );
    const connectors = await db
      .select({
        slug: d.connectors.slug,
        operations: d.agentConnectorAssignments.enabledOperations,
      })
      .from(d.agentConnectorAssignments)
      .innerJoin(d.connectors, d.eq(d.connectors.id, d.agentConnectorAssignments.connectorId))
      .where(d.eq(d.agentConnectorAssignments.agentId, a.id));
    const folders = await db
      .select({ label: d.agentWorkspaces.label, path: d.agentWorkspaces.path })
      .from(d.agentWorkspaces)
      .where(d.eq(d.agentWorkspaces.agentId, a.id));
    const team = await db
      .select({ sub: d.agentAssignments.subAgentId, instructions: d.agentAssignments.instructions })
      .from(d.agentAssignments)
      .where(d.eq(d.agentAssignments.orchestratorId, a.id));
    const bindings = await d.listChannelBindings(db, a.id);
    if (a.id === ent.rootAgentId) {
      rootMetaTools = metaToolsForAgent(parseRootGrants(ent.rootGrants), {
        mayChangeTeam: a.mayChangeTeam ?? false,
      });
    }
    agents.push({
      slug: a.slug,
      name: a.name,
      entityId,
      personality: a.personality,
      model: a.model,
      provider: key?.provider ?? null,
      role: a.role,
      active: a.active !== false,
      runtime: a.runtime,
      hasTelegramToken: Boolean(a.telegramBotToken),
      skills: skills.map((s) => s.slug).sort(),
      tools: [...names].sort(),
      outbound: outbound
        .map((o) => ({ tool: o.tool, origin: o.origin, via: o.via }))
        .sort((x, y) => x.tool.localeCompare(y.tool)),
      connectors: connectors
        .map((c) => ({ slug: c.slug, operations: c.operations ? [...c.operations].sort() : null }))
        .sort((x, y) => x.slug.localeCompare(y.slug)),
      folders: folders.sort((x, y) => x.label.localeCompare(y.label)),
      team: team
        .map((t) => ({
          slug: slugOf.get(t.sub) ?? `(outside the workspace: ${t.sub})`,
          instructions: t.instructions,
        }))
        .sort((x, y) => x.slug.localeCompare(y.slug)),
      teamBlock: await buildTeamBlock(a.id as AgentId, db),
      delegationTools: (await generateAssignTools(a.id as AgentId, db)).map((t) => t.name).sort(),
      channelBindings: bindings.length,
    });
  }
  return {
    entityId,
    name: ent.name,
    rootAgentId: ent.rootAgentId,
    rootMetaTools,
    mcpServerEnabled: ent.mcpServerEnabled,
    reflectionEnabled: ent.reflectionEnabled,
    autoRunPaused: ent.autoRunPaused,
    agents,
  };
}

/** La règle d'accord qui décide d'un outil pour un agent, lue par l'exécution elle-même. */
export async function winningApproval(
  db: AnyDrizzleDb,
  entityId: string,
  agentId: string,
  toolName: string,
): Promise<string | null> {
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
  return matchApprovalRule(rules as never, toolName, agentId, entityId)?.action ?? null;
}

/**
 * Ce qui, dans l'instance, s'écarte de la configuration : une ligne par écart,
 * vide quand l'équipe est exactement celle de la page. Les deux espaces sont
 * lus en entier : un agent de plus est un écart, pas un détail.
 */
export async function teamDrift(
  db: AnyDrizzleDb,
  config: CampaignConfig,
  applied: AppliedCampaign,
): Promise<string[]> {
  const out: string[] = [];
  const { READONLY_PRESET_TOOLS } = await import('@nodal-agents/db');
  for (const which of ['tested', 'judge'] as const) {
    const entityId = applied[which].entityId;
    const ws = await readWorkspaceView(db, entityId);
    const cfgWs = config.workspaces[which];
    const where = `${cfgWs.name}:`;
    if (ws.mcpServerEnabled !== cfgWs.mcpServer)
      out.push(`${where} MCP server ${ws.mcpServerEnabled ? 'on' : 'off'}`);
    if (ws.reflectionEnabled !== cfgWs.reflection)
      out.push(`${where} reflection ${ws.reflectionEnabled ? 'on' : 'off'}`);
    if (ws.autoRunPaused) out.push(`${where} the emergency brake is pulled`);
    if (ws.rootMetaTools.length > 0)
      out.push(`${where} the root holds meta-tools ${ws.rootMetaTools.join(', ')}`);
    if (which === 'tested' && ws.rootAgentId !== applied.tested.rootAgentId) {
      out.push(
        `${where} the root is ${ws.rootAgentId ?? 'none'}, not ${config.workspaces.tested.rootAgent}`,
      );
    }

    const wanted = config.agents.filter((a) => a.workspace === which);
    const extra = ws.agents
      .filter((v) => !wanted.some((a) => a.slug === v.slug))
      .map((v) => v.slug);
    if (extra.length > 0)
      out.push(`${where} agents the configuration does not name: ${extra.join(', ')}`);
    for (const a of wanted) {
      const v = ws.agents.find((x) => x.slug === a.slug);
      const at = `${where}${a.slug}`;
      if (!v) {
        out.push(`${at} is missing`);
        continue;
      }
      const model = config.models[which];
      const eq = (field: string, got: unknown, want: unknown): void => {
        if (JSON.stringify(got) !== JSON.stringify(want)) {
          out.push(`${at} ${field} is ${JSON.stringify(got)}, not ${JSON.stringify(want)}`);
        }
      };
      eq('name', v.name, a.name);
      eq('personality', v.personality, a.personality);
      eq('model', `${v.provider}:${v.model}`, `${model.provider}:${model.model}`);
      eq('role', v.role, a.role === 'orchestrator' ? 'orchestrator' : 'agent');
      eq('active', v.active, true);
      eq('runtime', v.runtime, 'nodal');
      eq('telegram token', v.hasTelegramToken, false);
      eq('channel bindings', v.channelBindings, 0);
      eq('skills', v.skills, [...a.skills, ...a.communitySkills].sort());
      eq(
        'connectors',
        v.connectors,
        a.connectors
          .map((c) => ({ slug: c.slug, operations: [...c.operations].sort() }))
          .sort((x, y) => x.slug.localeCompare(y.slug)),
      );
      eq(
        'folders',
        v.folders.map((f) => f.label),
        a.folders.map((f) => f.label).sort((x, y) => x.localeCompare(y)),
      );
      eq(
        'team',
        v.team,
        a.delegatesTo
          .map((t) => ({ slug: t.agent, instructions: t.instructions }))
          .sort((x, y) => x.slug.localeCompare(y.slug)),
      );
      eq(
        'delegation tools',
        v.delegationTools,
        a.delegatesTo.map((t) => `assign_${t.agent.replace(/-/g, '_')}`).sort(),
      );
      const agentId = applied.agents[a.slug]!.id;
      const runCommand = await winningApproval(db, entityId, agentId, 'run_command');
      eq('run_command rule', runCommand, a.readOnly ? 'block' : a.runCommand);
      if (a.readOnly) {
        for (const tool of READONLY_PRESET_TOOLS) {
          eq(`${tool} rule`, await winningApproval(db, entityId, agentId, tool), 'block');
        }
      }
    }
  }
  return out;
}
