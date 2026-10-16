// space/sync.ts — `pnpm bench:space sync` : copier l'équipe du propriétaire dans
// l'espace du banc, à l'identique, sans rien de ce qui parle au monde.
//
// CE QUI EST COPIÉ, depuis la base et rien d'autre (invariant #1) : les agents
// (prompts, modèles, runtimes, réglages), les skills de l'espace et leurs
// fichiers, l'attribution des skills aux agents (d'où vient la liste d'outils
// de chaque job), les liens de délégation, l'agent racine et ses droits, les
// règles d'approbation, les notes d'installation du bloc Runtime, et les clés
// LLM que ces agents utilisent.
//
// CE QUI NE L'EST PAS, tant que des comptes de test n'existent pas : aucun
// jeton de canal (le jeton Telegram vit sur la ligne agent : il est effacé),
// aucune liaison Discord/Slack/WhatsApp, aucun connecteur (un connecteur de
// messagerie lit ET envoie : la plateforme ne sait pas les distinguer, donc
// aucun ne passe), aucun serveur MCP, aucun dossier de travail du propriétaire
// (ce sont ses vrais répertoires), aucune planification, aucun webhook, aucune
// mémoire. Le plan les nomme un par un : un écart de fidélité se lit, il ne se
// découvre pas pendant un essai.
//
// LES SECRETS. Une clé LLM est stockée chiffrée (`enc:v1:…`) avec la clé
// maîtresse de l'installation (~/.nodalai/secrets.key, @nodal-agents/secrets).
// Le chiffré ne dépend pas de l'entité : la copie recopie le CHIFFRÉ tel quel,
// sans jamais le déchiffrer, et le plan ne l'imprime pas (ni lui, ni ses
// quatre derniers caractères) — seulement le fournisseur et le surnom.
//
// L'ESPACE SE RÈGLE LUI-MÊME sur trois points : la réflexion est COUPÉE (le
// banc mesure une équipe, il ne la fait pas apprendre), le coût d'un run est
// plafonné, et le serveur MCP de l'espace est ouvert (c'est par `run_task` que
// le banc le pilotera ; il n'est servi qu'à un client qui épingle un de ses
// agents).
//
// TOUTE COLONNE EST CLASSÉE. Chaque table copiée a sa politique colonne par
// colonne ; un test exige que la politique couvre exactement les colonnes du
// schéma. Une colonne ajoutée demain (un nouveau jeton, par exemple) fait
// rougir ce test au lieu d'être copiée en silence.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import {
  BENCH_SPACE_NAME,
  BENCH_SPACE_SLUG,
  DEFAULT_SPACE_MAX_RUN_COST_USD,
  assertSpaceIdle,
  copyIdFor,
  findBenchSpace,
  spaceIdFor,
} from './space';

// ─── Politique des colonnes ──────────────────────────────────────────────────

/**
 * - `copy` : la valeur de la source, telle quelle ;
 * - `map` : un identifiant réécrit vers la copie (ou fourni par l'espace) ;
 * - `set` : une valeur que l'espace impose (réflexion, plafond, nom) ;
 * - `clear` : un secret de canal, jamais copié (NULL) ;
 * - `own` : propre à l'espace (horodatages, jeton MCP), ni copié ni comparé.
 */
export type ColumnPolicy = 'copy' | 'map' | 'set' | 'clear' | 'own';

export const ENTITY_POLICY = {
  id: 'map',
  userId: 'map',
  name: 'set',
  slug: 'set',
  description: 'copy',
  icon: 'copy',
  industry: 'copy',
  goal: 'copy',
  timezone: 'copy',
  mcpToken: 'own',
  rootAgentId: 'map',
  rootGrants: 'copy',
  createdAt: 'own',
  updatedAt: 'own',
  lastCuratorRunAt: 'own',
  reflectionEnabled: 'set',
  skillAssignmentMode: 'copy',
  autoRunPaused: 'copy',
  mcpServerEnabled: 'set',
  verificationSurfaces: 'copy',
  proofRepairAttempts: 'copy',
  maxRunCostUsd: 'set',
  maxRunHours: 'copy',
} as const satisfies Record<string, ColumnPolicy>;

