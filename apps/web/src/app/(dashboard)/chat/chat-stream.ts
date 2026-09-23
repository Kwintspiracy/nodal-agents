'use client';

// chat-stream.ts — envoyer un message et lire la réponse pendant qu'elle arrive.
//
// Le geste est le même qu'avant : un message part, une réponse revient, le fil
// est relu. Ce qui change, c'est qu'on voit le texte se former (#152).
//
// LE REPLI, et pourquoi il est là où il est. La route ouvre son flux APRÈS
// toutes ses vérifications ; un statut non-200 veut donc dire qu'aucun tour n'a
// été lancé, et reprendre le chemin d'avant (`sendChatMessageAction`) ne risque
// pas de le rejouer. Une fois le flux ouvert, l'inverse est vrai : le tour
// tourne, le message de la personne est déjà écrit en base, et relancer l'action
// ferait répondre deux fois. Donc on ne se replie JAMAIS après l'ouverture — on
// le dit, par le même bloc d'échec que d'habitude (invariant #4).
//
// Et jamais de texte tronqué présenté comme final. Deux gardes, une par cas :
// le tour qui réussit rend sa réponse ENTIÈRE dans `done`, qui remplace ce qui
// a été accumulé ; le tour qui échoue rend `ok: false`, et l'appelant retire
// alors la copie du fil — la phrase à moitié écrite quitte l'écran avec elle.

import { sendChatMessageAction } from '@/lib/actions.ts';
import { readSseMessages } from '@/lib/sse.ts';

export type SendResult =
  | {
      ok: true;
      reply: string;
      /**
       * Les fragments déjà montrés SONT-ils cette réponse ? Faux quand le tour
       * a livré son texte d'un bloc : `streamText` cassé, agent en runtime CLI,
       * ou repli sur l'action serveur. Porté depuis le runner, jamais deviné.
       * Rien à l'écran n'en dépend aujourd'hui — c'est le fait qui manquait
       * pour qu'un lecteur puisse un jour le dire sans supposer (inv. #4).
       */
      streamed: boolean;
    }
  | { ok: false; message: string };

export interface SendOptions {
  conversationId: string;
  message: string;
  /** Le texte de la réponse CONNU À CET INSTANT — entier, pas le fragment. */
  onText: (text: string) => void;
}

const STREAM_URL = '/api/chat/stream';

/** Le chemin d'avant : l'action serveur, qui attend la réponse entière. */
async function viaAction(opts: SendOptions): Promise<SendResult> {
  let r: Awaited<ReturnType<typeof sendChatMessageAction>>;
  try {
    r = await sendChatMessageAction({
      conversationId: opts.conversationId,
      message: opts.message,
    });
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Could not send the message',
    };
  }
  if (!r.ok) return { ok: false, message: r.message };
  // L'action serveur attend la réponse entière : rien n'a été montré mot à mot.
  return { ok: true, reply: r.data?.reply ?? '', streamed: false };
}

export async function sendChatMessage(opts: SendOptions): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(STREAM_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: opts.conversationId, message: opts.message }),
    });
  } catch {
    // Le flux n'a jamais commencé : rien n'a été lancé, on reprend l'ancien
    // chemin plutôt que de refuser un envoi qui marcherait.
    return viaAction(opts);
  }
  if (!res.ok || res.body === null) return viaAction(opts);

  let accumulated = '';
  try {
    for await (const msg of readSseMessages(res.body)) {
      if (msg.event === 'delta') {
        const text = (JSON.parse(msg.data) as { text?: unknown }).text;
        if (typeof text !== 'string') continue;
        accumulated += text;
        opts.onText(accumulated);
        continue;
      }
      if (msg.event === 'done') {
        const payload = JSON.parse(msg.data) as { reply?: unknown; streamed?: unknown };
        // La réponse entière remplace ce qui a été accumulé : si le flux a
        // sauté un fragment, c'est ici que l'écart se corrige.
        const full = typeof payload.reply === 'string' ? payload.reply : '';
        opts.onText(full);
        return { ok: true, reply: full, streamed: payload.streamed === true };
      }
      if (msg.event === 'error') {
        const error = (JSON.parse(msg.data) as { error?: unknown }).error;
        return { ok: false, message: failureMessage(typeof error === 'string' ? error : '') };
      }
    }
  } catch {
    return { ok: false, message: 'The reply was interrupted' };
  }
  // Le flux s'est terminé sans `done` : le tour n'a pas rendu de réponse.
  return { ok: false, message: 'The reply was interrupted' };
}

/** Le même vocabulaire d'erreurs que l'action serveur, en clair. */
function failureMessage(code: string): string {
  if (code === 'agent_no_llm_configured') return 'This agent has no model configured';
  if (code === 'agent_inactive') return 'This conversation’s agent is disabled.';
  if (code === 'conversation_not_found') return 'Conversation not found';
  return 'The agent did not reply';
}

/**
 * Arrêter la réponse en cours de cette conversation (#456). Le tour arrêté
 * rend son `done` par le flux déjà ouvert, avec ce qu'il avait écrit : ce
 * n'est donc PAS ici que le fil change. Ce qui revient ici dit seulement si la
 * demande est passée.
 */
export async function stopChatTurn(
  conversationId: string,
): Promise<{ ok: boolean; stopped: boolean }> {
  try {
    const res = await fetch('/api/chat/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId }),
    });
    const data = (await res.json().catch(() => null)) as { stopped?: unknown } | null;
    // `stopped: false` n'est PAS un succès (revue Codex de #459) : rien ne
    // tournait à arrêter. L'appelant le traite comme tel.
    return { ok: res.ok, stopped: res.ok && data?.stopped === true };
  } catch {
    return { ok: false, stopped: false };
  }
}
