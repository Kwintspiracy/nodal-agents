// addressed-by-handle.ts — LA frontière du runtime Nodal vers le fournisseur
// d'un modèle, pour les adresses de conversation (#824, passe 1 de la revue).
//
// Les écrivains du runner écrivent des HANDLES depuis #824. Le texte déjà
// stocké, lui, porte encore l'identifiant du canal — un DM WhatsApp s'appelle
// par un numéro de téléphone — et il repart chez le fournisseur par bien des
// chemins : l'historique d'un fil (`loadThreadHistory`), les messages d'un job
// repris après une approbation, une mémoire injectée dans le prompt, la sortie
// d'un outil qui relit la base, l'entrée d'une file. Plutôt qu'un correctif par
// chemin, tout passe ici : chaque requête du client LLM d'un agent
// (`resolveAgentLlmClient`, la seule source de clients du runtime Nodal —
// travail, chat, relecture d'action, réflexion, curateurs, livraison) a son
// prompt système et ses messages relus par `conversationIdsAsHandles`
// (@nodal-agents/db). Ce qui est STOCKÉ ne change pas : le dashboard et
// l'audit lisent la vérité.

import { conversationIdsAsHandles } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { NodalLlmClient } from '@nodal-agents/llm';

type ModelText = { system?: unknown; prompt?: unknown; messages?: unknown };

/** Les champs lus par le modèle, relus ; le reste de l'appel tel quel. */
async function forModel<A extends ModelText>(
  db: AnyDrizzleDb,
  entityId: string | null,
  args: A,
): Promise<A> {
  const picked: ModelText = {};
  for (const k of ['system', 'prompt', 'messages'] as const) {
    if (args[k] !== undefined) picked[k] = args[k];
  }
  const shown = await conversationIdsAsHandles(db, entityId, picked);
  return { ...args, ...shown };
}

/**
 * Le même client, dont chaque requête nomme les conversations par leur handle.
 *
 * `streamText` rend son flux de façon synchrone : la relecture, qui lit la
 * base, ne peut pas s'y glisser. Aucun appelant du runner ne s'en sert ; il
 * lève plutôt que d'ouvrir un chemin non relu (invariant #4).
 */
export function addressedByHandle(
  client: NodalLlmClient,
  db: AnyDrizzleDb,
  entityId: string | null,
): NodalLlmClient {
  return {
    config: client.config,
    capabilities: client.capabilities,
    generateText: (async (args, opts) =>
      client.generateText(
        await forModel(db, entityId, args),
        opts,
      )) as NodalLlmClient['generateText'],
    generateObject: (async (args) =>
      client.generateObject(
        await forModel(db, entityId, args),
      )) as NodalLlmClient['generateObject'],
    streamText: () => {
      throw new Error(
        'streamText_unavailable: a request to a model goes through the conversation-handle ' +
          'boundary (#824), which reads the database; use generateText.',
      );
    },
  };
}