export const AGENT_POLICY = {
  id: 'map',
  entityId: 'map',
  name: 'copy',
  slug: 'copy',
  personality: 'copy',
  model: 'copy',
  reasoningEffort: 'copy',
  llmKeyId: 'map',
  fallbackChain: 'map',
  active: 'copy',
  isDefault: 'copy',
  role: 'copy',
  orchestratorMode: 'copy',
  telegramBotToken: 'clear',
  telegramBotUsername: 'clear',
  telegramOffset: 'clear',
  lastSeenChatIdTelegram: 'clear',
  capabilities: 'copy',
  taskContextTemplate: 'copy',
  avatarUrl: 'copy',
  systemAgent: 'copy',
  idleTimeoutSeconds: 'copy',
  memoryTokenBudget: 'copy',
  reflectionEnabled: 'copy',
  budgetDailyUsd: 'copy',
  budgetMonthlyUsd: 'copy',
  budgetAlertPct: 'copy',
  shellPolicy: 'copy',
  cliDefaults: 'copy',
  runtime: 'copy',
  cliPermissions: 'copy',
  commandAllowlist: 'copy',
  mayChangeTeam: 'copy',
  position: 'copy',
  createdAt: 'own',
  updatedAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const SKILL_POLICY = {
  id: 'map',
  entityId: 'map',
  name: 'copy',
  slug: 'copy',
  content: 'copy',
  active: 'copy',
  description: 'copy',
  defaultContent: 'copy',
  contentOverridden: 'copy',
  requiredConfig: 'copy',
  operations: 'copy',
  requiredBuiltins: 'copy',
  isCommunity: 'copy',
  source: 'copy',
  installedScripts: 'copy',
  updateAvailable: 'copy',
  updateDetail: 'copy',
  lastUpdateCheckAt: 'copy',
  createdBy: 'copy',
  createdByAgentId: 'map',
  state: 'copy',
  lastUsedAt: 'copy',
  patchCount: 'copy',
  archivedAt: 'copy',
  createdAt: 'own',
  updatedAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const SKILL_ASSIGNMENT_POLICY = {
  id: 'map',
  entityId: 'map',
  agentId: 'map',
  skillId: 'map',
  useCustomInstructions: 'copy',
  enabledOperations: 'copy',
  scriptsAuthorized: 'copy',
  filesWritable: 'copy',
  createdAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const DELEGATION_POLICY = {
  id: 'map',
  orchestratorId: 'map',
  subAgentId: 'map',
  entityId: 'map',
  instructions: 'copy',
  createdAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const APPROVAL_RULE_POLICY = {
  id: 'map',
  entityId: 'map',
  agentId: 'map',
  toolName: 'copy',
  action: 'copy',
  conditionJson: 'copy',
  createdAt: 'own',
  updatedAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const LLM_KEY_POLICY = {
  id: 'map',
  entityId: 'map',
  provider: 'copy',
  // Le CHIFFRÉ, jamais déchiffré : la clé maîtresse est celle de l'installation.
  apiKey: 'copy',
  apiKeyLast4: 'copy',
  baseUrl: 'copy',
  nickname: 'copy',
  contextWindow: 'copy',
  isActive: 'copy',
  createdAt: 'own',
  updatedAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

export const ENTITY_SETTING_POLICY = {
  entityId: 'map',
  key: 'copy',
  value: 'copy',
  updatedAt: 'own',
} as const satisfies Record<string, ColumnPolicy>;

/** Colonnes qui ne se lisent jamais dans un plan : le contenu d'un secret. */
const SECRET_COLUMNS = new Set(['apiKey', 'apiKeyLast4']);

type Row = Record<string, unknown>;

/**
 * La ligne de l'espace : chaque colonne non `own` reçoit une valeur explicite.
 * `fixed` porte les colonnes `map` et `set` ; en manquer une est une erreur.
 */
function project(policy: Record<string, ColumnPolicy>, source: Row, fixed: Row): Row {
  const out: Row = {};
  for (const [col, p] of Object.entries(policy)) {
    if (p === 'own') continue;
    if (p === 'copy') out[col] = source[col] ?? null;
    else if (p === 'clear') out[col] = null;
    else {
      if (!(col in fixed)) throw new Error(`bench_space_internal: no value for ${p} column ${col}`);
      out[col] = fixed[col];
    }
  }
  return out;
}

function same(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : (v ?? null));
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

function changedColumns(policy: Record<string, ColumnPolicy>, want: Row, have: Row): string[] {
  return Object.keys(want).filter((c) => policy[c] !== 'own' && !same(want[c], have[c]));
}

// ─── Le plan ─────────────────────────────────────────────────────────────────

export type ChangeKind = 'create' | 'update' | 'delete';

export interface PlannedChange {
  table: string;
  kind: ChangeKind;
  /** Ce qu'on montre : un slug, un nom, jamais un secret. */
  label: string;
  /** Pour une mise à jour : les colonnes qui changent (jamais leur valeur). */
  columns?: string[];
}

export interface PlannedFiles {
  skillSlug: string;
  kind: ChangeKind;
  files: number;
}

export interface SyncPlan {
  source: { id: string; name: string };
  space: { id: string; exists: boolean };
  maxRunCostUsd: number;
  changes: PlannedChange[];
  files: PlannedFiles[];
  /** Ce qui reste chez le propriétaire, nommé un par un. */
  notCopied: string[];
  /** Les skills système, référencées (pas copiées) : elles vivent une fois par installation. */
  referencedSystemSkills: string[];
}

interface Desired {
  entity: Row;
  tables: Array<{ name: string; policy: Record<string, ColumnPolicy>; rows: Row[] }>;
  settings: Row[];
  skillDirs: Array<{ slug: string; from: string; to: string }>;
  staleSkillDirs: string[];
}

export interface SyncOptions {
  /** L'espace copié ; défaut : l'unique espace d'une personne qui a un agent racine. */
  sourceEntityId?: string;
  maxRunCostUsd?: number;
  /** La racine des espaces de travail (`workspacesRoot()` de @nodal-agents/tools). */
  workspacesRoot: string;
}

/** Les clés de `entity_settings` qui sont du prompt (le bloc Runtime), donc copiées. */
async function promptSettingKeys(): Promise<string[]> {
  const { INSTALL_NOTES_KEY } = await import('@nodal-agents/db');
  return [INSTALL_NOTES_KEY];
}

async function resolveSource(db: AnyDrizzleDb, explicit: string | undefined): Promise<string> {
  if (explicit) return explicit;
  const { listMemberWorkspaces } = await import('@nodal-agents/db');
  const rows = await listMemberWorkspaces(db, { withRootAgent: true });
  if (rows.length !== 1) {
    throw new Error(
      `bench_space_source: ${rows.length} workspace(s) you are a member of have a root agent ` +
        `(${rows.map((r) => r.name).join(', ') || 'none'}); pass --source <entityId> to name the team to copy`,
    );
  }
  return rows[0]!.id;
}

/** Arbre de fichiers d'un dossier : chemin relatif → empreinte. Vide si absent. */
function treeDigest(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!existsSync(dir)) return out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile())
        out.set(
          relative(dir, p).split('\\').join('/'),
          createHash('sha256').update(readFileSync(p)).digest('hex'),
        );
    }
  };
  walk(dir);
  return out;
}

function sameTree(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, v] of a) if (b.get(k) !== v) return false;
  return true;
}

