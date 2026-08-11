'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Microphone, Stop, CircleNotch } from '@phosphor-icons/react';
import { toast } from 'sonner';
import IconButton from '@/components/ui/IconButton';

/**
 * Record a turn, transcribe it, hand back the text.
 *
 * Click to start, click again to stop — not hold-to-talk. Holding reads well in
 * a plan and behaves badly in a browser: a pointer that leaves the button, a
 * context menu, or a phone's long-press selection all end the gesture without
 * ending the recording, and none of it is reachable from a keyboard. Every
 * messaging app settled on click/click for the same reasons.
 *
 * The component owns the microphone and nothing else. It does not send the
 * message, does not know about agents, and does not clear the composer: it
 * returns text, and the caller decides. That is what lets the same button serve
 * the chat composer today and any other field later.
 */

/** What the browser will let us record, most compact first. `audio/webm` is
 *  Chromium's; `audio/ogg` is Firefox's. The server states what it accepts and
 *  rejects the rest with a 415, so this list only has to cover what browsers
 *  emit — the arbitration lives on the server, in one place. */
const PREFERRED_TYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

/** Stop after this long. A recorder left running by a forgotten click uploads
 *  a whole meeting to a paid transcription API. Two minutes is far past any
 *  chat turn and far short of an accident that matters. */
const MAX_RECORDING_MS = 120_000;

type State = 'idle' | 'recording' | 'transcribing';

interface Props {
  /** Called with the transcript. The caller decides what to do with it. */
  onTranscript: (text: string) => void;
  /** BCP-47 hint passed to the provider; improves short utterances. */
  language?: string;
  disabled?: boolean;
}

function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return PREFERRED_TYPES.find((t) => MediaRecorder.isTypeSupported(t)) ?? null;
}

/** Never fires: microphone support does not change during a page's life. */
function subscribeNever(): () => void {
  return () => {};
}

/**
 * Why the microphone is unavailable, or null when it is.
 *
 * `getUserMedia` only exists on a SECURE ORIGIN. `http://localhost` counts as
 * one, so this works on the machine running Nodal — and `http://192.168.x.x`
 * does not, so it will NOT work from a phone on the same Wi-Fi, which is
 * exactly how LAN mode is used. Naming that case is the point: the alternative
 * is a user tapping a dead button and concluding the feature is broken.
 *
 * Read through `useSyncExternalStore` rather than set from an effect: it is a
 * browser fact, not component state, and the server has no answer for it.
 * Returning literal strings keeps the snapshot referentially stable.
 */
function detectUnsupportedReason(): string | null {
  if (!navigator.mediaDevices?.getUserMedia) {
    return window.isSecureContext
      ? 'This browser has no microphone API.'
      : 'The microphone needs HTTPS. It works on this machine, not over the local network.';
  }
  if (!pickMimeType()) return 'This browser cannot record audio.';
  return null;
}

export default function VoiceInputButton({ onTranscript, language, disabled }: Props) {
  const [state, setState] = useState<State>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const unsupportedReason = useSyncExternalStore(
    subscribeNever,
    detectUnsupportedReason,
    // The server cannot know. Rendering "available" there and correcting on
    // hydration is the right way round: the button is enabled for the large
    // majority who can use it, and only the minority sees it turn to
    // "unavailable" — the reverse would flash a disabled control at everyone.
    () => null,
  );

  /** Release the microphone. Skipping this leaves the browser's recording
   *  indicator lit and the device held — visible, alarming, and ours. */
  const releaseTracks = useCallback(() => {
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    recorderRef.current = null;
    if (stopTimerRef.current) {
      clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
  }, []);

  // A component unmounted mid-recording (navigating away) must not keep the
  // microphone open.
  useEffect(() => releaseTracks, [releaseTracks]);

  const send = useCallback(
    async (blob: Blob) => {
      setState('transcribing');
      try {
        const res = await fetch('/api/voice/transcribe', {
          method: 'POST',
          headers: {
            // The recorder's own type, codec parameters included — the server
            // strips them and matches the container.
            'content-type': blob.type || 'application/octet-stream',
            ...(language ? { 'x-nodal-language': language } : {}),
          },
          body: blob,
        });

        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            provider?: string;
            message?: string;
          };
          // Each of these is actionable, and saying which is the whole point.
          if (body.error === 'no_key_for_provider') {
            toast.error(`Add a ${body.provider ?? 'speech'} key in LLM Providers to use voice.`);
          } else if (body.error === 'unsupported_audio_type') {
            toast.error('This browser records a format the transcriber refuses.');
          } else if (body.error === 'audio_too_large') {
            toast.error('That recording is too long.');
          } else {
            toast.error(body.message ?? 'Transcription failed.');
          }
          return;
        }

        const { text } = (await res.json()) as { text: string };
        onTranscript(text);
      } catch {
        toast.error('Transcription failed.');
      } finally {
        setState('idle');
      }
    },
    [language, onTranscript],
  );

  const stop = useCallback(() => {
    // `stop()` fires `onstop`, which is where the blob is assembled.
    recorderRef.current?.stop();
  }, []);

  const start = useCallback(async () => {
    const mimeType = pickMimeType();
    if (!mimeType) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      // A refusal is a decision, not a bug: say what happened, once.
      // NotAllowedError covers two very different things, and telling them
      // apart matters: the user clicking "Block", and the PAGE forbidding the
      // device via Permissions-Policy. The second one shipped for a while and
      // read exactly like the first — the button said "refused" while the
      // refusal was the app's own header. The hint sends the reader to the
      // right place; e2e pins the header so it cannot happen again.
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotAllowedError') {
        toast.error('Microphone access was refused — check the site permission in your browser.');
      } else if (name === 'NotFoundError') {
        toast.error('No microphone found on this machine.');
      } else {
        toast.error('The microphone could not be opened.');
      }
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
      releaseTracks();
      // A click-click with nothing in between produces a few header bytes and
      // no speech. Sending it would spend a request to be told it is empty.
      if (blob.size < 1024) {
        setState('idle');
        return;
      }
      void send(blob);
    };

    recorder.start();
    setState('recording');
    stopTimerRef.current = setTimeout(() => {
      toast.info('Recording stopped after two minutes.');
      stop();
    }, MAX_RECORDING_MS);
  }, [releaseTracks, send, stop]);

  if (unsupportedReason) {
    return (
      <IconButton
        ghost
        disabled
        aria-label={`Voice input unavailable. ${unsupportedReason}`}
        title={unsupportedReason}
        className="!size-8 !rounded-[10px] !text-ink-4"
      >
        <Microphone size={15} />
      </IconButton>
    );
  }

  const busy = state === 'transcribing';
  return (
    <IconButton
      ghost
      type="button"
      disabled={disabled || busy}
      aria-label={
        state === 'recording' ? 'Stop recording' : busy ? 'Transcribing' : 'Record a message'
      }
      // The one place assistive tech learns that this control toggles.
      aria-pressed={state === 'recording'}
      onClick={() => (state === 'recording' ? stop() : void start())}
      className={
        state === 'recording'
          ? '!size-8 !rounded-[10px] !text-danger hover:!bg-hover'
          : '!size-8 !rounded-[10px] !text-ink-4 hover:!bg-hover hover:!text-ink-4'
      }
    >
      {state === 'recording' ? (
        <Stop size={15} weight="fill" />
      ) : busy ? (
        <CircleNotch size={15} className="animate-spin" />
      ) : (
        <Microphone size={15} />
      )}
    </IconButton>
  );
}
