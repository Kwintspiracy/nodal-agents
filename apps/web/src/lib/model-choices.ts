// model-choices.ts — ce qu'un agent peut choisir comme modèle et comme effort.
//
// Ces fonctions vivaient dans `AgentComposer.tsx` (l'écran d'édition d'un
// agent). Les trois listes du composeur de chat (#138) règlent EXACTEMENT les
// mêmes champs : les laisser recalculer les règles de leur côté, c'est se
// donner deux définitions de « quels modèles cette clé propose » et de « cet
// effort existe-t-il », qui divergeront — et c'est précisément ce qui s'est
// produit. Elles sont donc ici, pures, importées par l'écran d'édition, par le
// composeur, et par l'action serveur qui écrit la ligne : la même règle des
// trois côtés.
//
// Ces fonctions sont PURES : aucune ne va au réseau. La liste vue en direct
// chez le fournisseur est lue par `listKeyModelsAction` côté écran, et passée
// ici en argument — c'est ce qui permet de prouver PAR UN TEST que le composeur
// et l'écran d'édition proposent la même chose pour la même clé.

import {
  MODEL_CATALOG,
  findModelCatalogEntry,
  groupModelCatalog,
  modelOptionLabel,
  type ModelCatalogEntry,
} from '@nodal-agents/shared';
import { prettyProviderName } from './provider-names.ts';

/** L'ordre des paliers d'un contrôle `budget` — du plus petit au plus grand. */
export const REASONING_BUDGET_ORDER = ['low', 'medium', 'high', 'max'] as const;

/**
 * Les valeurs d'effort sélectionnables pour un couple fournisseur + modèle,
 * telles que le catalogue les déclare (`reasoningControl`) : les paliers du
 * modèle, plus `off` sauf quand le raisonnement est obligatoire.
 *
 * Tableau vide = rien à régler — le champ se cache plutôt que d'offrir un
 * choix sans effet (inv. #4 : pas de faux réglage).
 */
export function reasoningOptionValues(provider: string, modelId: string): string[] {
  const control = findModelCatalogEntry(provider, modelId)?.capabilities.reasoningControl;
  if (!control) return [];
  const levels =
    control.kind === 'onoff'
      ? []
      : control.kind === 'budget'
        ? REASONING_BUDGET_ORDER.filter((l) => control.budgets?.[l])
        : (control.levels ?? []);
  return control.mandatory ? [...levels] : [...levels, 'off'];
}

/** Le nom lisible d'un effort. Une valeur inconnue se rend telle quelle. */
export const REASONING_LABELS: Record<string, string> = {
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
};

/**
 * Un modèle proposable. `entry` n'existe que pour un modèle CATALOGUÉ : c'est
 * lui qui porte les capacités (outils, raisonnement). Un modèle vu en direct
 * chez le fournisseur n'en a pas — on ne sait rien de lui, et on ne prétend
 * donc rien à son sujet (inv. #4).
 */
export interface ModelChoice {
  modelId: string;
  label: string;
  entry?: ModelCatalogEntry;
}

/** Le groupe des modèles vus en direct, tel que l'écran d'édition le nomme. */
export const LIVE_MODELS_GROUP = 'Live from provider';

/** Une section de la liste déroulante. `group: null` = sans intitulé. */
export interface ModelOptionGroup {
  group: string | null;
  models: ModelChoice[];
}

/**
 * LA liste des modèles d'une clé — celle de l'écran d'édition, et donc celle
 * du composeur : le catalogue curé du fournisseur, groupé et trié comme
 * `groupModelCatalog` le fait, puis les identifiants vus EN DIRECT chez le
 * fournisseur qui n'y sont pas déjà.
 *
 * Une seule fonction pour les deux écrans, parce que le reproche était
 * exactement celui-là : la liste du composeur ne ressemblait pas à celle des
 * réglages. Deux constructions séparées finissent toujours par diverger.
 *
 * `liveModelIds` vide = le fournisseur n'a pas répondu, ou n'a pas encore été
 * interrogé : il ne reste que le catalogue, exactement comme sur l'écran
 * d'édition.
 */
