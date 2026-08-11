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

let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Stop whatever is speaking and release its blob. */
export function stopSpeaking(): void {
  if (current) {
    current.pause();
    current.src = '';
    current = null;
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
export async function speakReply(agentId: string, text: string): Promise<SpeakOutcome> {
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
  const audio = new Audio(url);
  current = audio;
  currentUrl = url;
  audio.addEventListener('ended', stopSpeaking, { once: true });

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
