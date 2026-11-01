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
import type { AnyDrizzleDb, ConversationScope } from '@nodal-agents/db';
import type { EmbeddingClient, NodalLlmClient } from '@nodal-agents/llm';

type ModelText = { system?: unknown; prompt?: unknown; messages?: unknown };

/** Les champs lus par le modèle, relus ; le reste de l'appel tel quel. */
async function forModel<A extends ModelText>(
  db: AnyDrizzleDb,
  scope: ConversationScope,
  args: A,
): Promise<A> {
  const picked: ModelText = {};
  for (const k of ['system', 'prompt', 'messages'] as const) {
    if (args[k] !== undefined) picked[k] = args[k];
  }
  const shown = await conversationIdsAsHandles(db, scope, picked);
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
  scope: ConversationScope,
): NodalLlmClient {
  return {
    // Read through, never copied: a failover chain's `config` is the model
    // SERVING (packages/llm/src/failover.ts), and every reader of it — the
    // files a request carries, the cost cap, the context window — must see
    // it move (review of #905, pass 1: a copy froze the primary for the job).
    get config() {
      return client.config;
    },
    get capabilities() {
      return client.capabilities;
    },
    generateText: (async (args, opts) => {
      // The messages built for the link that serves (`messagesForModel`, #903)
      // cross the same boundary as the call's own.
      const forLink = opts?.messagesForModel;
      return client.generateText(
        await forModel(db, scope, args),
        forLink
          ? {
              ...opts,
              messagesForModel: async (config) =>
                (await forModel(db, scope, { messages: await forLink(config) })).messages,
            }
          : opts,
      );
    }) as NodalLlmClient['generateText'],
    generateObject: (async (args) =>
      client.generateObject(await forModel(db, scope, args))) as NodalLlmClient['generateObject'],
    streamText: () => {
      throw new Error(
        'streamText_unavailable: a request to a model goes through the conversation-handle ' +
          'boundary (#824), which reads the database; use generateText.',
      );
    },
  };
}

/**
 * The runner's embedding client, whose every text is rewritten the same way
 * (#824, pass 2 of the review). An embedding provider is a third party: a
 * memory's fact, embedded at its write (`createMemory`) or by the startup
 * backfill (`backfillEmbeddings`), and the query a recall embeds
 * (`searchMemories`) reach it. BOTH sides go through this rewrite, in the
 * workspace the text belongs to (`EmbeddingScope`, required on every call), so
 * a memory embedded with a handle is compared with a query embedded with the
 * same handle. Wrapped once, where the client is created (`createRunnerDeps`).
 *
 * A text whose workspace is unknown even through its agent is NOT embedded:
 * the rewrite throws `ConversationScopeUnknownError`, and each caller keeps
 * the vector null and says so (#824, pass 3).
 */
export function embeddingsAddressedByHandle(
  client: EmbeddingClient,
  db: AnyDrizzleDb,
): EmbeddingClient {
  return {
    dimensions: client.dimensions,
    embed: async (text, scope) =>
      client.embed(await conversationIdsAsHandles(db, scope, text), scope),
  };
}