/**
 * Lit la source et l'espace, et calcule ce qu'une synchronisation écrirait.
 * N'écrit RIEN — c'est le `--dry-run`, et la première moitié de `--apply`.
 */
export async function planSync(
  db: AnyDrizzleDb,
  opts: SyncOptions,
): Promise<{ plan: SyncPlan; desired: Desired }> {
  const d = await import('@nodal-agents/db');
  const sourceId = await resolveSource(db, opts.sourceEntityId);
  const cap = opts.maxRunCostUsd ?? DEFAULT_SPACE_MAX_RUN_COST_USD;
  if (!(cap > 0 && cap <= 1000)) {
    throw new Error(
      `bench_space_cost_cap: --max-run-cost-usd must be above 0 and at most 1000 (got ${cap}); ` +
        'a bench space without a cap is what this setting exists to prevent',
    );
  }

  const [src] = await db.select().from(d.entities).where(d.eq(d.entities.id, sourceId)).limit(1);
  if (!src) throw new Error(`bench_space_source: no workspace with id ${sourceId}`);
  if (src.slug === BENCH_SPACE_SLUG) {
    throw new Error('bench_space_source: the bench space cannot be its own source');
  }

  const spaceId = spaceIdFor(src.id);
  const existing = await findBenchSpace(db);
  if (existing && existing.id !== spaceId) {
    throw new Error(
      `bench_space_foreign: a workspace "${BENCH_SPACE_SLUG}" exists (${existing.id}) but was not ` +
        `copied from ${src.name} (${src.id}); it is left untouched. Remove it by hand if it is stale.`,
    );
  }
  if (existing) await assertSpaceIdle(db, spaceId);
  const id = (table: string, sourceRowId: string) => copyIdFor(spaceId, table, sourceRowId);

  // ── La source ──
  const srcAgents = await db.select().from(d.agents).where(d.eq(d.agents.entityId, src.id));
  const agentIds = new Set(srcAgents.map((a) => a.id));
  const mapAgent = (agentId: string | null, what: string): string | null => {
    if (agentId === null) return null;
    if (!agentIds.has(agentId)) {
      throw new Error(
        `bench_space_foreign_ref: ${what} points to agent ${agentId}, outside ${src.name}`,
      );
    }
    return id('agents', agentId);
  };

  const srcSkills = await db
    .select()
    .from(d.agentSkills)
    .where(d.eq(d.agentSkills.entityId, src.id));
  // Une skill système vit une fois par installation (seed-default-skills) et
  // s'attribue depuis n'importe quel espace : on la RÉFÉRENCE, on ne la copie pas.
  const copiedSkills = srcSkills.filter((s) => s.createdBy !== 'system');
  const copiedSkillIds = new Set(copiedSkills.map((s) => s.id));

  const agentIdList = [...agentIds];
  const srcAssignments =
    agentIdList.length === 0
      ? []
      : await db
          .select()
          .from(d.agentSkillAssignments)
          .where(d.inArray(d.agentSkillAssignments.agentId, agentIdList));
  const assignedSkillIds = [...new Set(srcAssignments.map((a) => a.skillId))];
  const assignedSkills =
    assignedSkillIds.length === 0
      ? []
      : await db
          .select({
            id: d.agentSkills.id,
            slug: d.agentSkills.slug,
            entityId: d.agentSkills.entityId,
            createdBy: d.agentSkills.createdBy,
          })
          .from(d.agentSkills)
          .where(d.inArray(d.agentSkills.id, assignedSkillIds));
  const skillById = new Map(assignedSkills.map((s) => [s.id, s]));
  const referencedSystemSkills = new Set<string>();
  const mapSkill = (skillId: string): string => {
    if (copiedSkillIds.has(skillId)) return id('agent_skills', skillId);
    const s = skillById.get(skillId);
    if (s && (s.createdBy === 'system' || s.entityId === null)) {
      referencedSystemSkills.add(s.slug);
      return s.id;
    }
    throw new Error(
      `bench_space_foreign_ref: a skill assignment of ${src.name} points to skill ${skillId}, ` +
        'which is neither one of its skills nor a system skill',
    );
  };

  const srcLinks = await db
    .select()
    .from(d.agentAssignments)
    .where(d.eq(d.agentAssignments.entityId, src.id));
  const srcRules = await db
    .select()
    .from(d.approvalRules)
    .where(d.eq(d.approvalRules.entityId, src.id));
  const srcKeys = await db
    .select()
    .from(d.entityLlmKeys)
    .where(d.eq(d.entityLlmKeys.entityId, src.id));
  const keyIds = new Set(srcKeys.map((k) => k.id));
  const usedKeyIds = new Set<string>();
  const mapKey = (keyId: string | null, what: string): string | null => {
    if (keyId === null) return null;
    if (!keyIds.has(keyId)) {
      throw new Error(
        `bench_space_foreign_ref: ${what} uses LLM key ${keyId}, outside ${src.name}`,
      );
    }
    usedKeyIds.add(keyId);
    return id('entity_llm_keys', keyId);
  };

  // ── Ce que l'espace doit contenir ──
  const rootAgentId = src.rootAgentId === null ? null : mapAgent(src.rootAgentId, 'the root agent');
  const entity = project(ENTITY_POLICY, src as Row, {
    id: spaceId,
    userId: src.userId,
    name: BENCH_SPACE_NAME,
    slug: BENCH_SPACE_SLUG,
    rootAgentId,
    reflectionEnabled: false,
    mcpServerEnabled: true,
    maxRunCostUsd: cap,
  });

  const agentRows = srcAgents.map((a) =>
    project(AGENT_POLICY, a as Row, {
      id: id('agents', a.id),
      entityId: spaceId,
      llmKeyId: mapKey(a.llmKeyId, `agent ${a.slug}`),
      fallbackChain: (a.fallbackChain ?? []).map((f) => ({
        ...f,
        keyId: mapKey(f.keyId, `the fallback chain of agent ${a.slug}`),
      })),
    }),
  );
  const keyRows = srcKeys
    .filter((k) => usedKeyIds.has(k.id))
    .map((k) =>
      project(LLM_KEY_POLICY, k as Row, { id: id('entity_llm_keys', k.id), entityId: spaceId }),
    );
  const skillRows = copiedSkills.map((s) =>
    project(SKILL_POLICY, s as Row, {
      id: id('agent_skills', s.id),
      entityId: spaceId,
      createdByAgentId:
        s.createdByAgentId === null ? null : mapAgent(s.createdByAgentId, `skill ${s.slug}`),
    }),
  );
  const assignmentRows = srcAssignments.map((a) =>
    project(SKILL_ASSIGNMENT_POLICY, a as Row, {
      id: id('agent_skill_assignments', a.id),
      entityId: spaceId,
      agentId: mapAgent(a.agentId, 'a skill assignment'),
      skillId: mapSkill(a.skillId),
    }),
  );
  const linkRows = srcLinks.map((l) =>
    project(DELEGATION_POLICY, l as Row, {
      id: id('agent_assignments', l.id),
      entityId: spaceId,
      orchestratorId: mapAgent(l.orchestratorId, 'a delegation link'),
      subAgentId: mapAgent(l.subAgentId, 'a delegation link'),
    }),
  );
  const ruleRows = srcRules.map((r) =>
    project(APPROVAL_RULE_POLICY, r as Row, {
      id: id('approval_rules', r.id),
      entityId: spaceId,
      agentId: mapAgent(r.agentId, `approval rule ${r.toolName}`),
    }),
  );
  const promptKeys = await promptSettingKeys();
  const srcSettings = await db
    .select()
    .from(d.entitySettings)
    .where(d.eq(d.entitySettings.entityId, src.id));
  const settingRows = srcSettings
    .filter((s) => promptKeys.includes(s.key))
    .map((s) => project(ENTITY_SETTING_POLICY, s as Row, { entityId: spaceId }));

  // ── L'espace tel qu'il est ──
  const have = async (rows: Promise<object[]>): Promise<Map<string, Row>> =>
    new Map((await rows).map((r) => [String((r as Row)['id']), r as Row]));
  const [spaceEntity] = existing
    ? await db.select().from(d.entities).where(d.eq(d.entities.id, spaceId)).limit(1)
    : [];
  const tables = [
    {
      name: 'entity_llm_keys',
      policy: LLM_KEY_POLICY,
      rows: keyRows,
      have: await have(
        db.select().from(d.entityLlmKeys).where(d.eq(d.entityLlmKeys.entityId, spaceId)),
      ),
      label: (r: Row) => `${String(r['provider'])} key "${String(r['nickname'] ?? '')}"`,
    },
    {
      name: 'agents',
      policy: AGENT_POLICY,
      rows: agentRows,
      have: await have(db.select().from(d.agents).where(d.eq(d.agents.entityId, spaceId))),
      label: (r: Row) => String(r['slug']),
    },
    {
      name: 'agent_skills',
      policy: SKILL_POLICY,
      rows: skillRows,
      have: await have(
        db.select().from(d.agentSkills).where(d.eq(d.agentSkills.entityId, spaceId)),
      ),
      label: (r: Row) => String(r['slug']),
    },
    {
      name: 'agent_skill_assignments',
      policy: SKILL_ASSIGNMENT_POLICY,
      rows: assignmentRows,
      have: await have(
        db
          .select()
          .from(d.agentSkillAssignments)
          .where(d.eq(d.agentSkillAssignments.entityId, spaceId)),
      ),
      label: (r: Row) =>
        `${String(r['agentId']).slice(0, 8)} → ${String(r['skillId']).slice(0, 8)}`,
    },
    {
      name: 'agent_assignments',
      policy: DELEGATION_POLICY,
      rows: linkRows,
      have: await have(
        db.select().from(d.agentAssignments).where(d.eq(d.agentAssignments.entityId, spaceId)),
      ),
      label: (r: Row) =>
        `${String(r['orchestratorId']).slice(0, 8)} → ${String(r['subAgentId']).slice(0, 8)}`,
    },
    {
      name: 'approval_rules',
      policy: APPROVAL_RULE_POLICY,
      rows: ruleRows,
      have: await have(
        db.select().from(d.approvalRules).where(d.eq(d.approvalRules.entityId, spaceId)),
      ),
      label: (r: Row) => `${String(r['toolName'])} ${String(r['action'])}`,
    },
  ];
  // Les noms lisibles d'un lien : ceux de la copie voulue, ou de la copie en
  // place quand c'est elle qui part.
  const slugOfAgent = new Map(
    [...agentRows, ...tables.find((t) => t.name === 'agents')!.have.values()].map((r) => [
      String(r['id']),
      String(r['slug']),
    ]),
  );
  const slugOfSkill = new Map(
    skillRows
      .map((r) => [String(r['id']), String(r['slug'])] as const)
      .concat(assignedSkills.map((s) => [s.id, s.slug] as const)),
  );
  const pretty = (table: string, r: Row): string => {
    if (table === 'agent_skill_assignments')
      return `${slugOfAgent.get(String(r['agentId'])) ?? '?'} → ${slugOfSkill.get(String(r['skillId'])) ?? '?'}`;
    if (table === 'agent_assignments')
      return `${slugOfAgent.get(String(r['orchestratorId'])) ?? '?'} → ${slugOfAgent.get(String(r['subAgentId'])) ?? '?'}`;
    if (table === 'approval_rules')
      return `${r['agentId'] ? (slugOfAgent.get(String(r['agentId'])) ?? '?') : 'workspace'}: ${String(r['toolName'])} ${String(r['action'])}`;
    return tables.find((t) => t.name === table)!.label(r);
  };

  const changes: PlannedChange[] = [];
  if (!spaceEntity) changes.push({ table: 'entities', kind: 'create', label: BENCH_SPACE_NAME });
  else {
    const cols = changedColumns(ENTITY_POLICY, entity, spaceEntity as Row);
    if (cols.length > 0)
      changes.push({ table: 'entities', kind: 'update', label: BENCH_SPACE_NAME, columns: cols });
  }
  for (const t of tables) {
    const wanted = new Set(t.rows.map((r) => String(r['id'])));
    for (const r of t.rows) {
      const cur = t.have.get(String(r['id']));
      if (!cur) changes.push({ table: t.name, kind: 'create', label: pretty(t.name, r) });
      else {
        const cols = changedColumns(t.policy, r, cur);
        if (cols.length > 0)
          changes.push({ table: t.name, kind: 'update', label: pretty(t.name, r), columns: cols });
      }
    }
    for (const [cid, cur] of t.have) {
      if (!wanted.has(cid))
        changes.push({ table: t.name, kind: 'delete', label: pretty(t.name, cur) });
    }
  }
  const haveSettings = existing
    ? await db.select().from(d.entitySettings).where(d.eq(d.entitySettings.entityId, spaceId))
    : [];
  for (const s of settingRows) {
    const cur = haveSettings.find((h) => h.key === s['key']);
    if (!cur) changes.push({ table: 'entity_settings', kind: 'create', label: String(s['key']) });
    else if (!same(cur.value, s['value']))
      changes.push({
        table: 'entity_settings',
        kind: 'update',
        label: String(s['key']),
        columns: ['value'],
      });
  }
  for (const h of haveSettings) {
    if (!settingRows.some((s) => s['key'] === h.key))
      changes.push({ table: 'entity_settings', kind: 'delete', label: h.key });
  }

  // ── Les fichiers des skills copiées ──
  const files: PlannedFiles[] = [];
  const skillDirs: Desired['skillDirs'] = [];
  const copiedSlugs = new Set(copiedSkills.map((s) => s.slug));
  for (const s of copiedSkills) {
    const from = join(opts.workspacesRoot, src.id, 'skills', s.slug);
    const to = join(opts.workspacesRoot, spaceId, 'skills', s.slug);
    const a = treeDigest(from);
    const b = treeDigest(to);
    if (a.size === 0 && b.size === 0) continue;
    if (a.size === 0) {
      files.push({ skillSlug: s.slug, kind: 'delete', files: b.size });
    } else if (b.size === 0) {
      files.push({ skillSlug: s.slug, kind: 'create', files: a.size });
    } else if (!sameTree(a, b)) {
      files.push({ skillSlug: s.slug, kind: 'update', files: a.size });
    }
    skillDirs.push({ slug: s.slug, from, to });
  }
  const spaceSkillsDir = join(opts.workspacesRoot, spaceId, 'skills');
  const staleSkillDirs = existsSync(spaceSkillsDir)
    ? readdirSync(spaceSkillsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !copiedSlugs.has(e.name))
        .map((e) => e.name)
    : [];
  for (const slug of staleSkillDirs) {
    files.push({
      skillSlug: slug,
      kind: 'delete',
      files: treeDigest(join(spaceSkillsDir, slug)).size,
    });
  }

  // ── Ce qui reste chez le propriétaire ──
  const notCopied: string[] = [];
  const slugOfSrcAgent = new Map(srcAgents.map((a) => [a.id, a.slug]));
  for (const a of srcAgents) {
    if (a.telegramBotToken) notCopied.push(`Telegram bot token of agent ${a.slug}`);
  }
  const bindings = await db
    .select({ channel: d.channelBindings.channel })
    .from(d.channelBindings)
    .where(d.eq(d.channelBindings.entityId, src.id));
  for (const b of bindings) notCopied.push(`${b.channel} channel binding`);
  if (agentIdList.length > 0) {
    const conns = await db
      .select({ agentId: d.agentConnectorAssignments.agentId, slug: d.connectors.slug })
      .from(d.agentConnectorAssignments)
      .innerJoin(d.connectors, d.eq(d.connectors.id, d.agentConnectorAssignments.connectorId))
      .where(d.inArray(d.agentConnectorAssignments.agentId, agentIdList));
    for (const c of conns)
      notCopied.push(`connector ${c.slug} of agent ${slugOfSrcAgent.get(c.agentId) ?? '?'}`);
    const mcps = await db
      .select({ agentId: d.agentMcpServers.agentId, slug: d.mcpServers.slug })
      .from(d.agentMcpServers)
      .innerJoin(d.mcpServers, d.eq(d.mcpServers.id, d.agentMcpServers.mcpServerId))
      .where(d.inArray(d.agentMcpServers.agentId, agentIdList));
    for (const m of mcps)
      notCopied.push(`MCP server ${m.slug} of agent ${slugOfSrcAgent.get(m.agentId) ?? '?'}`);
    const dirs = await db
      .select({ agentId: d.agentWorkspaces.agentId, label: d.agentWorkspaces.label })
      .from(d.agentWorkspaces)
      .where(d.inArray(d.agentWorkspaces.agentId, agentIdList));
    for (const w of dirs)
      notCopied.push(
        `working folder "${w.label}" of agent ${slugOfSrcAgent.get(w.agentId) ?? '?'} (the owner's own directory)`,
      );
  }
  const [schedules] = await db
    .select({ n: d.count() })
    .from(d.agentSchedules)
    .where(d.eq(d.agentSchedules.entityId, src.id));
  if ((schedules?.n ?? 0) > 0) notCopied.push(`${schedules!.n} schedule(s)`);
  const [hooks] = await db
    .select({ n: d.count() })
    .from(d.webhookTriggers)
    .where(d.eq(d.webhookTriggers.entityId, src.id));
  if ((hooks?.n ?? 0) > 0) notCopied.push(`${hooks!.n} webhook trigger(s)`);
  for (const s of srcSettings) {
    if (!promptKeys.includes(s.key)) notCopied.push(`workspace setting ${s.key}`);
  }
  notCopied.push('memory (the space has its own, emptied by `pnpm bench:space reset`)');

  const plan: SyncPlan = {
    source: { id: src.id, name: src.name },
    space: { id: spaceId, exists: Boolean(spaceEntity) },
    maxRunCostUsd: cap,
    changes,
    files,
    notCopied,
    referencedSystemSkills: [...referencedSystemSkills].sort(),
  };
  return {
    plan,
    desired: {
      entity,
      tables: tables.map((t) => ({ name: t.name, policy: t.policy, rows: t.rows })),
      settings: settingRows,
      skillDirs,
      staleSkillDirs: staleSkillDirs.map((s) => join(spaceSkillsDir, s)),
    },
  };
}

