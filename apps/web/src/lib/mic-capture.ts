/**
 * Capture a spoken turn as WAV, ending it on silence.
 *
 * WHY this exists instead of MediaRecorder — the browser recorder emits
 * WebM/Opus in Chrome, and WebM is the one container the transcription model
 * refuses (probed 2026-08-11: HTTP 400, "Failed to load audio file"). Chrome
 * cannot be asked for OGG either. So the bytes are assembled here: raw samples
 * out of the AudioContext, downsampled, wrapped as WAV. That is also the only
 * form that behaves identically in every browser, rather than depending on
 * which codec the engine happens to ship.
 *
 * It replaces the AnalyserNode too, and that is a fix rather than a merge. The
 * silence detector used to read the analyser once per animation frame, so it
 * measured at whatever rate the display refreshed — and browsers throttle
 * animation frames in a background tab to roughly one per second. A turn ended
 * by silence would hang until the tab was looked at again. Here the same
 * decision is made from the audio frames themselves, on the audio clock, and
 * the tab's visibility has nothing to do with it.
 */

/** A turn longer than this is a forgotten microphone, not a sentence. */
const MAX_RECORDING_MS = 120_000;

/**
 * Silence after which the turn is considered finished.
 *
 * Pure felt latency: it is counted AFTER the last word, before anything else
 * starts, so it is added to every single turn. 900 ms was picked without
 * evidence and sits at the slow end of what conversational systems use;
 * 700 leaves an ordinary mid-sentence pause intact while giving back a fifth of
 * a second on every exchange.
 *
 * This is the number to move if turns get cut off mid-sentence — raise it — or
 * if the wait after speaking still feels long — lower it. Below roughly 500 ms
 * a natural pause before a subordinate clause starts ending turns early.
 */
const SILENCE_MS = 700;

/**
 * How much ACTUAL speech a turn needs before it counts as one.
 *
 * A fixed threshold was the bug behind the loop re-firing on its own: room
 * noise crosses any absolute floor on some machines, so the recorder decided
 * something had been said, waited out the silence, and sent a few hundred
 * milliseconds of hum to be transcribed. Requiring sustained voiced frames —
 * not one spike — is what separates a sentence from a fan.
 */
const MIN_SPEECH_MS = 400;

/** Voiced frames must beat the measured room floor by this factor. Relative,
 *  because "quiet" on a laptop in a café and in an office are different
 *  numbers, and an absolute one is wrong in both. */
const SPEECH_OVER_FLOOR = 3.5;

/** Absolute floor under which nothing is ever treated as speech, whatever the
 *  room measured — protects against a calibration taken during a silence so
 *  perfect that 3.5× it is still nothing. */
const MIN_ABSOLUTE_RMS = 0.008;

/** The first moments of a recording are spent measuring the room, not judging
 *  it. */
const CALIBRATION_MS = 350;

/**
 * Target rate for the uploaded WAV.
 *
 * 16 kHz is the rate speech recognition is built around; sending the hardware's
 * 48 kHz would triple the upload for detail no transcriber uses. WAV is
 * uncompressed, so this is the difference between ~160 kB and ~480 kB for a
 * five-second turn — on every single turn of a conversation.
 */
const TARGET_RATE = 16_000;

/**
 * The worklet. A string because it has to be loaded as its own module, and a
 * Blob URL keeps it in this file where it can be read next to the code that
 * consumes it rather than in a public/ asset nobody associates with voice.
 *
 * It does no thinking: copying the frame out and posting it is the whole job.
 * Anything more would run on the audio thread, where a slow frame is an audible
 * glitch rather than a slow function.
 */
const WORKLET_SOURCE = `
class TapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    // A disconnected or silent-by-design input yields no channel; returning
    // true keeps the node alive so recording survives a device blip.
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('nodal-tap', TapProcessor);
`;

export interface CaptureResult {
  /** null when nothing worth transcribing was said. */
  wav: Uint8Array | null;
  /** Milliseconds of frames that beat the room floor. */
  speechMs: number;
  /** Why the turn ended — surfaced so a caller can tell "you stopped talking"
   *  from "you were cut off at two minutes". */
  reason: 'silence' | 'max_duration' | 'stopped';
}

export interface Capture {
  result: Promise<CaptureResult>;
  /** End the turn now. Safe to call twice. */
  stop(): void;
}

export class MicrophoneError extends Error {
  readonly kind: 'denied' | 'missing' | 'unsupported';
  constructor(kind: 'denied' | 'missing' | 'unsupported', message: string) {
    super(message);
    this.name = 'MicrophoneError';
    this.kind = kind;
  }
}

