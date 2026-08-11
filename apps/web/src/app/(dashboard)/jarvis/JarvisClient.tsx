'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Microphone, Stop, CircleNotch, SpeakerHigh, Warning } from '@phosphor-icons/react';
import { createConversationAction, sendChatMessageAction, listChatAction } from '@/lib/actions.ts';
import { startCapture, MicrophoneError, type Capture } from '@/lib/mic-capture.ts';
import {
  speakReply,
  splitForSpeech,
  stopSpeaking,
  unlockAudio,
  waitForPlaybackEnd,
  type SpeakOutcome,
} from '@/lib/speak-reply.ts';
import IconButton from '@/components/ui/IconButton';

/**
 * Voice mode — a conversation with no chat window.
 *
 * This is NOT the chat page with a microphone bolted on. The chat page is for
 * reading and writing; here there is nothing to write and nothing to click
 * between turns. You press once, and from then on: you speak, it answers out
 * loud, and it listens again. The last exchange stays on screen in small type
 * as a record of what was heard — not as something to read, since by the time
 * you finish reading it the answer has already been spoken.
 *
 * The rule that makes it hands-free is `unlockAudio()`, called synchronously on
 * the very first press. Browsers refuse a `play()` that is not tied to a user
 * gesture, and a reply lands seconds after the press — so without priming, the
 * answer cannot start by itself and the mode collapses into "click to hear what
 * you already read".
 *
 * Recording lives in `mic-capture.ts` and playback in `speak-reply.ts`; what is
 * left here is the loop and what the user sees of it.
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

/** How long to wait for the runner to write a reply before giving up. */
const REPLY_DEADLINE_MS = 60_000;

interface Props {
  agentId: string | null;
  agentName: string | null;
  hasVoice: boolean;
  /**
   * Whether the agent's voice arrives as a stream.
   *
   * It decides how the reply is spoken, and the two strategies are opposites.
   * A streaming voice takes the WHOLE reply in one request and starts sounding
   * in ~0.5 s no matter how long it is. A non-streaming one must be fed
   * sentence by sentence, because a single request for the whole answer means
   * waiting out its entire synthesis — 4 s of silence — before a word is heard.
   * Chunking a streaming voice would be strictly worse: several round trips and
   * an audible gap at every seam.
   */
  voiceStreams: boolean;
}