// ─── Le rendu ────────────────────────────────────────────────────────────────

const MARK: Record<ChangeKind, string> = { create: '+', update: '~', delete: '-' };

/** Le plan, lisible. Aucune valeur de colonne n'y figure : des noms seulement. */
export function renderPlan(plan: SyncPlan): string {
  const lines: string[] = [];
  lines.push(
    `Bench space ${plan.space.exists ? 'update' : 'creation'}: copy of "${plan.source.name}"`,
  );
  lines.push(`  space id ${plan.space.id}, reflection off, max run cost $${plan.maxRunCostUsd}`);
  if (plan.changes.length === 0 && plan.files.length === 0) {
    lines.push('', 'Nothing to change: the space already mirrors the team.');
  } else {
    lines.push('', 'Changes:');
    for (const c of plan.changes) {
      const cols = c.columns
        ? ` (${c.columns.map((x) => (SECRET_COLUMNS.has(x) ? `${x}: secret, value not shown` : x)).join(', ')})`
        : '';
      lines.push(`  ${MARK[c.kind]} ${c.table}: ${c.label}${cols}`);
    }
    for (const f of plan.files)
      lines.push(`  ${MARK[f.kind]} skill files: ${f.skillSlug} (${f.files} file(s))`);
  }
  if (plan.referencedSystemSkills.length > 0) {
    lines.push(
      '',
      `System skills referenced, not copied: ${plan.referencedSystemSkills.join(', ')}`,
    );
  }
  lines.push('', 'Not copied (stays with the owner):');
  for (const n of plan.notCopied) lines.push(`  · ${n}`);
  lines.push('', 'LLM keys are copied as ciphertext, never decrypted and never printed.');
  return lines.join('\n');
}

