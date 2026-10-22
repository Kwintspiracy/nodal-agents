// campaign/config.ts — la configuration du Nodal du banc, en données, validée.
//
// Décision du propriétaire (17/10, page « Nodal du banc ») : le banc teste
// NODAL, pas les modèles. Chaque campagne monte une instance neuve et y
// applique CETTE configuration : l'équipe (agents, personnalités, skills,
// outils, connecteurs, dossiers, consignes de délégation), les règles
// d'accord, les réglages des espaces, les modèles et les budgets. Elle vit
// dans le dépôt (`packages/bench/campaign/banc.json`), jamais dans le code ;
// ce schéma la refuse au premier défaut, avant que rien ne démarre.
//
// Ce qu'on fait varier d'une campagne à l'autre, c'est ce fichier. Son
// EMPREINTE (`configFingerprint`) est portée par chaque résultat : deux
// lignes ne se comparent qu'à configuration connue.
//
// Ce que le schéma refuse, en plus de la forme :
//   - un agent qui délègue hors de son espace, ou vers un agent inconnu ;
//   - un espace testé dont la racine n'est pas un orchestrateur de cet espace ;
//   - une opération de connecteur que le registre des adaptateurs ne range pas
//     en lecture (`risk: 'read'`) : rien dans l'instance ne doit pouvoir
//     écrire ou envoyer au-dehors ;
//   - un skill qui n'est pas au catalogue du produit, un skill communautaire
//     qui n'est pas au catalogue communautaire ;
//   - un modèle que le catalogue ne connaît pas, un juge de la même famille
//     que le modèle testé, un orchestrateur sur un modèle sans outils ;
//   - des ports qui sont ceux d'une installation par défaut (3000, 3001,
//     25432) : une campagne ne prend jamais la place de l'instance du
//     propriétaire.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { systemSkillSlugs } from '@nodal-agents/catalog';
import { ADAPTER_REGISTRY } from '@nodal-agents/runner-adapters';
import { COMMUNITY_SKILL_CATALOG, findModelCatalogEntry } from '@nodal-agents/shared';
import { BENCH_PRINTER_SLUG, BENCH_PRINTER_TOOLS } from '../printer/identity';
import { REPO } from '../workflows/paths';

/** Le fichier de la configuration du banc, dans le dépôt. */
export const CAMPAIGN_CONFIG_FILE = join(REPO, 'packages', 'bench', 'campaign', 'banc.json');

/** Les ports d'une installation par défaut : jamais ceux d'une campagne. */
export const NODAL_DEFAULT_PORTS = { web: 3000, runner: 3001, postgres: 25432 } as const;

const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,40}$/, 'a slug is lowercase letters, digits and dashes');

const ModelRef = z.object({ provider: z.string().min(1), model: z.string().min(1) }).strict();
export type CampaignModel = z.infer<typeof ModelRef>;

const Port = z.number().int().min(1024).max(65535);

/** Un dossier de travail que le banc pose pour un agent, sous le dossier de la campagne. */
const FolderSchema = z
  .object({
    label: z.string().min(1).max(80),
    /**
     * Ce que le banc y met avant chaque essai : rien (`empty`), ou un coffre
     * Obsidian (`obsidian-vault` : un dossier `.obsidian/`, comme Obsidian le crée).
     */
    seed: z.enum(['empty', 'obsidian-vault']),
  })
  .strict();
export type CampaignFolder = z.infer<typeof FolderSchema>;

const ConnectorSchema = z
  .object({
    /** Un connecteur du registre des adaptateurs, à clé d'API. */
    slug: Slug,
    /** Les opérations permises, toutes rangées « lecture » par le registre. */
    operations: z.array(z.string().min(1)).min(1),
  })
  .strict();

/**
 * L'emplacement du connecteur d'impression d'un agent : l'imprimante factice du
 * banc (#794), et RIEN D'AUTRE. Un serveur MCP qui enregistre ce qu'il reçoit
 * dans le dossier de la campagne et n'imprime jamais ; aucun autre serveur ne
 * se déclare ici, le schéma refuse son slug. `tools` : les outils de
 * l'imprimante que l'agent reçoit ; `autoApprove` : ceux qui passent sans
 * demande (décision D3 = a du propriétaire : `request_print`).
 */
const BenchPrinterTool = z.enum(BENCH_PRINTER_TOOLS);
const PrintConnectorSlot = z
  .object({
    mcpServer: z.literal(BENCH_PRINTER_SLUG),
    tools: z.array(BenchPrinterTool).min(1),
    autoApprove: z.array(BenchPrinterTool),
  })
  .strict()
  .refine((p) => p.autoApprove.every((t) => p.tools.includes(t)), {
    message: 'a tool approved without asking must be one the agent receives',
    path: ['autoApprove'],
  })
  .nullable();