export function buildModelOptionGroups(
  provider: string,
  liveModelIds: readonly string[],
): ModelOptionGroup[] {
  const catalog = MODEL_CATALOG[provider] ?? [];
  const groups: ModelOptionGroup[] = groupModelCatalog(catalog).map(({ group, models }) => ({
    group,
    models: models.map((entry) => ({
      modelId: entry.modelId,
      label: modelOptionLabel(entry),
      entry,
    })),
  }));
  const catalogued = new Set(catalog.map((m) => m.modelId));
  const extraLive = liveModelIds.filter((id) => !catalogued.has(id));
  if (extraLive.length > 0) {
    groups.push({
      group: LIVE_MODELS_GROUP,
      models: extraLive.map((modelId) => ({ modelId, label: modelId })),
    });
  }
  return groups;
}

/** Tous les identifiants d'une liste, dans l'ordre d'affichage. */
export function modelIdsOf(groups: readonly ModelOptionGroup[]): string[] {
  return groups.flatMap((g) => g.models.map((m) => m.modelId));
}

/** Le modèle figure-t-il dans la liste déroulante ? */
export function isModelInOptions(groups: readonly ModelOptionGroup[], modelId: string): boolean {
  return groups.some((g) => g.models.some((m) => m.modelId === modelId));
}

/**
 * Le modèle par défaut d'un fournisseur : le premier de son catalogue. C'est
 * ce que l'écran d'édition pose quand on change de clé — un identifiant de
 * modèle n'a de sens que chez son fournisseur.
 */
export function defaultModelForProvider(provider: string): string {
  return MODEL_CATALOG[provider]?.[0]?.modelId ?? '';
}

/** Le libellé d'une clé LLM, écrit comme l'écran d'édition l'écrit. */
export function llmKeyLabel(key: { nickname?: string | null; provider: string }): string {
  const pretty = prettyProviderName(key.provider);
  return `${key.nickname ?? pretty} (${pretty})`;
}

/**
 * Le même nom, écrit UNE FOIS — la forme des rangées serrées (la pastille du
 * composeur, #138).
 *
 * `llmKeyLabel` répète le fournisseur entre parenthèses parce qu'un formulaire
 * a la place de lever l'ambiguïté entre deux clés du même fournisseur. Sur une
 * ligne au-dessus d'un fil, « Open Router (Open Router) » n'apprend rien à
 * personne — Quentin, 17/09 : « c'est quoi ce délire d'écrire deux fois le nom
 * du provider ». Le surnom quand il y en a un, sinon le nom du fournisseur,
 * jamais les deux.
 */
export function llmKeyShortLabel(key: { nickname?: string | null; provider: string }): string {
  const nickname = key.nickname?.trim();
  return nickname !== undefined && nickname !== '' ? nickname : prettyProviderName(key.provider);
}

/** Ce que l'écran d'édition dit d'un modèle sans outils proposé à un routeur. */
export const NO_TOOLS_HINT = "Can't use tools (required for a router/planner)";

/**
 * Pourquoi un modèle est GRISÉ pour cet agent, ou `null` s'il se choisit.
 *
 * La seule raison aujourd'hui : un routeur ou un planificateur délègue par
 * appel d'outil, et un modèle catalogué SANS outils ne peut pas le faire.
 * L'écran d'édition grise ces modèles (`ModelOptionTag`) ; la pastille du
 * composeur applique la même règle, par cette même fonction — laisser choisir
 * puis refuser par un toast serait une seconde définition de la règle (revue
 * Reviewer C, PR #142). Un modèle hors catalogue ne dit rien de ses outils :
 * il n'est jamais grisé (inv. #4, on ne prétend rien).
 */
export function disabledHintFor(choice: ModelChoice, requireTools: boolean): string | null {
  if (!requireTools) return null;
  if (choice.entry === undefined || choice.entry.capabilities.tools) return null;
  return NO_TOOLS_HINT;
}

/**
 * L'effort demandé est-il refusable ? Vrai SEULEMENT quand le modèle est
 * catalogué et que son contrôle ne l'offre pas.
 *
 * Un modèle hors catalogue (un identifiant libre, un modèle vu en direct) ne
 * dit rien de ses paliers : le refuser interdirait un réglage que l'écran
 * d'édition accepte, et inventer un verdict à partir d'une absence serait un
 * faux « non ». On ne refuse donc que ce qu'on SAIT faux.
 */
export function isRefusedEffort(provider: string, modelId: string, effort: string): boolean {
  if (findModelCatalogEntry(provider, modelId) === undefined) return false;
  return !reasoningOptionValues(provider, modelId).includes(effort);
}