/**
 * Average the samples falling into each output slot.
 *
 * Averaging rather than picking every Nth sample: dropping samples folds
 * everything above 8 kHz back down into the speech band as aliasing, which a
 * transcriber hears as a lisp. The average is a crude low-pass, but it is the
 * right crude one and it costs one pass.
 */
export function downsample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return input;
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(Math.floor((i + 1) * ratio), input.length);
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j]!;
    out[i] = end > start ? sum / (end - start) : 0;
  }
  return out;
}

/** Float samples in [-1, 1] to a 16-bit mono WAV. */
export function floatToWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    // Clamped before scaling: a sample above 1.0 (possible after gain) would
    // wrap around to a large negative number and click.
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
  }
  return bytes;
}

export async function startCapture(): Promise<Capture> {
  if (typeof AudioContext === 'undefined') {
    throw new MicrophoneError('unsupported', 'This browser cannot capture audio.');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      // Echo cancellation is not a nicety here: without it the agent's own
      // voice coming out of the speakers is picked straight back up, and the
      // silence detector treats the reply as the next question.
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    throw name === 'NotAllowedError' || name === 'SecurityError'
      ? new MicrophoneError(
          'denied',
          'Microphone access was refused — check the site permission in your browser.',
        )
      : new MicrophoneError('missing', 'No microphone found on this machine.');
  }

  const ctx = new AudioContext();
  const workletUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
  try {
    await ctx.audioWorklet.addModule(workletUrl);
  } finally {
    // The module is compiled by now; holding the URL would leak the blob for
    // the life of the tab, once per turn.
    URL.revokeObjectURL(workletUrl);
  }

  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'nodal-tap');
  source.connect(tap);
  // NOT connected to the destination: routing the microphone to the speakers
  // would play the user back to themselves, loudly.

  const frames: Float32Array[] = [];
  let totalSamples = 0;
  let elapsedMs = 0;
  let floorSum = 0;
  let floorCount = 0;
  let speechMs = 0;
  let quietMs = 0;
  let settled = false;

  let finish: (r: CaptureResult) => void = () => {};
  const result = new Promise<CaptureResult>((resolve) => {
    finish = resolve;
  });

  const teardown = (): void => {
    tap.port.onmessage = null;
    tap.disconnect();
    source.disconnect();
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const settle = (reason: CaptureResult['reason']): void => {
    if (settled) return;
    settled = true;
    clearTimeout(cap);
    teardown();

    // Not enough real speech: the turn was a cough, a door, or a fan. Returning
    // null rather than the bytes saves a transcription round trip whose only
    // possible answer is "nothing was said" — and, more importantly, stops that
    // noise being sent to the agent as a question.
    if (speechMs < MIN_SPEECH_MS || totalSamples === 0) {
      finish({ wav: null, speechMs, reason });
      return;
    }

    const joined = new Float32Array(totalSamples);
    let offset = 0;
    for (const f of frames) {
      joined.set(f, offset);
      offset += f.length;
    }
    const reduced = downsample(joined, ctx.sampleRate, TARGET_RATE);
    finish({
      wav: floatToWav(reduced, Math.min(ctx.sampleRate, TARGET_RATE)),
      speechMs,
      reason,
    });
  };

  const cap = setTimeout(() => settle('max_duration'), MAX_RECORDING_MS);

  tap.port.onmessage = (event: MessageEvent<Float32Array>): void => {
    if (settled) return;
    const frame = event.data;
    frames.push(frame);
    totalSamples += frame.length;

    // The frame's own length IS the elapsed time — measured on the audio clock,
    // not on a timer that a background tab can throttle.
    const frameMs = (frame.length / ctx.sampleRate) * 1000;
    elapsedMs += frameMs;

    let sum = 0;
    for (const v of frame) sum += v * v;
    const rms = Math.sqrt(sum / frame.length);

    // Measure the room first, judge afterwards.
    if (elapsedMs < CALIBRATION_MS) {
      floorSum += rms;
      floorCount += 1;
      return;
    }

    const floor = floorCount > 0 ? floorSum / floorCount : 0;
    const threshold = Math.max(floor * SPEECH_OVER_FLOOR, MIN_ABSOLUTE_RMS);
    if (rms > threshold) {
      speechMs += frameMs;
      quietMs = 0;
      return;
    }
    // The silence timer only runs once REAL speech has accumulated — the pause
    // before you begin must not end the turn.
    if (speechMs >= MIN_SPEECH_MS) {
      quietMs += frameMs;
      if (quietMs > SILENCE_MS) settle('silence');
    }
  };

  return { result, stop: () => settle('stopped') };
}