export default function JarvisClient({ agentId, agentName, hasVoice, voiceStreams }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  /** True while the loop should keep going: speak → answer → listen again. */
  const [live, setLive] = useState(false);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [latency, setLatency] = useState<number | null>(null);

  const conversationRef = useRef<string | null>(null);
  const captureRef = useRef<Capture | null>(null);
  /** Read by callbacks that outlive a render — `live` in state is for the UI. */
  const liveRef = useRef(false);
  /**
   * `listen` and `handleTurn` call each other — that mutual recursion IS the
   * loop. One of the two has to be reached through a ref, or the first would
   * close over a binding that does not exist yet.
   */
  const handleTurnRef = useRef<(wav: Uint8Array) => void>(() => {});
  /** Same reason, the other direction: `listen` re-arms itself. */
  const listenRef = useRef<() => void>(() => {});

  const stopEverything = useCallback(() => {
    liveRef.current = false;
    setLive(false);
    captureRef.current?.stop();
    captureRef.current = null;
    stopSpeaking();
    setPhase('idle');
  }, []);

  useEffect(() => stopEverything, [stopEverything]);

  /** Say why there is no sound. A mode whose entire purpose is sound must
   *  never fall silent without a reason on screen. */
  const outcomeFailure = useCallback(
    (outcome: SpeakOutcome) => {
      if (outcome.ok) return;
      toast.error(
        outcome.reason === 'autoplay_blocked'
          ? 'The browser blocked playback.'
          : outcome.reason === 'no_voice'
            ? 'This agent has no voice.'
            : outcome.message,
      );
      stopEverything();
    },
    [stopEverything],
  );

  /** Nothing was said — a cough, a door, a fan. Listen again rather than
   *  ending: going idle would let a noise close the conversation. */
  const nothingSaid = useCallback(() => {
    if (liveRef.current) listenRef.current();
    else setPhase('idle');
  }, []);

  // ── One turn: record until silence, then hand the bytes on ─────────────────
  const listen = useCallback(async () => {
    let capture: Capture;
    try {
      capture = await startCapture();
    } catch (err) {
      toast.error(
        err instanceof MicrophoneError ? err.message : 'The microphone could not be opened.',
      );
      stopEverything();
      return;
    }
    captureRef.current = capture;
    setPhase('listening');

    const { wav } = await capture.result;
    captureRef.current = null;
    if (!liveRef.current) return;
    if (!wav) {
      nothingSaid();
      return;
    }
    handleTurnRef.current(wav);
  }, [nothingSaid, stopEverything]);

  // ── Transcribe → send → speak the reply → listen again ────────────────────
  const handleTurn = useCallback(
    async (wav: Uint8Array) => {
      setPhase('thinking');
      setSaid('');

      // 1. What was said. WAV rather than the browser's own recording format:
      //    the transcription model refuses WebM, which is all Chrome produces.
      let text: string;
      try {
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'content-type': 'audio/wav', 'x-nodal-language': navigator.language },
          body: wav as unknown as BodyInit,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            provider?: string;
            message?: string;
          };
          toast.error(
            body.error === 'no_key_for_provider'
              ? `Add a ${body.provider ?? 'speech'} key in LLM Providers.`
              : (body.message ?? 'Transcription failed.'),
          );
          stopEverything();
          return;
        }
        text = ((await res.json()) as { text: string }).text;
      } catch {
        toast.error('Transcription failed.');
        stopEverything();
        return;
      }

      // A second net, after the recorder's. Room noise that slipped through
      // still comes back as something — an empty string, a stray "hm", or the
      // transcriber's polite note that it heard nothing. Sending that to the
      // agent is what made the loop answer questions nobody asked.
      const meaningful = text.trim().replace(/^[\s"'“”.,!?…-]+|[\s"'“”.,!?…-]+$/g, '');
      if (meaningful.length < 2) {
        nothingSaid();
        return;
      }
      setHeard(text);

      // 2. The agent's answer. Same conversation for the whole session, so the
      //    agent keeps its context from one turn to the next.
      if (!conversationRef.current) {
        const created = await createConversationAction();
        if (!created.ok) {
          toast.error(created.message);
          stopEverything();
          return;
        }
        conversationRef.current = created.data.id;
      }
      const convId = conversationRef.current;
      const sent = await sendChatMessageAction({ conversationId: convId, message: text });
      if (!sent.ok) {
        toast.error(sent.message);
        stopEverything();
        return;
      }

      // The reply is written by the runner, so it is polled for rather than
      // returned. The chat page waits two full seconds before even LOOKING,
      // which is invisible when you are reading and unbearable when you are
      // waiting to be answered. Fast at first, then backing off so a long think
      // does not hammer the DB.
      let reply = '';
      const deadline = Date.now() + REPLY_DEADLINE_MS;
      let wait = 250;
      while (!reply && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(wait * 1.4, 2_000);
        if (!liveRef.current) return;
        const thread = await listChatAction(convId);
        if (!thread.ok) continue;
        const last = thread.data.messages[thread.data.messages.length - 1];
        if (last && last.role !== 'user' && last.content.trim() !== '') reply = last.content;
      }
      if (!reply) {
        toast.error('No reply came back.');
        stopEverything();
        return;
      }

      // 3. Say it.
      if (!agentId) return;
      setPhase('speaking');

      const onFinished = (): void => {
        if (liveRef.current) listenRef.current();
        else setPhase('idle');
      };

      if (voiceStreams) {
        // One request for the whole reply: the sound starts while the rest is
        // still being synthesised, so cutting it up would only add round trips
        // and a gap at each seam.
        const spoken = await speakReply(agentId, reply, onFinished);
        if (!spoken.ok) {
          outcomeFailure(spoken);
          return;
        }
        setSaid(reply);
        setLatency(spoken.latencyMs);
        return;
      }

      // Non-streaming provider: sentence by sentence, so sound starts before
      // the whole reply has been synthesised. Asking for the entire text at
      // once meant waiting out its full 3.5–4.4 s AFTER the text had already
      // appeared — you read the answer, then heard it read back to you.
      const chunks = splitForSpeech(reply);
      let firstLatency: number | null = null;
      for (let i = 0; i < chunks.length; i++) {
        if (!liveRef.current) return;
        const isLast = i === chunks.length - 1;
        const spoken = await speakReply(agentId, chunks[i]!, isLast ? onFinished : undefined);
        if (!spoken.ok) {
          outcomeFailure(spoken);
          return;
        }
        // AFTER the audio has started, never before. Setting it beforehand put
        // the text on screen a full four seconds ahead of the voice, so the
        // answer was read before it was heard and the point of the page was
        // lost. `speakReply` resolves once playback has begun.
        setSaid(chunks.slice(0, i + 1).join(' '));
        firstLatency ??= spoken.latencyMs;
        // Wait for this chunk to finish before starting the next, or they talk
        // over each other — one player, on purpose (see speak-reply.ts).
        if (!isLast) await waitForPlaybackEnd();
      }
      setLatency(firstLatency);
    },
    [agentId, nothingSaid, outcomeFailure, stopEverything, voiceStreams],
  );

  useEffect(() => {
    handleTurnRef.current = (wav) => void handleTurn(wav);
    listenRef.current = () => void listen();
  }, [handleTurn, listen]);

  const start = useCallback(() => {
    // SYNCHRONOUS, before any await — this press is the gesture that lets every
    // later reply start on its own.
    unlockAudio();
    liveRef.current = true;
    setLive(true);
    setHeard('');
    setSaid('');
    void listen();
  }, [listen]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (!agentId) {
    return (
      <Notice>Designate a ROOT agent in Settings, then give it a voice on its Settings tab.</Notice>
    );
  }
  if (!hasVoice) {
    return (
      <Notice>
        {agentName ?? 'This agent'} has no voice yet. Open its Settings tab and pick one — voice
        mode has nothing to speak with until then.
      </Notice>
    );
  }

  const label =
    phase === 'listening'
      ? 'Listening'
      : phase === 'thinking'
        ? 'Thinking'
        : phase === 'speaking'
          ? 'Speaking'
          : 'Tap to talk';

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 px-6">
      <IconButton
        ghost
        type="button"
        onClick={() => (live ? stopEverything() : start())}
        aria-label={live ? 'Stop voice mode' : 'Start voice mode'}
        className={[
          '!size-40 !rounded-full border transition-colors',
          phase === 'listening'
            ? 'border-agent-vivid bg-agent-vivid/10 text-agent-vivid'
            : phase === 'speaking'
              ? 'border-ok bg-ok/10 text-ok'
              : phase === 'thinking'
                ? 'border-rule-2 bg-hover text-ink-3'
                : 'border-rule-2 bg-paper text-ink-3 hover:bg-hover',
        ].join(' ')}
      >
        {phase === 'listening' ? (
          <Microphone size={56} weight="fill" className="animate-pulse" />
        ) : phase === 'thinking' ? (
          <CircleNotch size={56} className="animate-spin" />
        ) : phase === 'speaking' ? (
          <SpeakerHigh size={56} weight="fill" className="animate-pulse" />
        ) : live ? (
          <Stop size={56} weight="fill" />
        ) : (
          <Microphone size={56} />
        )}
      </IconButton>

      <div className="flex flex-col items-center gap-1">
        <p className="text-title-16 text-ink">{label}</p>
        <p className="text-body-13 text-ink-4">
          {live
            ? 'Stop talking and it answers. Tap to end.'
            : `Talk to ${agentName ?? 'your agent'}`}
        </p>
      </div>

      {/* A record of the exchange, deliberately quiet: this is not something to
          read — the answer is spoken before it could be read — but seeing what
          was HEARD is how you tell a bad answer from a bad transcription. */}
      {(heard || said) && (
        <div className="w-full max-w-[560px] space-y-3 text-center">
          {heard && <p className="text-body-13 text-ink-3">“{heard}”</p>}
          {said && <p className="text-body-14 leading-[1.6]! text-ink">{said}</p>}
          {latency !== null && (
            <p className="text-legacy-11 text-ink-4">voice in {(latency / 1000).toFixed(1)}s</p>
          )}
        </div>
      )}
    </div>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <Warning size={28} className="text-ink-4" />
      <p className="max-w-[420px] text-body-14 text-ink-3">{children}</p>
    </div>
  );
}