// ─── L'écriture ──────────────────────────────────────────────────────────────

/**
 * Écrit le plan : base dans UNE transaction (tout ou rien), puis les fichiers
 * des skills. Ne touche aucune ligne hors de l'espace du banc.
 */
export async function applySync(db: AnyDrizzleDb, plan: SyncPlan, desired: Desired): Promise<void> {
  const d = await import('@nodal-agents/db');
  const spaceId = plan.space.id;
  if (desired.entity['id'] !== spaceId || desired.entity['slug'] !== BENCH_SPACE_SLUG) {
    throw new Error(
      'bench_space_internal: refusing to write a workspace that is not the bench space',
    );
  }
  const tableOf = {
    entity_llm_keys: d.entityLlmKeys,
    agents: d.agents,
    agent_skills: d.agentSkills,
    agent_skill_assignments: d.agentSkillAssignments,
    agent_assignments: d.agentAssignments,
    approval_rules: d.approvalRules,
  } as const;
  type TableName = keyof typeof tableOf;

  await db.transaction(async (tx) => {
    const t = tx as unknown as AnyDrizzleDb;
    // La racine pointe sur un agent de l'espace (clé étrangère) : l'entité
    // s'écrit sans elle, les agents ensuite, la racine en dernier.
    const { id: _id, rootAgentId, ...entitySet } = desired.entity;
    const entityRow = { ...desired.entity, rootAgentId: null };
    await t
      .insert(d.entities)
      .values(entityRow as typeof d.entities.$inferInsert)
      .onConflictDoUpdate({
        target: d.entities.id,
        set: { ...entitySet, rootAgentId: null, updatedAt: new Date() },
      });

    // Supprimer d'abord (de la feuille vers la racine) : une copie dont la
    // source a disparu libère son slug avant qu'une autre le reprenne.
    for (const name of [...desired.tables.map((x) => x.name)].reverse() as TableName[]) {
      const table = tableOf[name];
      const keep = desired.tables.find((x) => x.name === name)!.rows.map((r) => String(r['id']));
      await t
        .delete(table)
        .where(
          keep.length === 0
            ? d.eq(table.entityId, spaceId)
            : d.and(d.eq(table.entityId, spaceId), d.notInArray(table.id, keep)),
        );
    }
    for (const { name, rows } of desired.tables) {
      const table = tableOf[name as TableName];
      for (const row of rows) {
        const { id: _rid, ...set } = row;
        await t
          .insert(table)
          .values(row as never)
          .onConflictDoUpdate({ target: table.id, set: set as never });
      }
    }

    await t
      .update(d.entities)
      .set({ rootAgentId: rootAgentId as string | null })
      .where(d.eq(d.entities.id, spaceId));

    const keys = desired.settings.map((s) => String(s['key']));
    await t
      .delete(d.entitySettings)
      .where(
        keys.length === 0
          ? d.eq(d.entitySettings.entityId, spaceId)
          : d.and(
              d.eq(d.entitySettings.entityId, spaceId),
              d.notInArray(d.entitySettings.key, keys),
            ),
      );
    for (const s of desired.settings) {
      await t
        .insert(d.entitySettings)
        .values(s as typeof d.entitySettings.$inferInsert)
        .onConflictDoUpdate({
          target: [d.entitySettings.entityId, d.entitySettings.key],
          set: { value: String(s['value']), updatedAt: new Date() },
        });
    }
  });

  // Les fichiers, une fois la base écrite : un échec ici se dit, et la
  // synchronisation suivante le refait (elle compare les arbres).
  for (const dir of desired.staleSkillDirs) rmSync(dir, { recursive: true, force: true });
  for (const { from, to } of desired.skillDirs) {
    rmSync(to, { recursive: true, force: true });
    if (existsSync(from)) {
      mkdirSync(join(to, '..'), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
  }
}
