// tool-card-payload.ts — la lecture d'une LIGNE D'AUDIT (P1) : sa charge utile
// présentée, et l'issue de l'appel.
//
// Ces deux lectures vivent seules pour une raison d'architecture : le fil
// (`conversation-feed.ts`) et la frontière chat/travail (`chat-or-work.ts`)
// lisent les MÊMES colonnes de `tool_calls`, et le fil doit connaître le
// verdict de la frontière pour le poser dans ses items. Les garder dans l'un
// des deux aurait fait un cycle d'import, que dependency-cruiser refuse (règle
// `no-circular`, tombée en CI le 06/09 sur P4b) ; les dupliquer aurait laissé
// deux lectures de la même colonne diverger en silence — c'est exactement ce
// qui est arrivé à P7, dont le classement ignorait l'issue que le fil, lui,
// lisait déjà (revue Codex, passe 29).

import { ToolCardPayloadSchema, TOOL_CARDS, readCallOutcome } from '@nodal-agents/shared';
import type { ToolCard, ToolCardPayload } from '@nodal-agents/shared';

/**
 * La carte DÉCLARÉE par la ligne, quand c'en est une. Elle vit ici, avec les
 * deux autres lectures de `tool_calls`, parce que le fil (`conversation-feed`)
 * et la liste des runs (`listRunCallsAction`) construisent la MÊME étape
 * d'outil : deux lectures de la colonne `card` auraient divergé au premier
 * type de carte ajouté.
 */
export function isToolCard(value: string | null): value is ToolCard {
  return value !== null && (TOOL_CARDS as readonly string[]).includes(value);
}

/**
 * La charge utile d'une ligne, VALIDÉE contre le schéma partagé. `null` quand
 * elle est absente ou hors forme : l'écran montre alors le brut et le dit —
 * jamais une charge à moitié lue.
 */
export function parsePresented(value: unknown): ToolCardPayload | null {
  if (value === null || value === undefined) return null;
  const parsed = ToolCardPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Ce qu'une action a donné, lu depuis la ligne d'audit — jamais deviné. */
export type StepOutcome = 'success' | 'error' | 'awaiting_approval' | 'blocked' | 'unknown';

/**
 * Le sort d'un appel, LU SUR SA COLONNE (`tool_calls.outcome`, #1184), par la
 * seule lecture du produit (`readCallOutcome`, @nodal-agents/shared) : plus
 * jamais deviné dans la sortie. Une ligne d'avant 0170 que la migration n'a pas
 * pu typer est `unknown`, dit comme tel, jamais un succès par défaut. Un appel
 * d'issue inconnue (une requête partie sans réponse) l'est aussi : on ne sait
 * pas comment il a fini.
 */
export function stepOutcomeOf(outcome: string | null | undefined): StepOutcome {
  const o = readCallOutcome(outcome);
  switch (o) {
    case 'done':
      return 'success';
    case 'failed':
      return 'error';
    case 'refused':
      return 'blocked';
    case 'awaiting_approval':
      return 'awaiting_approval';
    case 'unknown':
    case 'not_recorded':
      return 'unknown';
  }
}

/**
 * L'appel a-t-il EU LIEU ? Une erreur, un blocage, une attente d'approbation
 * n'ont rien fait : ce qu'ils auraient écrit ne compte pas (P2bis, revue
 * Codex passe 56). `unknown` (une ligne non enregistrée, ou une issue
 * inconnue) compte : l'appel a peut-être tourné.
 */
export function callHappened(outcome: StepOutcome): boolean {
  return outcome !== 'error' && outcome !== 'blocked' && outcome !== 'awaiting_approval';
}

/**
 * L'appel a-t-il été REFUSÉ (#395) ? Par une règle du propriétaire, ou par une
 * personne : la colonne le dit (`refused`), et c'est la seule lecture.
 */
export function isRefusedOutcome(outcome: string | null | undefined): boolean {
  return readCallOutcome(outcome) === 'refused';
}
