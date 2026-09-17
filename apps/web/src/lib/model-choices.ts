// model-choices.ts — ce qu'un agent peut choisir comme modèle et comme effort.
//
// Ces fonctions vivaient dans `AgentComposer.tsx` (l'écran d'édition d'un
// agent). Le sélecteur du composeur de chat (#138) change EXACTEMENT le même
// réglage : le laisser recalculer les règles de son côté, c'est se donner deux
// définitions de « cet effort existe-t-il », qui divergeront. Elles sont donc
// ici, pures, importées par l'écran d'édition, par le composeur, et par
// l'action serveur qui écrit la ligne — la même règle des trois côtés.
//
// Aucun appel réseau : le catalogue est une donnée statique du paquet partagé.

import { MODEL_CATALOG, findModelCatalogEntry, modelOptionLabel } from '@nodal-agents/shared';

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

/** Un modèle proposable : son identifiant et le nom que l'écran affiche. */
export interface ModelChoice {
  modelId: string;
  label: string;
}

/**
 * Les modèles proposés pour un fournisseur : son catalogue curé, et le modèle
 * courant en tête s'il n'y figure pas (un identifiant libre ou un modèle vu
 * en direct sur l'écran d'édition reste choisissable, donc gardable).
 *
 * Volontairement SANS appel au `/models` du fournisseur : ce catalogue sert
 * une pastille de composeur, ouverte des dizaines de fois par session, et une
 * liste en direct y coûterait une requête réseau par ouverture. L'écran
 * d'édition, lui, garde sa liste en direct.
 */
export function catalogModelChoices(provider: string, currentModel: string): ModelChoice[] {
  const curated = (MODEL_CATALOG[provider] ?? []).map((entry) => ({
    modelId: entry.modelId,
    label: modelOptionLabel(entry),
  }));
  if (currentModel !== '' && !curated.some((c) => c.modelId === currentModel)) {
    return [{ modelId: currentModel, label: currentModel }, ...curated];
  }
  return curated;
}

/**
 * Le modèle est-il choisissable pour ce fournisseur ? Vrai s'il est au
 * catalogue, ou s'il est DÉJÀ celui de l'agent — on ne refuse jamais de
 * réécrire ce qui est écrit, sinon changer d'effort seul deviendrait
 * impossible sur un modèle hors catalogue.
 */
export function isSelectableModel(
  provider: string,
  modelId: string,
  currentModel: string,
): boolean {
  if (modelId === currentModel) return true;
  return findModelCatalogEntry(provider, modelId) !== undefined;
}
