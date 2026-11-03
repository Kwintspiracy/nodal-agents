// chat/voice-speech.ts — une réponse dite phrase par phrase, dans l'ordre (#943).
//
// Le tour vocal donne ici les phrases de la réponse à mesure que le modèle les
// écrit (le découpage est `createSentenceChunker`, packages/speech). Chaque
// phrase part en voix dès qu'elle arrive ; la suivante peut partir pendant que
// la précédente est encore chez le fournisseur — deux à la fois au plus —,
// mais les morceaux d'audio sortent STRICTEMENT dans l'ordre des phrases, et
// dans l'ordre où le fournisseur les a produits au sein d'une phrase.
//
// Deux formes de voix, choisies par le fait que l'adaptateur déclare, jamais
// par son nom :
//   - `capabilities.streamOutput` : les octets passent à mesure qu'ils
//     arrivent (`synthesizeStream`), dans le format que l'adaptateur déclare ;
//   - sinon, le fichier entier de chaque phrase (`synthesize`) est un morceau.
//
// Une voix en échec arrête la voix, pas la réponse : le texte continue, et
// l'échec est rendu (`done`) pour que l'écran ou le module le dise. Rien n'est
// sauté en silence : une phrase manquante au milieu d'une réponse dite la
// rendrait fausse sans que personne le sache.

import { SpeechError, type AudioMimeType, type BoundSpeech } from '@nodal-agents/speech';

export interface SpokenChunk {
  /** Le rang du morceau dans la réponse, à partir de 0, sans trou. */
  seq: number;
  mimeType: AudioMimeType;
  /** Présent pour `audio/pcm` : des échantillons bruts ne disent pas leur fréquence. */
  sampleRate?: number;
  audio: Uint8Array;
}

export interface SpeechFailure {
  code: string;
  detail?: string;
}

export interface ReplySpeech {
  /** Une phrase de plus, à dire après les précédentes. */
  say(sentence: string): void;
  /** Plus aucune phrase ne viendra : `done` se tient quand la dernière est dite. */
  end(): void;
  /**
   * Les phrases pas encore dites (même à moitié) sont abandonnées, et la voix
   * reprend sur celles qui suivent. Ce qui est déjà sorti reste sorti : un son
   * ne se reprend pas.
   */
  reset(): void;
  /** La voix se tait : plus rien ne sort, plus rien ne part au fournisseur. */
  cancel(): void;
  /** Tenue quand tout est dit, ou à l'arrêt. `null` : aucun échec. */
  readonly done: Promise<SpeechFailure | null>;
}

interface Job {
  /** Le rang de la phrase dans la réponse. */
  index: number;
  text: string;
  started: boolean;
  finished: boolean;
  abandoned: boolean;
  chunks: Array<{ audio: Uint8Array; mimeType: AudioMimeType; sampleRate?: number }>;
  error: unknown;
}

/** Combien de phrases peuvent être chez le fournisseur en même temps. */
export const SPEECH_IN_FLIGHT = 2;

function failureOf(err: unknown): SpeechFailure {
  return {
    code: err instanceof SpeechError ? err.code : 'speech_failed',
    detail: err instanceof Error ? err.message : String(err),
  };
}

/**
 * Ce que le fournisseur a fait d'une phrase, pour la mesure (#943) : son
 * premier octet, puis la fin de sa réponse. Les deux instants séparés disent
 * si la voix arrive en flux (le premier bien avant la fin) ou en fichier
 * (les deux ensemble). Une voix qui ne sait que rendre un fichier entier les
 * dit au même instant : elle ne laisse rien voir de plus.
 */
export type VendorEvent = 'firstByte' | 'complete';