export type PrintConnector = z.infer<typeof PrintConnectorSlot>;

const AgentSchema = z
  .object({
    slug: Slug,
    name: z.string().min(1).max(120),
    workspace: z.enum(['tested', 'judge']),
    /** `orchestrator` délègue (un routeur, comme l'écran le crée) ; `worker` exécute. */
    role: z.enum(['orchestrator', 'worker']),
    personality: z.string().min(1),
    /** Les skills ajoutés, du catalogue du produit (les skills de base le sont d'office). */
    skills: z.array(Slug).default([]),
    /** Les skills communautaires, installés par la route du runner que l'écran appelle. */
    communitySkills: z.array(Slug).default([]),
    connectors: z.array(ConnectorSchema).default([]),
    folders: z.array(FolderSchema).default([]),
    /** La règle de la ligne « Run commands » ; null : l'autonomie de l'espace décide. */
    runCommand: z.enum(['auto_approve', 'require_approval', 'block']).nullable().default(null),
    /** Le préréglage « relecteur en lecture seule ». */
    readOnly: z.boolean().default(false),
    /** Les coéquipiers, et la consigne de délégation que Nodal affiche pour chacun. */
    delegatesTo: z
      .array(z.object({ agent: Slug, instructions: z.string().min(1).max(500) }).strict())
      .default([]),
    printConnector: PrintConnectorSlot.default(null),
  })
  .strict();
export type CampaignAgent = z.infer<typeof AgentSchema>;

const WorkspaceSchema = z
  .object({
    name: z.string().min(1).max(60),
    icon: z.string().max(8).optional(),
    /** Le serveur MCP de Nodal : c'est par lui que le banc envoie chaque demande. */
    mcpServer: z.boolean(),
    /** La réflexion après tâche : coupée, aucune mémoire écrite hors de l'essai. */
    reflection: z.boolean(),
  })
  .strict();

/**
 * La famille d'un modèle : l'éditeur devant la barre (`anthropic/…`,
 * `z-ai/…`), sinon le fournisseur. Le juge n'est jamais de la famille du
 * modèle testé (décision du 17/10).
 */
export function modelFamily(m: { provider: string; model: string }): string {
  return m.model.includes('/') ? m.model.slice(0, m.model.indexOf('/')) : m.provider;
}

