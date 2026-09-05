// cards.ts — la carte d'un outil, résolue en UN endroit (plan « De la maquette
// au produit », P1).
//
// LE CONTRAT. Un outil déclare `card` — comment son résultat se montre. L'écran
// de conversation dispatche sur cette valeur, jamais sur le nom de l'outil :
// c'est ce qui empêche l'écran de devenir un `switch` sur des noms qu'il faut
// éditer à chaque outil ajouté (revue Codex, 05/09 : « sans ce contrat, l'écran
// meurt »).
//
// LE REPLI, ET POURQUOI IL EST HONNÊTE. Un outil SANS carte rend `generic`, la
// carte qui affiche l'entrée et la sortie brutes en le disant. Ce n'est pas un
// repli malin qui devine (invariant #4) : c'est l'aveu explicite qu'on ne sait
// pas mieux montrer ce résultat. DeepSeek Harness fait exactement ça (« the Web
// Client returns a generic row for unsupported input »). Les outils du produit
// n'ont PAS le droit de s'y reposer — `cards.test.ts` les énumère et nomme
// celui qui manque. Les outils tiers (serveurs MCP, adaptateurs) y ont droit,
// le temps qu'une carte plus juste leur soit donnée.
//
// CE QUI N'EST PAS UN REPLI. Une carte DÉCLARÉE hors du vocabulaire n'est pas
// une absence, c'est une violation du contrat — la première version la
// rabattait sur `generic` en silence, et la revue (passe 11) a nommé ça pour ce
// que c'était : un repli silencieux. Elle lève, au plus tôt : à l'enregistrement
// pour les outils du registre, à la première lecture pour les autres.

import { TOOL_CARDS } from '@nodal-agents/shared';
import type { ToolCard } from '@nodal-agents/shared';
import type { z } from 'zod';
import type { ToolDefinition } from './types';

/** La carte des outils qui n'en déclarent pas. Nommée pour être cherchée. */
export const TOOL_CARD_GENERIC: ToolCard = 'generic';

type CardBearer = Pick<ToolDefinition<z.ZodTypeAny, unknown>, 'name' | 'card'>;

/** Un outil a déclaré une carte que le vocabulaire ne connaît pas. */
export class ToolCardError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly declared: string,
  ) {
    super(
      `tool "${toolName}" declares card "${declared}", which is not in the vocabulary ` +
        `(${TOOL_CARDS.join(', ')}). Declare one of these, or omit \`card\` to fall back to "generic".`,
    );
    this.name = 'ToolCardError';
  }
}

function isKnownCard(value: string): value is ToolCard {
  return (TOOL_CARDS as readonly string[]).includes(value);
}

/**
 * Lève si l'outil déclare une carte hors du vocabulaire. Ne dit rien d'un outil
 * qui n'en déclare pas — l'absence est permise, l'invention ne l'est pas.
 */
export function assertToolCard(tool: CardBearer): void {
  const declared: string | undefined = tool.card;
  if (declared !== undefined && !isKnownCard(declared)) {
    throw new ToolCardError(tool.name, declared);
  }
}

/** La carte d'un outil : celle qu'il déclare, sinon `generic`. Lève sur une carte inventée. */
export function cardForTool(tool: CardBearer): ToolCard {
  assertToolCard(tool);
  return tool.card ?? TOOL_CARD_GENERIC;
}

/** L'outil a-t-il déclaré sa carte lui-même ? (Pour l'énumération du registre.) */
export function declaresCard(tool: CardBearer): boolean {
  assertToolCard(tool);
  return tool.card !== undefined;
}
