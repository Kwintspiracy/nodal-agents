'use client';

// voice-playback.ts — la réponse DITE qui joue en ce moment (#942, #943).
//
// Une seule voix à la fois dans l'onglet, et elle survit à la navigation :
// l'écran d'une conversation neuve DEVIENT le fil qui vient de naître pendant
// que la réponse joue, et le Stop du fil doit encore l'arrêter. D'où un porteur
// au niveau du module, lu par `useSyncExternalStore`, plutôt qu'un état de
// composant qui partirait avec l'écran.
//
// Deux lecteurs : le composeur (Stop prend la place d'Envoyer) et le fil (la
// pastille « Speaking » sur la réponse qui joue).
//
// LA VOIX ARRIVE EN MORCEAUX (#943), dans l'ordre de leur rang : la route du
// tour les écrit phrase par phrase pendant que la réponse s'écrit. Ils sont
// joués BOUT À BOUT sur un seul AudioContext : chaque unité est décodée en
// échantillons, puis programmée à l'instant exact où la précédente finit —
// sans trou audible. MediaSource n'est pas utilisé. Deux unités, selon ce que
// le format permet :
//   - `audio/pcm` : des échantillons, découpables n'importe où entre deux
//     échantillons ; chaque morceau se programme dès qu'il arrive ;
//   - tout autre type (`audio/wav`, `audio/mpeg`, …) : un conteneur ou un
//     format compressé, qu'un morceau de flux ne contient pas forcément en
//     entier (une trame MP3 coupée ne se décode pas). Ses morceaux sont
//     réunis par PHRASE — un tampon par rang de phrase, jamais deux phrases
//     dans un même tampon —, et la phrase se décode (`decodeAudioData`) quand
//     la route dit qu'elle est finie (`audio_end`, `endSentence`) ET complète.
//     Une phrase finie incomplète (la voix a échoué, la phrase a été
//     abandonnée, Stop) est JETÉE : on n'en joue jamais un bout comme s'il
//     était entier. L'échec est celui de la voix, que `done.speechError` dit
//     déjà ; ce n'est pas une erreur de décodage. Un tampon dont la fin n'est
//     jamais venue (le flux coupé) n'est jamais joué non plus : la coupure se
//     dit ailleurs, comme toujours.
//   - un PCM déjà programmé reste joué : une phrase PCM incomplète s'arrête là
//     où la voix s'est arrêtée.
// Ce que le navigateur ne sait pas décoder se dit, il ne se joue pas à
// l'aveugle (invariant #4).

import { useSyncExternalStore } from 'react';

export type Speaking = { reply: string } | null;

/** Un morceau de voix, tel que la route du tour l'a numéroté. */
export type SpokenChunk = {
  seq: number;
  /** Le rang de sa phrase : les morceaux d'un type compressé se réunissent par phrase. */
  sentence: number;
  mimeType: string;
  sampleRate?: number;
  bytes: Uint8Array;
};

export interface SpokenStream {
  /** Le morceau suivant, dans l'ordre de `seq`. */
  push(chunk: SpokenChunk): void;
  /**
   * La phrase `sentence` est finie (`audio_end`). Complète, un type compressé
   * se décode et se joue ; incomplète, son tampon est jeté.
   */
  endSentence(sentence: number, complete: boolean): void;
  /** Le texte de la réponse connu à cet instant : c'est lui que « Speaking » désigne. */
  setReply(reply: string): void;
  /** Plus aucun morceau ne viendra : la voix finit quand le dernier a joué. */
  end(): void;
  /** La voix a été arrêtée (Stop, ou une autre voix) : plus rien ne joue. */
  readonly stopped: boolean;
}

/** Le délai avant le premier morceau : le temps de le programmer sans le rogner. */
const LEAD_S = 0.03;

type Playback = {
  reply: string;
  sources: Set<AudioBufferSourceNode>;
  nextAt: number;
  expected: number;
  /** Le décodage en cours : les unités se programment une par une, dans l'ordre. */
  chain: Promise<void>;
  /** Les morceaux des phrases compressées en attente de leur fin, par rang de phrase. */
  sentences: Map<number, SpokenChunk[]>;
  started: boolean;
  ended: boolean;
  dead: boolean;
};

let ctx: AudioContext | null = null;
let current: Playback | null = null;
let snapshot: Speaking = null;
const listeners = new Set<() => void>();

