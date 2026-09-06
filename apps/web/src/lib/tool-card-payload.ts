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

import { ToolCardPayloadSchema } from '@nodal-agents/shared';
import type { ToolCardPayload } from '@nodal-agents/shared';

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
 * Le sort d'un appel, lu depuis ce que `executeTool` a écrit : une ligne
 * d'échec porte `{ outcome: 'error' | 'blocked' | 'awaiting_approval' }`, une
 * ligne de succès porte la sortie brute de l'outil. Une sortie absente est
 * `unknown` — jamais un succès par défaut.
 */
export function outcomeOfToolOutput(toolOutput: string | null | undefined): StepOutcome {
  if (toolOutput === null || toolOutput === undefined) return 'unknown';
  try {
    const parsed = JSON.parse(toolOutput) as unknown;
    if (parsed && typeof parsed === 'object' && 'outcome' in parsed) {
      const o = (parsed as { outcome: unknown }).outcome;
      if (o === 'error' || o === 'blocked' || o === 'awaiting_approval') return o;
      if (o === 'success') return 'success';
    }
  } catch {
    // sortie non JSON : une chaîne brute, donc un succès textuel
  }
  return 'success';
}
