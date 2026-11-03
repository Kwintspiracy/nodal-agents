// mic-capture.ts — le micro du navigateur, en PCM brut, par morceaux (#942).
//
// Repris du prototype d'août (tag `archive/feat/voice-mode`), avec deux
// changements : le tour ne finit plus sur un silence (c'est le bouton relâché
// qui le finit, push-to-talk), et l'audio sort PENDANT la prise, par morceaux,
// au lieu d'un fichier entier à la fin.
//
// POURQUOI PAS MediaRecorder : l'enregistreur du navigateur sort du WebM/Opus
// sous Chrome, et WebM est le seul conteneur que le modèle de transcription
// refuse (sondé le 11/08/2026 : HTTP 400, « Failed to load audio file ») ;
// Chrome ne sait pas non plus produire d'OGG. Les octets sont donc assemblés
// ici : les échantillons bruts de l'AudioContext, sous-échantillonnés à
// 16 kHz, en entiers 16 bits little-endian, mono — le `audio/pcm` du
// protocole (apps/runner/src/chat/voice-utterances.ts). C'est aussi la seule
// forme qui se comporte pareil dans tous les navigateurs.
//
// Le niveau du micro est mesuré sur les mêmes trames, sur l'horloge audio :
// un onglet en arrière-plan ralentit les images d'animation, pas l'audio.

/** La fréquence envoyée : celle autour de laquelle la reconnaissance est faite.
 *  48 kHz triplerait l'envoi pour un détail qu'aucun transcripteur n'écoute. */
export const TARGET_RATE = 16_000;

/** Un morceau part toutes les ~250 ms : assez souvent pour que l'audio soit
 *  déjà au runner quand le bouton est relâché, assez peu pour ne pas faire
 *  une requête par trame. */
const CHUNK_MS = 250;

/** Le niveau est rendu au plus toutes les ~80 ms : l'écran n'a pas besoin des
 *  375 trames par seconde de l'AudioWorklet. */
const LEVEL_MS = 80;

/**
 * Le worklet : une chaîne, parce qu'il se charge comme son propre module, et
 * qu'une URL de Blob le garde ici, à côté du code qui le lit. Il ne pense pas :
 * copier la trame et la poster est tout son travail — sur le fil audio, une
 * trame lente est un craquement, pas une fonction lente.
 */
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('nodal-tap', TapProcessor);
`;

export class MicrophoneError extends Error {
  readonly kind: 'denied' | 'missing' | 'unsupported';
  constructor(kind: 'denied' | 'missing' | 'unsupported', message: string) {
    super(message);
    this.name = 'MicrophoneError';
    this.kind = kind;
  }
}

/**
 * Un sous-échantillonneur EN CONTINU, par moyenne. La moyenne plutôt qu'un
 * échantillon sur N : en jeter repliait tout ce qui dépasse 8 kHz dans la
 * bande de la voix, ce qu'un transcripteur entend comme un zézaiement. Les
 * échantillons qui ne remplissent pas une case de sortie attendent le morceau
 * suivant : la coupe en morceaux ne perd rien.
 */
export function createDownsampler(
  fromRate: number,
  toRate: number,
): (input: Float32Array) => Float32Array {
  if (fromRate <= toRate) return (input) => input;
  const ratio = fromRate / toRate;
  let carry = new Float32Array(0);
  return (input) => {
    const joined = new Float32Array(carry.length + input.length);
    joined.set(carry, 0);
    joined.set(input, carry.length);
    const n = Math.floor(joined.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), joined.length);
      let sum = 0;
      for (let j = start; j < end; j++) sum += joined[j]!;
      out[i] = end > start ? sum / (end - start) : 0;
    }
    carry = joined.slice(Math.floor(n * ratio));
    return out;
  };
}

/** Des échantillons flottants dans [-1, 1] en PCM 16 bits signé little-endian. */
export function floatToPcm16(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    // Borné avant la mise à l'échelle : au-delà de 1.0, l'entier déborde et claque.
    const s = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

export interface PcmCapture {
  /** La fréquence des échantillons envoyés — à annoncer au runner. */
  readonly sampleRate: number;
  /** Fin de la prise : le reste part en un dernier morceau, puis le micro est rendu. */
  stop(): void;
}

export async function startPcmCapture(handlers: {
  /** Un morceau de PCM 16 bits, dans l'ordre de la prise. */
  onChunk: (pcm: Uint8Array) => void;
  /** Le niveau du micro, entre 0 et 1 (RMS de la fenêtre écoulée). */
  onLevel: (level: number) => void;
}): Promise<PcmCapture> {
  if (typeof AudioContext === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    throw new MicrophoneError(
      'unsupported',
      window.isSecureContext
        ? 'This browser cannot capture audio.'
        : 'The microphone needs HTTPS. It works on this machine, not over the local network.',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // L'annulation d'écho n'est pas un luxe : sans elle, la voix de l'agent
      // sortie des haut-parleurs rentre dans le micro.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw name === 'NotAllowedError' || name === 'SecurityError'
      ? new MicrophoneError('denied', 'Microphone access was refused.')
      : new MicrophoneError('missing', 'No microphone found on this machine.');
  }

  const ctx = new AudioContext();
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
    throw err;
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'nodal-tap');
  source.connect(tap);
  // PAS relié à la sortie : la personne s'entendrait elle-même, fort.

  const sampleRate = Math.min(ctx.sampleRate, TARGET_RATE);
  const downsample = createDownsampler(ctx.sampleRate, TARGET_RATE);
  const chunkSamples = Math.round((ctx.sampleRate * CHUNK_MS) / 1000);
  const levelSamples = Math.round((ctx.sampleRate * LEVEL_MS) / 1000);
  let frames: Float32Array[] = [];
  let pending = 0;
  let levelSum = 0;
  let levelCount = 0;
  let stopped = false;

  const flush = (): void => {
    if (pending === 0) return;
    const joined = new Float32Array(pending);
    let at = 0;
    for (const f of frames) {
      joined.set(f, at);
      at += f.length;
    }
    frames = [];
    pending = 0;
    const out = downsample(joined);
    if (out.length > 0) handlers.onChunk(floatToPcm16(out));
  };

  tap.port.onmessage = (event: MessageEvent<Float32Array>): void => {
    if (stopped) return;
    const frame = event.data;
    frames.push(frame);
    pending += frame.length;
    for (const v of frame) levelSum += v * v;
    levelCount += frame.length;
    if (levelCount >= levelSamples) {
      handlers.onLevel(Math.sqrt(levelSum / levelCount));
      levelSum = 0;
      levelCount = 0;
    }
    if (pending >= chunkSamples) flush();
  };

  return {
    sampleRate,
    stop: () => {
      if (stopped) return;
      stopped = true;
      tap.port.onmessage = null;
      flush();
      tap.disconnect();
      source.disconnect();
      // Le micro rendu : sinon le voyant d'enregistrement du navigateur reste allumé.
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close();
    },
  };
}
