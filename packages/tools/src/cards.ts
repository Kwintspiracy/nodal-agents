// cards.ts — la carte d'un outil, résolue en UN endroit (plan « De la maquette
// au produit », P1).
//
// LE CONTRAT. Un outil déclare `card` — comment son résultat se montre. L'écran
// de conversation dispatche sur cette valeur, jamais sur le nom de l'outil :
// c'est ce qui empêche l'écran de devenir un `switch` sur des noms qu'il faut
// éditer à chaque outil ajouté (revue Codex, 05/09 : « sans ce contrat, l'écran
// meurt »).
//
// LE REPLI, ET POURQUOI IL EST HONNÊTE. Un outil sans carte rend `generic`, la
// carte qui affiche l'entrée et la sortie brutes en le disant. Ce n'est pas un
// repli malin qui devine (invariant #4) : c'est l'aveu explicite qu'on ne sait
// pas mieux montrer ce résultat. DeepSeek Harness fait exactement ça (« the Web
// Client returns a generic row for unsupported input »). Les outils du produit
// n'ont PAS le droit de s'y reposer — `cards.test.ts` les énumère et nomme
// celui qui manque. Les outils tiers (serveurs MCP, adaptateurs) y ont droit,
// le temps qu'une carte plus juste leur soit donnée.

import { TOOL_CARDS } from '@nodal-agents/shared';
import type { ToolCard } from '@nodal-agents/shared';
import type { z } from 'zod';
import type { ToolDefinition } from './types';

/** La carte des outils qui n'en déclarent pas. Nommée pour être cherchée. */
export const TOOL_CARD_GENERIC: ToolCard = 'generic';

/**
 * La carte d'un outil : celle qu'il déclare, sinon `generic`.
 *
 * Une valeur déclarée hors du vocabulaire (un outil tiers qui inventerait la
 * sienne) est traitée comme absente — une carte inconnue ne peut être
 * dispatchée par aucun écran, et la dire `generic` est plus vrai que de la
 * laisser passer.
 */
export function cardForTool(tool: Pick<ToolDefinition<z.ZodTypeAny, unknown>, 'card'>): ToolCard {
  const declared = tool.card;
  if (declared !== undefined && (TOOL_CARDS as readonly string[]).includes(declared)) {
    return declared;
  }
  return TOOL_CARD_GENERIC;
}

/** L'outil a-t-il déclaré sa carte lui-même ? (Pour l'énumération du registre.) */
export function declaresCard(tool: Pick<ToolDefinition<z.ZodTypeAny, unknown>, 'card'>): boolean {
  return tool.card !== undefined && (TOOL_CARDS as readonly string[]).includes(tool.card);
}
