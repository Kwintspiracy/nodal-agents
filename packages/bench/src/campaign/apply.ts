// campaign/apply.ts — appliquer la configuration du banc à l'instance neuve d'une campagne.
//
// Aucune route de Nodal ne crée d'agent : l'applicateur écrit par les MÊMES
// fonctions de base que le tableau de bord (@nodal-agents/db : créer un
// espace, une clé, un agent, attribuer un skill, un connecteur, un dossier,
// une règle d'accord, le préréglage lecture seule, les réglages de l'espace),
// et installe un skill communautaire par la route du runner que l'écran
// appelle. Jamais une ligne écrite à côté d'elles : un changement de l'écran
// atteint le banc, et ce que le banc mesure est ce qu'un utilisateur obtient.
//
// Il ne s'applique qu'à une instance NEUVE (aucun agent) : il crée, il ne
// fusionne pas. Ce qu'il ne peut pas faire, il le refuse en le nommant, avant
// ou pendant, jamais un espace à moitié réglé qui passerait pour le bon.
//
// Ce qu'il ne fait PAS, parce que l'instance neuve l'a déjà et que le banc le
// VÉRIFIE (team.ts) au lieu de l'écrire : les droits de la racine tous coupés
// (posés par `createAgentRepo` sur le premier orchestrateur), le frein
// d'urgence relâché, le bac à sable et la mémoire en mots-clés (les défauts
// d'une installation neuve, « on teste Nodal tel qu'il est livré »).

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { systemSkillSlugs } from '@nodal-agents/catalog';
import { COMMUNITY_SKILL_CATALOG } from '@nodal-agents/shared';
import type { CampaignAgent, CampaignConfig, CampaignFolder } from './config';
import type { CampaignKeys } from './keys';

/** Ce que l'applicateur a créé, et que le reste de la campagne vise. */
export interface AppliedCampaign {
  readonly userId: string;
  readonly tested: {
    readonly entityId: string;
    readonly rootAgentId: string;
    readonly rootAgentSlug: string;
  };
  readonly judge: { readonly entityId: string };
  /** Chaque agent de la configuration : son id et son espace. */
  readonly agents: Readonly<Record<string, { readonly id: string; readonly entityId: string }>>;
  /** Les dossiers posés pour les agents, et ce que le banc y remet avant chaque essai. */
  readonly folders: ReadonlyArray<{
    readonly agent: string;
    readonly label: string;
    readonly path: string;
    readonly seed: CampaignFolder['seed'];
  }>;
}

/** Installe un skill communautaire dans un espace (la route `/api/skills/install` du runner). */
export type CommunitySkillInstaller = (source: string, entityId: string) => Promise<void>;

export interface ApplyDeps {
  /** Le dossier sous lequel les dossiers de travail des agents sont posés. */
  readonly foldersRoot: string;
  readonly installCommunitySkill: CommunitySkillInstaller;
  readonly log?: (line: string) => void;
}

/**
 * La route du runner de l'instance qui installe un skill communautaire, avec
 * son secret : le chemin du bouton « Install » de l'écran des skills.
 */
export function runnerSkillInstaller(
  runnerPort: number,
  workerSecret: string,
  fetcher: typeof fetch = fetch,
): CommunitySkillInstaller {
  return async (source, entityId) => {
    const res = await fetcher(`http://127.0.0.1:${runnerPort}/api/skills/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${workerSecret}` },
      body: JSON.stringify({ source, entityId }),
    });
    const body = (await res.json().catch(() => null)) as
      | { ok: true }
      | { ok: false; error?: string; message?: string }
      | null;
    if (!res.ok || !body || body.ok !== true) {
      const why =
        body && body.ok === false
          ? `${body.error ?? 'error'}: ${body.message ?? ''}`
          : `HTTP ${res.status}`;
      throw new Error(`campaign_community_skill_failed: ${source}: ${why}`);
    }
  };
}

function fail(code: string, message: string): never {
  throw new Error(`${code}: ${message}`);
}

/** L'utilisateur de l'instance : en local-trust, l'unique que `up` a semé. */
async function instanceUser(db: AnyDrizzleDb): Promise<string> {
  const { users } = await import('@nodal-agents/db');
  const rows = await db.select({ id: users.id }).from(users).limit(2);
  if (rows.length !== 1) {
    fail(
      'campaign_instance_users',
      `the instance has ${rows.length} user(s); a fresh local-trust instance has exactly one`,
    );
  }
  return rows[0]!.id;
}

