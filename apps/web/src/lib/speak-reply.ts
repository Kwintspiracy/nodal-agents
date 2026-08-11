/**
 * Play an agent's reply out loud.
 *
 * Lives outside the chat component because two things need it and neither owns
 * it: the automatic read-back after a spoken turn, and the speaker button on an
 * individual message.
 *
 * One player at a time, module-scoped. Two replies arriving close together used
 * to talk over each other in every naive implementation of this; the second one
 * stopping the first is the only behaviour that sounds like a conversation.
 */

/**
 * ONE element, reused for every reply.
 *
 * This is what makes hands-free playback possible at all. Browsers refuse a
 * `play()` that is not connected to a user gesture — and a reply arrives
 * several seconds after the click that asked for it, so a freshly created
 * element is always refused. An element that was played ONCE during a real
 * gesture stays playable afterwards, so `unlockAudio()` primes this one on the
 * click and every later reply reuses it.
 *
 * Without that, the voice mode degrades to "click the speaker to hear the
 * answer you have already finished reading" — which is not a voice mode.
 */
let player: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
let unlocked = false;

/** A one-sample silent WAV. Playing it costs nothing and is inaudible. */
const SILENCE =
  'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';

/**
 * Call this SYNCHRONOUSLY from a click handler, before any await.
 *
 * Safe to call repeatedly; only the first call does anything.
 */
export function unlockAudio(): void {
  if (unlocked) return;
  const a = new Audio(SILENCE);
  a.volume = 0;
  void a
    .play()
    .then(() => {
      unlocked = true;
      player = a;
    })
    .catch(() => {
      // Refused even during a gesture (rare — an OS-level mute, a policy).
      // Playback will fall back to the on-demand control.
    });
}

/** Raised when the browser refuses to start audio. Distinguished from a real
 *  failure because the answer is a play button, not an error. */
class AutoplayBlocked extends Error {}

/** Can this browser play the streamed container through Media Source?
 *
 *  Checked rather than assumed: Safari exposes ManagedMediaSource instead, and
 *  a page that assumed MediaSource would silently play nothing there — the
 *  worst possible failure for a feature whose entire output is sound. */
function canStream(mimeType: string): boolean {
  return (
    typeof MediaSource !== 'undefined' && mimeType !== '' && MediaSource.isTypeSupported(mimeType)
  );
}

/**
 * Feed a fetch stream into the player and start it at the first chunk.
 *
 * Returns the milliseconds until sound actually began — the only latency figure
 * worth showing, since it is the one the user lives through.
 */
async function playStream(
  audio: HTMLAudioElement,
  body: ReadableStream<Uint8Array>,
  mimeType: string,
  startedAt: number,
): Promise<number> {
  const mediaSource = new MediaSource();
  const url = URL.createObjectURL(mediaSource);
  audio.src = url;
  currentUrl = url;

  await new Promise<void>((resolve) => {
    mediaSource.addEventListener('sourceopen', () => resolve(), { once: true });
  });
  const buffer = mediaSource.addSourceBuffer(mimeType);

  /** Appends are serialised: `appendBuffer` throws InvalidStateError if the
   *  previous one has not finished, and the frames arrive faster than they are
   *  consumed. */
  const append = (bytes: Uint8Array): Promise<void> =>
    new Promise((resolve, reject) => {
      buffer.addEventListener('updateend', () => resolve(), { once: true });
      buffer.addEventListener('error', () => reject(new Error('audio buffer rejected a chunk')), {
        once: true,
      });
      buffer.appendBuffer(bytes as unknown as ArrayBufferView<ArrayBuffer>);
    });

  const reader = body.getReader();
  let started = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value.length) continue;
      await append(value);
      if (started === 0) {
        // Playback begins on the FIRST chunk — waiting for a comfortable buffer
        // would hand back the very delay this path exists to remove. If the
        // network stalls mid-reply the element simply waits, which is what it
        // is built to do.
        try {
          await audio.play();
        } catch {
          throw new AutoplayBlocked('playback refused without a user gesture');
        }
        started = Date.now() - startedAt;
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (mediaSource.readyState === 'open') {
    // Without this the element never fires `ended`, so a hands-free loop would
    // wait for ever instead of listening again.
    if (buffer.updating) {
      await new Promise<void>((r) =>
        buffer.addEventListener('updateend', () => r(), { once: true }),
      );
    }
    mediaSource.endOfStream();
  }

  if (started === 0) throw new Error('the reply carried no audio');
  return started;
}

