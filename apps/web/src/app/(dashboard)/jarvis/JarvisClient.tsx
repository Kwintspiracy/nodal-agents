'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Microphone, Stop, CircleNotch, SpeakerHigh, Warning } from '@phosphor-icons/react';
import { createConversationAction, sendChatMessageAction, listChatAction } from '@/lib/actions.ts';
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
 */

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

/** A turn longer than this is a forgotten microphone, not a sentence. */
const MAX_RECORDING_MS = 120_000;

/** Silence after which the turn is considered finished. */
const SILENCE_MS = 900;
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

interface Props {
  agentId: string | null;
  agentName: string | null;
  hasVoice: boolean;
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

export default function JarvisClient({ agentId, agentName, hasVoice }: Props) {
  const [phase, setPhase] = useState<Phase>('idle');
  /** True while the loop should keep going: speak → answer → listen again. */
  const [live, setLive] = useState(false);
  const [heard, setHeard] = useState('');
  const [said, setSaid] = useState('');
  const [latency, setLatency] = useState<number | null>(null);

  const conversationRef = useRef<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const analyserRef = useRef<{ ctx: AudioContext; raf: number } | null>(null);
  /** Read by callbacks that outlive a render — `live` in state is for the UI. */
  const liveRef = useRef(false);
  /**
   * `listen` and `handleTurn` call each other — that mutual recursion IS the
   * loop. One of the two has to be reached through a ref, or the first would
   * close over a binding that does not exist yet.
   */
  const handleTurnRef = useRef<(blob: Blob) => void>(() => {});
  /** Same reason, the other direction: `listen` re-arms itself. */
  const listenRef = useRef<() => void>(() => {});

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const teardownAnalyser = useCallback(() => {
    if (analyserRef.current) {
      cancelAnimationFrame(analyserRef.current.raf);
      void analyserRef.current.ctx.close();
      analyserRef.current = null;
    }
  }, []);

  const releaseMic = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    teardownAnalyser();
    clearTimers();
  }, [clearTimers, teardownAnalyser]);

  const stopEverything = useCallback(() => {
    liveRef.current = false;
    setLive(false);
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    releaseMic();
    stopSpeaking();
    setPhase('idle');
  }, [releaseMic]);

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

  // ── One turn: record until silence, transcribe, answer, speak, repeat ──────
  const listen = useCallback(async () => {
    const mimeType = pickMimeType();
    if (!mimeType) {
      toast.error('This browser cannot record audio.');
      stopEverything();
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      toast.error(
        name === 'NotAllowedError'
          ? 'Microphone access was refused — check the site permission in your browser.'
          : 'No microphone found on this machine.',
      );
      stopEverything();
      return;
    }

    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    chunksRef.current = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: mimeType });
      releaseMic();
      // Header bytes and no speech — nothing was said. Listen again rather
      // than spending a transcription to be told the turn was empty.
      if (blob.size < 2048) {
        if (liveRef.current) listenRef.current();
        else setPhase('idle');
        return;
      }
      handleTurnRef.current(blob);
    };

    recorder.start();
    setPhase('listening');

    // ── Stop on silence ────────────────────────────────────────────────────
    // The whole point of the mode: you stop talking and it answers. Requiring a
    // second click to end the turn would put a button back between every
    // sentence, which is the thing this page exists to remove.
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const startedAt = performance.now();
    let floor = 0;
    let floorSamples = 0;
    let quietSince: number | null = null;
    let speechMs = 0;
    let lastFrame = startedAt;

    const tick = (): void => {
      const now = performance.now();
      const dt = now - lastFrame;
      lastFrame = now;

      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const rms = Math.sqrt(sum / buf.length);

      // Measure the room first, judge afterwards.
      if (now - startedAt < CALIBRATION_MS) {
        floor = (floor * floorSamples + rms) / (floorSamples + 1);
        floorSamples += 1;
      } else {
        const threshold = Math.max(floor * SPEECH_OVER_FLOOR, MIN_ABSOLUTE_RMS);
        if (rms > threshold) {
          speechMs += dt;
          quietSince = null;
        } else if (speechMs >= MIN_SPEECH_MS) {
          // The silence timer only runs once REAL speech has accumulated — the
          // pause before you begin must not end the turn, and neither must a
          // room that happens to be noisy.
          quietSince ??= now;
          if (now - quietSince > SILENCE_MS) {
            if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
            return;
          }
        }
      }
      if (analyserRef.current) analyserRef.current.raf = requestAnimationFrame(tick);
    };
    analyserRef.current = { ctx, raf: requestAnimationFrame(tick) };

    timersRef.current.push(
      setTimeout(() => {
        if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
      }, MAX_RECORDING_MS),
    );
  }, [releaseMic, stopEverything]);

  // ── Transcribe → send → speak the reply → listen again ────────────────────
  const handleTurn = useCallback(
    async (blob: Blob) => {
      setPhase('thinking');
      setSaid('');

      // 1. What was said.
      let text: string;
      try {
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: { 'content-type': blob.type, 'x-nodal-language': navigator.language },
          body: blob,
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
      // agent is what made the loop answer questions nobody asked. Listening
      // again is the right response to "nothing was said": going idle would
      // make a cough end the conversation.
      const meaningful = text.trim().replace(/^[\s"'“”.,!?…-]+|[\s"'“”.,!?…-]+$/g, '');
      if (meaningful.length < 2) {
        if (liveRef.current) listenRef.current();
        else setPhase('idle');
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
      // waiting to be answered — a short reply was costing 2 s of pure delay.
      // Fast at first, then backing off so a long think does not hammer the DB.
      let reply = '';
      const deadline = Date.now() + 60_000;
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

      // 3. Say it — sentence by sentence, so sound starts before the whole
      //    reply has been synthesised. Speaking the entire text as one request
      //    meant waiting out its full 3.5–4.4 s AFTER the text had already
      //    appeared: you read the answer, then heard it read back to you.
      if (!agentId) return;
      setPhase('speaking');
      const chunks = splitForSpeech(reply);
      let firstLatency: number | null = null;
      for (let i = 0; i < chunks.length; i++) {
        if (!liveRef.current) return;
        const isLast = i === chunks.length - 1;
        // The text appears AS it is spoken, never before — the point of this
        // page is to be answered, not to be given something to read.
        setSaid(chunks.slice(0, i + 1).join(' '));
        const spoken = await new Promise<SpeakOutcome>((resolve) => {
          void speakReply(agentId, chunks[i]!, () => {
            if (isLast) {
              if (liveRef.current) listenRef.current();
              else setPhase('idle');
            }
          }).then(resolve);
        });
        if (!spoken.ok) {
          outcomeFailure(spoken);
          return;
        }
        firstLatency ??= spoken.latencyMs;
        // Wait for this chunk to finish before starting the next, or they talk
        // over each other — one player, on purpose (see speak-reply.ts).
        if (!isLast) await waitForPlaybackEnd();
      }
      setLatency(firstLatency);
    },
    [agentId, outcomeFailure, stopEverything],
  );

  useEffect(() => {
    handleTurnRef.current = (blob) => void handleTurn(blob);
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