async function assertFresh(db: AnyDrizzleDb): Promise<void> {
  const { agents, count } = await import('@nodal-agents/db');
  const [row] = await db.select({ n: count() }).from(agents);
  if (Number(row?.n ?? 0) > 0) {
    fail(
      'campaign_instance_not_fresh',
      `the instance already has ${row!.n} agent(s); the applier creates a team, it never merges one`,
    );
  }
}

/** Les agents dans l'ordre où ils se créent : un orchestrateur après les coéquipiers qu'il reçoit. */
function creationOrder(agents: readonly CampaignAgent[]): CampaignAgent[] {
  return [...agents].sort(
    (a, b) => Number(a.role === 'orchestrator') - Number(b.role === 'orchestrator'),
  );
}

export async function applyCampaignConfig(
  db: AnyDrizzleDb,
  config: CampaignConfig,
  keys: CampaignKeys,
  deps: ApplyDeps,
): Promise<AppliedCampaign> {
  const d = await import('@nodal-agents/db');
  const log = deps.log ?? (() => undefined);
  if (config.agents.some((a) => a.printConnector !== null)) {
    // L'imprimante factice (#794) se construit en parallèle : celui qui fusionne
    // en second branche cet emplacement. D'ici là, il n'est jamais ignoré.
    fail(
      'campaign_print_connector_not_wired',
      'the configuration gives an agent a print connector, and the applier does not wire it yet (#794)',
    );
  }
  await assertFresh(db);
  const userId = await instanceUser(db);

  // 1. Les deux espaces, et leurs réglages.
  const entityOf: Record<'tested' | 'judge', string> = { tested: '', judge: '' };
  for (const which of ['tested', 'judge'] as const) {
    const ws = config.workspaces[which];
    const { id } = await d.createWorkspaceRepo(db, {
      userId,
      name: ws.name,
      ...(ws.icon ? { icon: ws.icon } : {}),
    });
    entityOf[which] = id;
    await d.setMcpServerEnabledRepo(db, id, ws.mcpServer);
    await d.setReflectionEnabledRepo(db, id, ws.reflection);
    await d.setRunBudgetRepo(db, id, { maxRunCostUsd: config.budget.perTrialUsd, maxRunHours: 0 });
    log(`workspace ${ws.name} (${which}) ${id}`);
  }

  // 2. La clé de chaque fournisseur de modèles, dans chaque espace qui l'emploie.
  const modelOf = (a: CampaignAgent) => config.models[a.workspace];
  const keyIds = new Map<string, string>();
  for (const which of ['tested', 'judge'] as const) {
    const providers = new Set(
      config.agents.filter((a) => a.workspace === which).map((a) => modelOf(a).provider),
    );
    for (const provider of providers) {
      const r = await d.createLlmKeyRepo(db, entityOf[which], {
        provider,
        apiKey: keys.providers[provider]!,
        nickname: 'Bench',
        isActive: true,
      });
      if ('error' in r)
        fail(
          'campaign_llm_key',
          `${provider} already has a key in ${config.workspaces[which].name}`,
        );
      keyIds.set(`${which}:${provider}`, r.id);
    }
  }

  // 3. Les agents, coéquipiers d'abord : un orchestrateur reçoit les siens, et
  // leur consigne de délégation, à sa création.
  const ids: Record<string, { id: string; entityId: string }> = {};
  for (const a of creationOrder(config.agents)) {
    const entityId = entityOf[a.workspace];
    const model = modelOf(a);
    const llmKeyId = keyIds.get(`${a.workspace}:${model.provider}`)!;
    if (a.role === 'orchestrator') {
      const toolsError = await d.orchestratorModelToolsError(db, entityId, llmKeyId, model.model);
      if (toolsError) fail('campaign_orchestrator_model', `${a.slug}: ${toolsError}`);
    }
    const subAgentIds = a.delegatesTo.map((t) => ids[t.agent]!.id);
    const created = await d.createAgentRepo(db, entityId, {
      slug: a.slug,
      name: a.name,
      personality: a.personality,
      model: model.model,
      llmKeyId,
      role: a.role === 'orchestrator' ? 'orchestrator' : 'agent',
      orchestratorMode: a.role === 'orchestrator' ? 'router' : null,
      avatarUrl: null,
      subAgentIds,
      subAgentInstructions: Object.fromEntries(
        a.delegatesTo.map((t) => [ids[t.agent]!.id, t.instructions]),
      ),
    });
    if ('error' in created)
      fail('campaign_agent_slug', `${a.slug} is taken in ${config.workspaces[a.workspace].name}`);
    ids[a.slug] = { id: created.id, entityId };
  }

  // La racine : le premier orchestrateur de l'espace, désigné par createAgentRepo.
  const rootSlug = config.workspaces.tested.rootAgent;
  const [ent] = await db
    .select({ rootAgentId: d.entities.rootAgentId })
    .from(d.entities)
    .where(d.eq(d.entities.id, entityOf.tested));
  if (ent?.rootAgentId !== ids[rootSlug]!.id) {
    fail(
      'campaign_root',
      `the root of ${config.workspaces.tested.name} is ${ent?.rootAgentId ?? 'none'}, not ${rootSlug}`,
    );
  }

  // 4. Skills, connecteurs, dossiers, règles d'accord : agent par agent.
  const connectorIds = new Map<string, string>();
  const folders: Array<AppliedCampaign['folders'][number]> = [];
  for (const a of config.agents) {
    const { id: agentId, entityId } = ids[a.slug]!;

    for (const slug of a.communitySkills) {
      const entry = COMMUNITY_SKILL_CATALOG.find((e) => e.slug === slug)!;
      await deps.installCommunitySkill(entry.source, entityId);
    }
    const wanted = [...a.skills, ...a.communitySkills];
    const bySlug = await d.resolveSkillIdsBySlug(db, entityId, wanted, systemSkillSlugs);
    const missing = wanted.filter((s) => !bySlug.has(s));
    if (missing.length > 0)
      fail('campaign_skill_missing', `${a.slug}: the instance has no skill ${missing.join(', ')}`);
    for (const slug of wanted) {
      const r = await d.assignSkillRepo(
        db,
        entityId,
        { skillId: bySlug.get(slug)!, agentId },
        systemSkillSlugs,
      );
      if ('error' in r) fail('campaign_skill_assign', `${a.slug} ← ${slug}: ${r.error}`);
    }

    for (const conn of a.connectors) {
      const key = `${entityId}:${conn.slug}`;
      let connectorId = connectorIds.get(key);
      if (!connectorId) {
        connectorId = (
          await d.createApiKeyConnectorRepo(db, entityId, {
            slug: conn.slug,
            name: `${conn.slug} (bench)`,
            apiKey: keys.connectors[conn.slug]!,
          })
        ).id;
        connectorIds.set(key, connectorId);
      }
      const r = await d.setAgentConnectorAssignmentRepo(db, entityId, {
        agentId,
        connectorId,
        assigned: true,
        enabledOperations: [...conn.operations],
      });
      if ('error' in r) fail('campaign_connector', `${a.slug} ← ${conn.slug}: ${r.error}`);
    }

    for (const [i, f] of a.folders.entries()) {
      const path = join(deps.foldersRoot, `${a.slug}-${i + 1}`);
      mkdirSync(path, { recursive: true });
      const r = await d.addAgentWorkspaceRepo(db, entityId, { agentId, label: f.label, path });
      if ('error' in r) fail('campaign_folder', `${a.slug} ← ${f.label}: ${r.error}`);
      folders.push({ agent: a.slug, label: f.label, path, seed: f.seed });
    }

    if (a.runCommand !== null) {
      const r = await d.setRunCommandRuleRepo(db, entityId, agentId, a.runCommand);
      if ('refused' in r) fail('campaign_run_command_rule', `${a.slug}: ${r.refused}`);
    }
    if (a.readOnly) await d.setReadOnlyPresetRepo(db, entityId, agentId, true);
    log(`agent ${a.slug} ${agentId}`);
  }

  return {
    userId,
    tested: { entityId: entityOf.tested, rootAgentId: ids[rootSlug]!.id, rootAgentSlug: rootSlug },
    judge: { entityId: entityOf.judge },
    agents: ids,
    folders,
  };
}
