// tool-card-payload.ts — la lecture d'une charge utile persistée (P1).
//
// Une seule fonction, et elle vit seule pour une raison d'architecture : le
// fil (`conversation-feed.ts`) et la frontière chat/travail (`chat-or-work.ts`)
// lisent la MÊME colonne `tool_calls.presented`, et le fil doit connaître le
// verdict de la frontière pour le poser dans ses items. La garder dans l'un
// des deux aurait fait un cycle d'import, que dependency-cruiser refuse (règle
// `no-circular`, tombée en CI le 06/09 sur P4b) ; la dupliquer aurait laissé
// deux validations diverger en silence.

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
