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
  | { ok: true; latencyMs: number }
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

  const latencyMs = Number(res.headers.get('x-nodal-latency-ms') ?? '0');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const audio = player ?? new Audio();
  player = audio;
  audio.volume = 1;
  audio.src = url;
  currentUrl = url;
  if (onEnded) audio.addEventListener('ended', onEnded, { once: true });

  try {
    await audio.play();
    return { ok: true, latencyMs };
  } catch {
    // Chrome blocks programmatic playback until the user has interacted with
    // the origin. Speaking a reply to a turn the user DICTATED normally
    // satisfies that, but a first-ever visit, or a reply that lands after the
    // gesture has aged out, will not.
    stopSpeaking();
    return { ok: false, reason: 'autoplay_blocked' };
  }
}