export function createReplySpeech(opts: {
  speech: BoundSpeech;
  /** The model and the voice: the workspace's voice setting (#969), never a default. */
  model: string;
  voiceId: string;
  onChunk: (chunk: SpokenChunk) => void;
  /**
   * Tout l'audio de la phrase `sentence` est sorti. Un lecteur qui ne sait
   * décoder qu'une unité entière (un MP3 n'est pas découpable n'importe où,
   * contrairement à des échantillons PCM) attend ce signal pour la jouer.
   */
  onSentenceEnd?: (sentence: number) => void;
  onVendor?: (event: VendorEvent, sentence: number) => void;
  inFlight?: number;
}): ReplySpeech {
  const { speech, model, voiceId, onChunk } = opts;
  const inFlight = opts.inFlight ?? SPEECH_IN_FLIGHT;
  const stream = speech.capabilities.streamOutput && speech.synthesizeStream ? speech : null;
  const jobs: Job[] = [];
  let head = 0;
  let ended = false;
  let cancelled = false;
  let seq = 0;
  let said = 0;

  // Un réveil qui ne se perd pas : un `notify` avant l'attente compte.
  let dirty = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    dirty = true;
    const w = wake;
    wake = null;
    w?.();
  };
  const changed = (): Promise<void> => {
    if (dirty) {
      dirty = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      wake = () => {
        dirty = false;
        resolve();
      };
    });
  };

  const run = async (job: Job): Promise<void> => {
    try {
      if (stream) {
        const mimeType = stream.capabilities.streamOutput!;
        let first = true;
        for await (const piece of stream.synthesizeStream!({ text: job.text, model, voiceId })) {
          if (job.abandoned || cancelled) return;
          if (first) opts.onVendor?.('firstByte', job.index);
          first = false;
          // La fréquence est celle de la RÉPONSE, portée avec ses octets.
          job.chunks.push({
            audio: piece.audio,
            mimeType,
            ...(piece.sampleRate !== undefined ? { sampleRate: piece.sampleRate } : {}),
          });
          notify();
        }
        opts.onVendor?.('complete', job.index);
      } else {
        const out = await speech.synthesize({ text: job.text, model, voiceId });
        opts.onVendor?.('firstByte', job.index);
        opts.onVendor?.('complete', job.index);
        job.chunks.push({
          audio: out.audio,
          mimeType: out.mimeType,
          ...(out.sampleRate !== undefined ? { sampleRate: out.sampleRate } : {}),
        });
      }
    } catch (err) {
      job.error = err;
    } finally {
      job.finished = true;
      notify();
    }
  };

  const startJobs = (): void => {
    if (cancelled) return;
    for (let i = head; i < Math.min(jobs.length, head + inFlight); i++) {
      const job = jobs[i]!;
      if (job.started) continue;
      job.started = true;
      void run(job);
    }
  };

  const done = (async (): Promise<SpeechFailure | null> => {
    for (;;) {
      if (cancelled) return null;
      const job = jobs[head];
      if (!job) {
        if (ended) return null;
        await changed();
        continue;
      }
      startJobs();
      while (job.chunks.length > 0 && !cancelled && !job.abandoned) {
        const c = job.chunks.shift()!;
        onChunk({ seq: seq++, ...c });
      }
      if (job.abandoned) continue;
      if (job.error !== null && job.error !== undefined) {
        // La voix s'arrête ici : les phrases suivantes ne partent plus.
        cancelled = true;
        for (const j of jobs) j.abandoned = true;
        return failureOf(job.error);
      }
      if (job.finished) {
        opts.onSentenceEnd?.(job.index);
        head++;
        continue;
      }
      await changed();
    }
  })();

  return {
    say(sentence) {
      if (cancelled || ended) return;
      jobs.push({
        index: said++,
        text: sentence,
        started: false,
        finished: false,
        abandoned: false,
        chunks: [],
        error: undefined,
      });
      startJobs();
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    reset() {
      for (let i = head; i < jobs.length; i++) jobs[i]!.abandoned = true;
      jobs.splice(head);
      notify();
    },
    cancel() {
      cancelled = true;
      for (const j of jobs) j.abandoned = true;
      notify();
    },
    done,
  };
}
