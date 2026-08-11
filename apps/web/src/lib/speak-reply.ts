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