function emit(): void {
  const next = current?.started ? { reply: current.reply } : null;
  if (next === null && snapshot === null) return;
  if (next !== null && snapshot !== null && next.reply === snapshot.reply) return;
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function audioContext(): AudioContext {
  if (ctx === null) {
    if (typeof AudioContext !== 'function') throw new Error('this browser cannot play audio');
    ctx = new AudioContext();
  }
  // Créé après le geste de la personne (le micro tenu), il peut naître
  // suspendu : il reprend ici, sans quoi rien ne s'entendrait.
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

/** 16 bits signés little-endian, mono → les échantillons d'un AudioBuffer. */
function pcmBuffer(audio: AudioContext, bytes: Uint8Array, sampleRate: number): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = Math.floor(bytes.byteLength / 2);
  const buffer = audio.createBuffer(1, Math.max(1, n), sampleRate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < n; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
  return buffer;
}

function isPcm(mimeType: string): boolean {
  return mimeType.split(';')[0]?.trim().toLowerCase() === 'audio/pcm';
}

/** Une unité à jouer : un morceau PCM, ou la concaténation d'une phrase compressée. */
async function decode(
  audio: AudioContext,
  mimeType: string,
  bytes: Uint8Array,
  sampleRate?: number,
): Promise<AudioBuffer> {
  if (isPcm(mimeType)) {
    if (!sampleRate) throw new Error('a PCM chunk came without its sample rate');
    return pcmBuffer(audio, bytes, sampleRate);
  }
  try {
    // `decodeAudioData` détache le tampon qu'on lui donne : une copie.
    return await audio.decodeAudioData(bytes.slice().buffer);
  } catch (err) {
    throw new Error(
      `this voice could not be decoded (${mimeType}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function joined(chunks: readonly SpokenChunk[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.bytes.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c.bytes, at);
    at += c.bytes.byteLength;
  }
  return out;
}

function finishIfDone(me: Playback): void {
  if (!me.ended || me.sources.size > 0 || current !== me) return;
  current = null;
  emit();
}

function kill(me: Playback): void {
  me.dead = true;
  for (const s of me.sources) {
    try {
      s.stop();
    } catch {
      // Pas encore parti : rien à arrêter.
    }
  }
  me.sources.clear();
}

/** Arrêter la voix qui joue, s'il y en a une. */
export function stopSpeaking(): void {
  if (!current) return;
  const me = current;
  current = null;
  kill(me);
  emit();
}

/**
 * Ouvrir la voix d'une réponse. Elle prend la place de celle qui jouait.
 * `onError` : un morceau ne se joue pas (format inconnu, navigateur sans
 * Web Audio, rang manquant) — la voix s'arrête et l'écran le dit.
 */
export function startSpokenStream(opts: {
  reply: string;
  onError: (message: string) => void;
}): SpokenStream {
  stopSpeaking();
  const me: Playback = {
    reply: opts.reply,
    sources: new Set(),
    nextAt: 0,
    expected: 0,
    chain: Promise.resolve(),
    sentences: new Map(),
    started: false,
    ended: false,
    dead: false,
  };
  current = me;
  const fail = (message: string): void => {
    if (me.dead) return;
    if (current === me) stopSpeaking();
    else kill(me);
    opts.onError(message);
  };
  /** Une unité de plus, décodée puis programmée APRÈS celles d'avant. */
  const schedule = (mimeType: string, bytes: Uint8Array, sampleRate?: number): void => {
    me.chain = me.chain.then(async () => {
      if (me.dead) return;
      let buffer: AudioBuffer;
      let audio: AudioContext;
      try {
        audio = audioContext();
        buffer = await decode(audio, mimeType, bytes, sampleRate);
      } catch (err) {
        fail(err instanceof Error ? err.message : String(err));
        return;
      }
      if (me.dead) return;
      const source = audio.createBufferSource();
      source.buffer = buffer;
      source.connect(audio.destination);
      const at = Math.max(me.nextAt, audio.currentTime + LEAD_S);
      me.nextAt = at + buffer.duration;
      me.sources.add(source);
      source.onended = () => {
        me.sources.delete(source);
        finishIfDone(me);
      };
      source.start(at);
      if (!me.started) {
        me.started = true;
        emit();
      }
    });
  };
  const endSentence = (sentence: number, complete: boolean): void => {
    const chunks = me.sentences.get(sentence);
    me.sentences.delete(sentence);
    if (me.dead || !chunks || !complete) return;
    schedule(chunks[0]!.mimeType, joined(chunks));
  };
  return {
    push(chunk) {
      if (me.dead) return;
      if (chunk.seq !== me.expected) {
        fail(`voice chunk ${String(chunk.seq)} arrived where ${String(me.expected)} was expected`);
        return;
      }
      me.expected++;
      if (isPcm(chunk.mimeType)) {
        schedule(chunk.mimeType, chunk.bytes, chunk.sampleRate);
        return;
      }
      const buffer = me.sentences.get(chunk.sentence) ?? [];
      buffer.push(chunk);
      me.sentences.set(chunk.sentence, buffer);
    },
    endSentence,
    setReply(reply) {
      me.reply = reply;
      if (current === me) emit();
    },
    end() {
      // Une phrase dont la fin n'est jamais venue n'est pas jouée.
      me.sentences.clear();
      me.ended = true;
      void me.chain.then(() => finishIfDone(me));
    },
    get stopped() {
      return me.dead;
    },
  };
}

/** Ce qui joue en ce moment : la réponse dite, ou `null`. */
export function useSpeaking(): Speaking {
  return useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => null,
  );
}
