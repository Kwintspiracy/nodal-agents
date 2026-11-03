// chat/voice-utterances.ts — l'audio d'un tour vocal, reçu par morceaux (#941).
//
// Le geste `say` du protocole des modules (#947) : start, des morceaux, end —
// l'audio envoyé PENDANT que le bouton est tenu, jamais un fichier déposé
// d'un bloc. Le transport est du HTTP simple, trois requêtes sur un même
// identifiant de tour, pour deux raisons :
//
//   - un corps de requête en flux ne traverse ni un navigateur (aucun ne sait
//     envoyer un corps en flux sur HTTP/1.1) ni le proxy du tableau de bord,
//     alors qu'une requête par morceau passe partout, `/api/chat/stream`
//     compris ;
//   - un client de vingt lignes n'a qu'à faire trois POST : un module sans
//     bibliothèque HTTP particulière y arrive aussi.
//
// Chaque morceau porte son rang (`seq`, à partir de 0). Un morceau hors rang
// est REFUSÉ, jamais rangé à sa place supposée ni ajouté au bout : un audio
// remis dans le désordre se transcrit en phrase fausse, en silence
// (invariant #4).
//
// Le tour vit en mémoire du runner, comme la file des tours et le Stop
// (`turn-lane.ts`, `turn-stop.ts`) : un seul processus, et un tour abandonné
// (le module coupé en plein geste) se défait seul après `VOICE_LIMITS.idleMs`.

import { randomUUID } from 'node:crypto';

/**
 * Ce que le client envoie. `audio/pcm` : des échantillons bruts, 16 bits
 * signés little-endian, mono, au `sampleRate` annoncé — la forme la plus
 * simple pour un module, et celle que le navigateur produit déjà (il capte le
 * PCM de son AudioContext, faute de WebM accepté par la transcription,
 * packages/speech/src/providers/openrouter.ts). `audio/wav` : un conteneur
 * dont l'en-tête porte son propre format.
 *
 * Deux formats seulement, parce que la durée du message dit est un fait
 * rangé (`chat_messages.spoken_ms`) : elle se lit sur ces deux formes sans
 * décodeur, et sur aucune forme compressée.
 */
export type VoiceFormat = { kind: 'audio/pcm'; sampleRate: number } | { kind: 'audio/wav' };

export const VOICE_FORMATS = ['audio/pcm', 'audio/wav'] as const;

export const VOICE_LIMITS = {
  /** 16 Mio : plus de huit minutes de PCM 16 kHz, plus de deux à 48 kHz. Un
   *  bouton tenu plus longtemps est un micro oublié, pas une phrase. */
  maxBytes: 16 * 1024 * 1024,
  /** Sans morceau ni fin pendant ce temps, le tour est abandonné. */
  idleMs: 60_000,
  /** Des tours ouverts en même temps, tous clients confondus. */
  maxOpen: 64,
} as const;

export interface VoiceUtterance {
  readonly id: string;
  readonly entityId: string;
  readonly conversationId: string;
  readonly agentId: string;
  readonly format: VoiceFormat;
  readonly chunks: Uint8Array[];
  bytes: number;
  nextSeq: number;
  timer: ReturnType<typeof setTimeout>;
}

const open = new Map<string, VoiceUtterance>();

function armIdle(id: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => open.delete(id), VOICE_LIMITS.idleMs);
  // Un tour en attente ne retient pas le processus à l'arrêt.
  timer.unref?.();
  return timer;
}

export function openUtterance(input: {
  entityId: string;
  conversationId: string;
  agentId: string;
  format: VoiceFormat;
}): { ok: true; id: string } | { ok: false; error: 'too_many_open_turns' } {
  if (open.size >= VOICE_LIMITS.maxOpen) return { ok: false, error: 'too_many_open_turns' };
  const id = randomUUID();
  open.set(id, { id, ...input, chunks: [], bytes: 0, nextSeq: 0, timer: armIdle(id) });
  return { ok: true, id };
}

/** Le tour ouvert `id`, sans le retirer : la porte vérifie à qui il appartient. */
export function peekUtterance(id: string): VoiceUtterance | undefined {
  return open.get(id);
}

export function appendChunk(
  id: string,
  seq: number,
  bytes: Uint8Array,
):
  | { ok: true; received: number }
  | { ok: false; error: 'turn_not_found' | 'chunk_out_of_order' | 'audio_too_long' } {
  const u = open.get(id);
  if (!u) return { ok: false, error: 'turn_not_found' };
  if (seq !== u.nextSeq) return { ok: false, error: 'chunk_out_of_order' };
  if (u.bytes + bytes.length > VOICE_LIMITS.maxBytes) {
    // Le tour entier part : la moitié d'une phrase ne doit pas devenir un message.
    cancelUtterance(id);
    return { ok: false, error: 'audio_too_long' };
  }
  u.chunks.push(bytes);
  u.bytes += bytes.length;
  u.nextSeq += 1;
  clearTimeout(u.timer);
  u.timer = armIdle(id);
  return { ok: true, received: u.bytes };
}

/** Ferme le tour et rend son audio : un second `end` ne trouve plus rien. */
export function takeUtterance(id: string): VoiceUtterance | undefined {
  const u = open.get(id);
  if (!u) return undefined;
  clearTimeout(u.timer);
  open.delete(id);
  return u;
}

/** Le geste `cancel` (#947) : l'audio reçu est jeté, rien n'est transcrit. */
export function cancelUtterance(id: string): boolean {
  return takeUtterance(id) !== undefined;
}

/** Combien de tours vocaux sont ouverts (tests). */
export function openUtterances(): number {
  return open.size;
}