/** Stop whatever is speaking and release its blob. */
export function stopSpeaking(): void {
  if (player) {
    player.pause();
    // The element is KEPT — throwing it away would throw away its unlocked
    // state with it, and the next reply would be refused again.
    player.removeAttribute('src');
    player.load();
  }
  if (currentUrl) {
    // Not revoking leaks the decoded audio for the life of the tab — a few
    // hundred kB per reply, in a page people leave open all day.
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export type SpeakOutcome =
  | { ok: true; latencyMs: number; streamed: boolean }
  /** The browser refused to start audio without a fresh user gesture. Not an
   *  error to shout about — the caller offers a play button instead. */
  | { ok: false; reason: 'autoplay_blocked' }
  | { ok: false; reason: 'no_voice' }
  | { ok: false; reason: 'failed'; message: string };

/**
 * Synthesise `text` in `agentId`'s voice and play it.
 *
 * Returns rather than throws: every caller here has a sensible fallback, and a
 * reply that could not be spoken must never lose the reply.
 */
/**
 * Cut a reply into speakable chunks, so the FIRST sound arrives sooner.
 *
 * Synthesis cost is roughly proportional to length: the whole reply took 3.5–4.4 s
 * to come back, a first sentence takes a fraction of that. Speaking sentence by
 * sentence while the next one is being synthesised is the difference between
 * "wait, then hear everything" and "it starts answering".
 *
 * Chunks are merged up to a floor because one-word sentences ("Oui.") cost a
 * whole round trip each and arrive as stutter.
 */
/**
 * Resolve when whatever is playing has finished (or immediately if nothing is).
 *
 * Needed because the reply is spoken in chunks through ONE element: starting
 * the next chunk before the current one ends would cut it off mid-word.
 */
export function waitForPlaybackEnd(): Promise<void> {
  const el = player;
  if (!el || el.paused || el.ended) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => resolve();
    el.addEventListener('ended', done, { once: true });
    el.addEventListener('pause', done, { once: true });
  });
}

export function splitForSpeech(text: string, minChars = 90): string[] {
  const pieces = text
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?…:])\s+/)
    .filter((p) => p.trim() !== '');
  const out: string[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length < minChars) out[out.length - 1] = `${last} ${piece}`;
    else out.push(piece);
  }
  return out;
}

export async function speakReply(
  agentId: string,
  text: string,
  /** Fired when the audio finishes. The hands-free loop uses it to listen
   *  again — the agent stops talking, the microphone opens. */
  onEnded?: () => void,
): Promise<SpeakOutcome> {
  stopSpeaking();
  // Timed from BEFORE the request: what the user experiences as the wait is the
  // gap between finishing their sentence and hearing anything, and that
  // includes the round trip. Timing only the vendor would flatter the number.
  const startedAt = Date.now();

  let res: Response;
  try {
    res = await fetch('/api/voice/speak', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, agentId }),
    });
  } catch (err) {
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : 'network' };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
    if (body.error === 'agent_has_no_voice') return { ok: false, reason: 'no_voice' };
    return { ok: false, reason: 'failed', message: body.message ?? body.error ?? 'speech failed' };
  }

  const audio = player ?? new Audio();
  player = audio;
  audio.volume = 1;
  if (onEnded) audio.addEventListener('ended', onEnded, { once: true });

  // ── Streaming path ────────────────────────────────────────────────────────
  // The reply is played WHILE it is being synthesised. This is the difference
  // the whole feature turns on: a finished file means 4.0 s of silence before
  // any sound, and the first frames of a stream arrive in ~0.5 s regardless of
  // how long the answer is.
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]?.trim() ?? '';
  if (res.headers.get('x-nodal-stream') === '1' && res.body && canStream(contentType)) {
    try {
      const latencyMs = await playStream(audio, res.body, contentType, startedAt);
      return { ok: true, latencyMs, streamed: true };
    } catch (err) {
      stopSpeaking();
      if (err instanceof AutoplayBlocked) return { ok: false, reason: 'autoplay_blocked' };
      return {
        ok: false,
        reason: 'failed',
        message: err instanceof Error ? err.message : 'playback failed',
      };
    }
  }

  // ── One-shot path ─────────────────────────────────────────────────────────
  // Providers that cannot stream, and browsers without Media Source (Safari
  // exposes a different one). Correct, just slower — never a silent failure.
  const latencyMs = Number(res.headers.get('x-nodal-latency-ms') ?? '0');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  audio.src = url;
  currentUrl = url;

  try {
    await audio.play();
    return { ok: true, latencyMs, streamed: false };
  } catch {
    // Chrome blocks programmatic playback until the user has interacted with
    // the origin. Speaking a reply to a turn the user DICTATED normally
    // satisfies that, but a first-ever visit, or a reply that lands after the
    // gesture has aged out, will not.
    stopSpeaking();
    return { ok: false, reason: 'autoplay_blocked' };
  }
}
