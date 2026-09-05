// cards.ts — la carte d'un outil, et sa charge utile, résolues en UN endroit
// (plan « De la maquette au produit », P1).
//
// LE CONTRAT. Un outil déclare `card` — comment son résultat se montre — et,
// pour toute carte à structure, `present()` — comment on tire de SA sortie la
// charge utile de CETTE carte (formes dans `@nodal-agents/shared`,
// `tool-cards.ts`). L'écran de conversation dispatche sur la carte et lit la
// charge utile, jamais le nom de l'outil : c'est ce qui empêche l'écran de
// devenir un `switch` sur des noms qu'il faut éditer à chaque outil ajouté
// (revue Codex, 05/09 : « sans ce contrat, l'écran meurt » ; passes 12-13 :
// « une étiquette sans forme oblige à dispatcher par nom quand même »).
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
// CE QUI N'EST PAS UN REPLI. Une carte DÉCLARÉE hors du vocabulaire, une carte à
// structure sans `present()`, une charge utile qui ne respecte pas la forme de
// sa carte, un SUCCÈS présenté en texte sous une carte structurée : quatre
// violations du contrat, quatre erreurs LEVÉES — à l'enregistrement quand c'est
// possible, à la présentation sinon. Jamais un rabattement silencieux sur
// `generic`.

import { TOOL_CARDS, CARDS_NEEDING_PRESENTER, ToolCardPayloadSchema } from '@nodal-agents/shared';
import type { ToolCard, ToolCardPayload } from '@nodal-agents/shared';
import type { z } from 'zod';
import type { ToolDefinition } from './types';
import { textCard } from './presenters';

/** La carte des outils qui n'en déclarent pas. Nommée pour être cherchée. */
export const TOOL_CARD_GENERIC = 'generic' as const satisfies ToolCard;

type CardBearer = Pick<ToolDefinition<z.ZodTypeAny, unknown>, 'name' | 'card' | 'present'>;

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

/** La présentation d'un résultat a violé le contrat de sa carte. */
export class ToolPresentationError extends Error {
  constructor(
    public readonly toolName: string,
    detail: string,
  ) {
    super(`tool "${toolName}": ${detail}`);
    this.name = 'ToolPresentationError';
  }
}

function isKnownCard(value: string): value is ToolCard {
  return (TOOL_CARDS as readonly string[]).includes(value);
}

/**
 * Lève si l'outil déclare une carte hors du vocabulaire, ou une carte à
 * structure sans `present()`. Ne dit rien d'un outil qui ne déclare pas de
 * carte — l'absence est permise, l'invention et la demi-déclaration non.
 */
export function assertToolCard(tool: CardBearer): void {
  const declared: string | undefined = tool.card;
  if (declared === undefined) return;
  if (!isKnownCard(declared)) throw new ToolCardError(tool.name, declared);
  if (CARDS_NEEDING_PRESENTER.includes(declared) && tool.present === undefined) {
    throw new ToolPresentationError(
      tool.name,
      `declares card "${declared}" but no \`present()\` — a structured card needs the tool to ` +
        `say how its output fills that card's payload (packages/tools/src/presenters.ts)`,
    );
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

/**
 * La charge utile d'un résultat, telle que la ligne `tool_calls` la persiste et
 * que l'écran la lit.
 *
 * - l'outil a un `present()` : sa charge utile, VALIDÉE contre la forme de la
 *   carte. La seule charge d'une AUTRE carte qu'on accepte est un `text`
 *   marqué `failure: true` (`failureText`) : le résultat est un échec, la ligne
 *   garde la carte déclarée, la charge dit pourquoi il n'y a rien à dessiner.
 *   Un `text` de succès sous une carte structurée est refusé — sinon un outil
 *   `files` pourrait réussir et se dispenser de son contrat sans que rien ne
 *   le dise (revue passe 14).
 * - carte `text` sans `present()` : la sortie, en texte, plafonnée.
 * - carte `generic` : rien à porter — l'entrée et la sortie sont sur la ligne.
 * - carte à structure sans `present()` : refusé (déjà refusé à
 *   l'enregistrement ; répété ici pour les outils nés hors registre).
 */
export function presentToolResult(
  tool: CardBearer,
  input: unknown,
  output: unknown,
): ToolCardPayload {
  const card = cardForTool(tool);
  if (tool.present !== undefined) {
    const raw = tool.present({ input, output });
    const parsed = ToolCardPayloadSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ToolPresentationError(
        tool.name,
        `present() returned a payload that does not fit any card: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.join('.') || '<root>'} ${i.message}`)
          .join('; ')}`,
      );
    }
    const payload = parsed.data;
    if (payload.card !== card) {
      const isDeclaredFailure = payload.card === 'text' && payload.failure === true;
      if (!isDeclaredFailure) {
        throw new ToolPresentationError(
          tool.name,
          `present() returned card "${payload.card}" for a tool that declares "${card}" — ` +
            `only a \`text\` payload marked \`failure: true\` may stand in for a structured card`,
        );
      }
    }
    return payload;
  }
  if (card === 'text') return textCard(output);
  if (card === TOOL_CARD_GENERIC) return { card: TOOL_CARD_GENERIC };
  // assertToolCard a déjà levé pour ce cas ; la ligne existe pour le typage.
  throw new ToolPresentationError(tool.name, `declares card "${card}" but no \`present()\``);
}