export const CampaignConfigSchema = z
  .object({
    version: z.literal(1),
    instance: z
      .object({
        ports: z.object({ web: Port, runner: Port, postgres: Port }).strict(),
      })
      .strict(),
    models: z.object({ tested: ModelRef, judge: ModelRef }).strict(),
    budget: z
      .object({
        perTrialUsd: z.number().positive(),
        perCampaignUsd: z.number().positive(),
      })
      .strict(),
    workspaces: z
      .object({
        tested: WorkspaceSchema.extend({ rootAgent: Slug }).strict(),
        judge: WorkspaceSchema,
      })
      .strict(),
    agents: z.array(AgentSchema).min(1),
  })
  .strict()
  .superRefine((c, ctx) => {
    const issue = (message: string, path: (string | number)[] = []): void => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    const bySlug = new Map(c.agents.map((a) => [a.slug, a]));
    if (bySlug.size !== c.agents.length) issue('two agents share a slug', ['agents']);

    const ports = c.instance.ports;
    for (const [name, port] of Object.entries(ports)) {
      if (Object.values(NODAL_DEFAULT_PORTS).includes(port as never)) {
        issue(`port ${port} is a default Nodal port: a campaign never takes it`, [
          'instance',
          'ports',
          name,
        ]);
      }
    }
    if (new Set(Object.values(ports)).size !== 3) issue('the three ports must differ');

    if (c.budget.perTrialUsd > c.budget.perCampaignUsd) {
      issue('the cap of one trial is above the cap of the campaign', ['budget']);
    }

    const root = bySlug.get(c.workspaces.tested.rootAgent);
    if (!root || root.workspace !== 'tested' || root.role !== 'orchestrator') {
      issue('the root of the tested workspace must be one of its orchestrators', [
        'workspaces',
        'tested',
        'rootAgent',
      ]);
    }
    const orchestrators = c.agents.filter(
      (a) => a.workspace === 'tested' && a.role === 'orchestrator',
    );
    if (orchestrators.length !== 1) {
      // createAgentRepo fait du premier orchestrateur la racine et range les
      // suivants sous lui : un second changerait l'équipe en silence.
      issue('the tested workspace has exactly one orchestrator, its root', ['agents']);
    }
    if (c.agents.some((a) => a.workspace === 'judge' && a.role === 'orchestrator')) {
      issue('the judge workspace delegates to nobody: its agents are workers', ['agents']);
    }

    if (modelFamily(c.models.tested) === modelFamily(c.models.judge)) {
      issue('the judge is never of the tested model’s family', ['models', 'judge']);
    }
    for (const which of ['tested', 'judge'] as const) {
      const m = c.models[which];
      const entry = findModelCatalogEntry(m.provider, m.model);
      if (!entry) issue(`${m.provider}:${m.model} is not in the model catalog`, ['models', which]);
      else if (which === 'tested' && orchestrators.length > 0 && !entry.capabilities.tools) {
        issue(`${entry.label} cannot use tools, and the root delegates by tool call`, [
          'models',
          which,
        ]);
      }
    }

    const community = new Set(COMMUNITY_SKILL_CATALOG.map((e) => e.slug));
    c.agents.forEach((a, i) => {
      const at = (...p: (string | number)[]): (string | number)[] => ['agents', i, ...p];
      for (const s of a.skills) {
        if (!systemSkillSlugs.includes(s))
          issue(`skill ${s} is not in the product catalog`, at('skills'));
      }
      for (const s of a.communitySkills) {
        if (!community.has(s))
          issue(`community skill ${s} is not in the community catalog`, at('communitySkills'));
      }
      for (const conn of a.connectors) {
        const entry = ADAPTER_REGISTRY[conn.slug];
        if (!entry || entry.credentialType !== 'api_key') {
          issue(
            `connector ${conn.slug} is not an API-key connector of the registry`,
            at('connectors'),
          );
          continue;
        }
        for (const op of conn.operations) {
          const d = entry.operations.find((o) => o.slug === op);
          if (!d) issue(`${conn.slug} has no operation ${op}`, at('connectors'));
          else if (d.risk !== 'read') {
            issue(
              `${op} is a ${d.risk} operation: the bench instance only reads outside`,
              at('connectors'),
            );
          }
        }
      }
      for (const d of a.delegatesTo) {
        const to = bySlug.get(d.agent);
        if (!to) issue(`${a.slug} delegates to an unknown agent ${d.agent}`, at('delegatesTo'));
        else if (to.workspace !== a.workspace) {
          issue(`${a.slug} delegates outside its workspace (${d.agent})`, at('delegatesTo'));
        } else if (a.role !== 'orchestrator') {
          issue(`${a.slug} is a worker: it delegates to nobody`, at('delegatesTo'));
        }
      }
      if (new Set(a.folders.map((f) => f.label)).size !== a.folders.length) {
        issue(`${a.slug} has two folders with the same label`, at('folders'));
      }
      if (a.printConnector !== null && a.workspace !== 'tested') {
        issue(`${a.slug} is not in the tested workspace: it prints nothing`, at('printConnector'));
      }
    });
  });

export type CampaignConfig = z.infer<typeof CampaignConfigSchema>;

/** Lit et valide la configuration ; toute erreur nomme le fichier et le champ. */
export function loadCampaignConfig(file: string = CAMPAIGN_CONFIG_FILE): CampaignConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(
      `campaign_config_unreadable: ${file}: ${String(e instanceof Error ? e.message : e)}`,
    );
  }
  const parsed = CampaignConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const lines = parsed.error.issues.map(
      (i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`,
    );
    throw new Error(`campaign_config_invalid: ${file}\n${lines.join('\n')}`);
  }
  return parsed.data;
}

/** Une sérialisation dont l'ordre des clés ne dépend pas de l'écriture du fichier. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * L'empreinte de la configuration APPLIQUÉE (les défauts du schéma compris) :
 * douze caractères du SHA-256 de sa forme canonique. Deux fichiers qui
 * disent la même chose ont la même empreinte, quel que soit l'ordre des clés.
 */
export function configFingerprint(c: CampaignConfig): string {
  return createHash('sha256').update(canonical(c)).digest('hex').slice(0, 12);
}

/** Les fournisseurs de modèles et les connecteurs dont la campagne a besoin de la clé. */
export function neededKeys(c: CampaignConfig): { providers: string[]; connectors: string[] } {
  return {
    providers: [...new Set([c.models.tested.provider, c.models.judge.provider])].sort(),
    connectors: [...new Set(c.agents.flatMap((a) => a.connectors.map((k) => k.slug)))].sort(),
  };
}
