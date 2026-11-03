'use client';

// VoiceComposer — le micro push-to-talk du composeur (#942).
//
// La maquette validée par Quentin (03/11) en huit états : repos, écoute (bouton
// tenu), transcription, réponse dite, tâche lancée, annulé, micro bloqué, rien
// entendu. Ce fichier tient le GESTE et ses états ; `ThreadComposer` les pose
// dans son cadre. Le transport est `voice-turn.ts` (les routes du runner, par la
// porte web), la voix qui joue est `voice-playback.ts`.
//
// LE GESTE : appuyer, parler, relâcher. L'audio part PENDANT que le bouton est
// tenu, par morceaux ; relâcher envoie la fin. Glisser hors du bouton puis
// relâcher annule : le tour est supprimé au runner (DELETE) et rien n'est envoyé.
// Au clavier, la barre d'espace tenue sur le bouton fait la même chose, et
// Échap pendant qu'elle est tenue annule.
//
// LA RÉPONSE ARRIVE EN FLUX (#943). Dès que le runner a transcrit, le geste
// est fini : la saisie revient, le fil montre la demande DITE et la réponse qui
// s'écrit (`onHeard`, `onReplyText`, rendus par `PendingTurn` comme une réponse
// tapée), et la voix joue phrase par phrase pendant ce temps. Stop fait taire
// la voix, abandonne le flux, et demande au runner d'arrêter le tour — le même
// Stop que le chat écrit (`/api/chat/stop`).
//
// Chaque issue se DIT dans le composeur (invariant #4), jamais par une boîte
// native (invariant #10).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Microphone, MicrophoneSlash } from '@phosphor-icons/react';
import IconButton from '@/components/ui/IconButton';
import { clockDuration } from '@/app/(dashboard)/spaces/format.ts';
import { MicrophoneError, startPcmCapture, type PcmCapture } from '@/lib/mic-capture.ts';
import {
  openVoiceTurn,
  speechErrorText,
  voiceFailureText,
  type VoiceTurnSession,
} from './voice-turn.ts';
import { startSpokenStream, stopSpeaking, type SpokenStream } from './voice-playback.ts';
import { stopChatTurn } from './chat-stream.ts';

/** Au-delà de cette distance du point d'appui, relâcher annule. */
export const SLIDE_CANCEL_PX = 60;

/** Le nombre de barres de l'indicateur de niveau. */
const METER_BARS = 14;

export type VoicePhase = 'idle' | 'listening' | 'transcribing';

/** Ce que le composeur dit sous la saisie après un geste. */
export type VoiceNote =
  | { kind: 'cancelled' }
  | { kind: 'blocked' }
  | { kind: 'nothing_heard' }
  | { kind: 'error'; text: string; detail?: string };

type Active = {
  capture: PcmCapture | null;
  session: VoiceTurnSession | null;
  /** Les morceaux arrivés avant que le tour soit ouvert. */
  early: Uint8Array[];
  target: Promise<string> | null;
  /** Le bouton relâché (`send`) ou abandonné (`cancel`) ; `null` : encore tenu. */
  ending: 'send' | 'cancel' | null;
  settling: boolean;
  /** L'écran est parti pendant le geste : plus rien ne s'affiche, et rien de neuf ne part. */
  abandoned: boolean;
  /** Stop, ou un nouveau geste : la voix de cette réponse ne joue plus. */
  silenced: boolean;
};

export interface VoiceTurnControls {
  phase: VoicePhase;
  /** Quand l'écoute a VRAIMENT commencé (le micro ouvert), pour le minuteur. */
  startedAt: number | null;
  /** Les derniers niveaux du micro, entre 0 et 1. */
  levels: readonly number[];
  note: VoiceNote | null;
  /** Le navigateur a refusé le micro : le bouton le montre jusqu'au prochain accès réussi. */
  blocked: boolean;
  /** La réponse d'un tour dit arrive encore (texte ou voix) : Stop peut l'arrêter. */
  replying: boolean;
  /** Stop : la voix se tait, le flux est abandonné, le runner arrête le tour. */
  stopReply: () => void;
  press: () => void;
  release: () => void;
  cancel: () => void;
  clearNote: () => void;
}

export function useVoiceTurn(opts: {
  /** La conversation qui reçoit le tour — celle du fil, ou celle qui s'ouvre (P8). */
  resolveTarget: () => Promise<string>;
  /** Le tour est joué : le fil se relit (ou l'écran devient le fil). */
  onReplied: (conversationId: string) => void;
  /** Le tour n'a rien écrit, ou a échoué : la conversation est rendue à l'écran tel quel. */
  onUnused: (conversationId: string) => void;
  /** Le runner a transcrit (#943) : la demande DITE paraît dans le fil. */
  onHeard?: (transcript: string, durationMs: number) => void;
  /** Le texte de la réponse connu à cet instant, entier (#943). */
  onReplyText?: (text: string) => void;
}): VoiceTurnControls {
  const [phase, setPhase] = useState<VoicePhase>('idle');
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [levels, setLevels] = useState<readonly number[]>([]);
  const [note, setNote] = useState<VoiceNote | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [replying, setReplying] = useState(false);
  const active = useRef<Active | null>(null);
  /** Le tour dont la réponse arrive encore, une fois le geste fini (#943). */
  const replyingTurn = useRef<Active | null>(null);
  const busy = useRef(false);
  // Les rappels du parent changent à chaque rendu ; le geste en cours lit les derniers.
  const callbacks = useRef(opts);
  useEffect(() => {
    callbacks.current = opts;
  });

  async function unused(me: Active): Promise<void> {
    if (me.target === null) return;
    const target = await me.target.catch(() => null);
    if (target !== null && target !== '') callbacks.current.onUnused(target);
  }

  async function settle(me: Active, how: 'send' | 'cancel'): Promise<void> {
    if (me.settling) return;
    me.settling = true;
    // Le micro rendu, et le dernier morceau parti dans la file.
    me.capture?.stop();
    setLevels([]);
    setStartedAt(null);
    const session = me.session;
    if (how === 'cancel' || session === null) {
      active.current = null;
      setPhase('idle');
      setNote({ kind: 'cancelled' });
      await session?.cancel();
      await unused(me);
      return;
    }
    busy.current = true;
    setPhase('transcribing');
    // Un porteur, pas une variable : les rappels du flux l'ouvrent.
    const voice: { current: SpokenStream | null } = { current: null };
    let text = '';
    const outcome = await session.finish({
      onTranscript: (transcript, durationMs) => {
        // Le runner a entendu : le geste est fini. Le micro peut repartir, la
        // saisie revient, et le fil montre la demande et la réponse.
        busy.current = false;
        if (active.current === me) active.current = null;
        if (me.abandoned) return;
        replyingTurn.current = me;
        setReplying(true);
        setPhase('idle');
        callbacks.current.onHeard?.(transcript, durationMs);
      },
      onText: (t) => {
        text = t;
        voice.current?.setReply(t);
        if (!me.abandoned) callbacks.current.onReplyText?.(t);
      },
      onAudio: (chunk) => {
        // Rien ne joue sur un écran quitté, ni après Stop ou un nouveau geste.
        if (me.abandoned || me.silenced) return;
        voice.current ??= startSpokenStream({
          reply: text,
          onError: (message) => {
            if (me.abandoned) return;
            setNote({
              kind: 'error',
              text: 'The reply is written above, but it could not be played.',
              detail: message,
            });
          },
        });
        voice.current.push(chunk);
      },
      onAudioEnd: () => voice.current?.endSentence(),
    });
    voice.current?.end();
    busy.current = false;
    if (active.current === me) active.current = null;
    if (replyingTurn.current === me) {
      replyingTurn.current = null;
      setReplying(false);
    }
    if (me.abandoned) {
      // L'écran est parti après le relâchement : le tour envoyé est rangé par
      // le runner, et la conversation le montrera rouverte. Rien ne joue, rien
      // ne ramène sur elle ; seule une conversation neuve restée vide est rendue.
      if (outcome.kind !== 'replied' && outcome.kind !== 'aborted') await unused(me);
      return;
    }
    setPhase('idle');
    if (outcome.kind === 'nothing_heard') {
      setNote({ kind: 'nothing_heard' });
      await unused(me);
      return;
    }
    if (outcome.kind === 'failed') {
      const f = outcome.failure;
      setNote({
        kind: 'error',
        text: voiceFailureText(f),
        ...(f.detail ? { detail: f.detail } : {}),
      });
      await unused(me);
      return;
    }
    if (outcome.kind === 'cancelled') return;
    // Joué jusqu'au bout, ou arrêté par Stop : le fil relu montre ce que la
    // base porte.
    const target = me.target ? await me.target.catch(() => '') : '';
    if (target !== '') callbacks.current.onReplied(target);
    if (outcome.kind === 'aborted') return;
    const { speechError } = outcome.reply;
    if (speechError) {
      setNote({
        kind: 'error',
        text: speechErrorText(speechError.code),
        ...(speechError.detail ? { detail: speechError.detail } : {}),
      });
    }
  }

  /** Stop pendant la réponse d'un tour dit : silence, flux abandonné, tour arrêté au runner. */
  function stopReply(): void {
    const me = replyingTurn.current;
    stopSpeaking();
    if (me === null) return;
    me.silenced = true;
    void (async () => {
      const target = me.target ? await me.target.catch(() => '') : '';
      // Le Stop du runner d'abord : c'est lui qui range la réponse arrêtée.
      if (target !== '') await stopChatTurn(target);
      me.session?.abort();
    })();
  }

  async function press(): Promise<void> {
    if (active.current !== null || busy.current) return;
    const me: Active = {
      capture: null,
      session: null,
      early: [],
      target: null,
      ending: null,
      settling: false,
      abandoned: false,
      silenced: false,
    };
    active.current = me;
    // Parler à l'agent coupe sa voix : on ne parle pas par-dessus — ni sur
    // celle qui joue, ni sur celle d'une réponse qui arrive encore.
    if (replyingTurn.current) replyingTurn.current.silenced = true;
    stopSpeaking();
    setNote(null);
    setLevels([]);
    setStartedAt(null);
    setPhase('listening');

    let capture: PcmCapture;
    try {
      capture = await startPcmCapture({
        onChunk: (pcm) => {
          if (me.session) me.session.push(pcm);
          else me.early.push(pcm);
        },
        onLevel: (level) => setLevels((prev) => [...prev, level].slice(-METER_BARS)),
      });
    } catch (err) {
      active.current = null;
      setPhase('idle');
      if (err instanceof MicrophoneError && err.kind === 'denied') {
        setBlocked(true);
        setNote({ kind: 'blocked' });
      } else {
        setNote({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    // L'écran est parti pendant que le micro s'ouvrait : le micro est rendu
    // aussitôt, et ni conversation ni tour ne s'ouvrent.
    if (me.abandoned) {
      capture.stop();
      return;
    }
    setBlocked(false);
    me.capture = capture;
    // Le geste a été abandonné pendant que le micro s'ouvrait : rien ne part.
    if (me.ending === 'cancel') {
      void settle(me, 'cancel');
      return;
    }
    me.target = callbacks.current.resolveTarget();
    me.session = openVoiceTurn({
      conversationId: me.target,
      sampleRate: capture.sampleRate,
      // Une étape refusée PENDANT la prise : on cesse d'écouter tout de suite,
      // et la fin du tour dit pourquoi.
      onFailed: () => {
        if (active.current === me && !me.settling) void settle(me, 'send');
      },
    });
    for (const pcm of me.early) me.session.push(pcm);
    me.early = [];
    setStartedAt(Date.now());
    if (me.ending !== null) void settle(me, me.ending);
  }

  function end(how: 'send' | 'cancel'): void {
    const me = active.current;
    if (me === null) return;
    me.ending ??= how;
    // Le micro ne s'est pas encore ouvert : `press` finira le geste.
    if (me.capture !== null) void settle(me, me.ending);
  }

  // L'écran quitte le fil en plein geste. Ce qui arrive au geste dépend de
  // l'endroit où il en est, et c'est la seule chose qui en décide :
  //   - le micro s'ouvre encore : le geste est abandonné, et `press` rend le
  //     micro dès qu'il s'ouvre, sans ouvrir de tour ;
  //   - le bouton est encore tenu : le tour est annulé (un DELETE) ;
  //   - le bouton a été relâché (`settling`) : le tour envoyé va au bout. Un
  //     DELETE ici courrait contre `end` et pourrait jeter, sans trace, ce que
  //     la personne a choisi d'envoyer.
  useEffect(
    () => () => {
      // La réponse d'un tour dit qui arrive encore : rien ne joue plus pour
      // un écran quitté (#943).
      const replyingMe = replyingTurn.current;
      if (replyingMe !== null) {
        replyingMe.abandoned = true;
        replyingMe.silenced = true;
        stopSpeaking();
      }
      const me = active.current;
      if (me === null) return;
      me.abandoned = true;
      if (me.settling) return;
      me.settling = true;
      me.capture?.stop();
      void me.session?.cancel();
    },
    [],
  );

  return {
    phase,
    startedAt,
    levels,
    note,
    blocked,
    replying,
    stopReply,
    press: () => void press(),
    release: () => end('send'),
    cancel: () => end('cancel'),
    clearNote: () => setNote(null),
  };
}

/** Le minuteur de l'écoute : « 0:04 ». */
function Elapsed({ since }: { since: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="ml-auto text-mono-12 text-ink-2" data-testid="voice-elapsed">
      {clockDuration(since === null ? 0 : Math.max(0, now - since))}
    </span>
  );
}

/** À la place de la zone de texte pendant que le bouton est tenu. */
export function ListeningPanel({
  startedAt,
  levels,
}: {
  startedAt: number | null;
  levels: readonly number[];
}) {
  // Les barres les plus récentes à droite ; vides tant que le micro n'a rien dit.
  const bars = [...Array<number>(Math.max(0, METER_BARS - levels.length)).fill(0), ...levels];
  return (
    <div
      className="flex min-h-[40px] flex-col justify-center gap-1.5"
      data-testid="voice-listening"
    >
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-attention" />
        <span className="text-medium-13 text-ink">Listening</span>
        <span
          aria-hidden="true"
          className="flex h-5 items-center gap-[3px]"
          data-testid="voice-meter"
        >
          {bars.map((level, i) => (
            <span
              key={i}
              className="w-[3px] rounded-full bg-ink-2"
              // Le niveau vocal (RMS) dépasse rarement 0,3 : l'échelle est
              // ouverte pour que la parole remplisse la hauteur.
              style={{ height: `${String(4 + Math.round(Math.min(1, level * 4) * 16))}px` }}
            />
          ))}
        </span>
        <Elapsed since={startedAt} />
      </div>
      <span className="text-body-12 text-ink-2">Release to send. Slide away to cancel.</span>
    </div>
  );
}

/** À la place de la zone de texte pendant que le runner transcrit et répond. */
export function TranscribingLine() {
  return (
    <div
      className="flex min-h-[40px] items-center gap-2 text-body-13 text-ink-2"
      data-testid="voice-transcribing"
    >
      <span aria-hidden="true" className="inline-flex gap-1">
        <span className="size-[5px] animate-pulse rounded-full bg-ink-2" />
        <span className="size-[5px] animate-pulse rounded-full bg-ink-2 opacity-60 [animation-delay:150ms]" />
        <span className="size-[5px] animate-pulse rounded-full bg-ink-2 opacity-30 [animation-delay:300ms]" />
      </span>
      Transcribing…
    </div>
  );
}

/** La note du composeur après un geste. */
export function VoiceNoteLine({ note }: { note: VoiceNote }) {
  let text: string;
  let dot: ReactNode = null;
  switch (note.kind) {
    case 'cancelled':
      text = 'Cancelled. Nothing was sent.';
      break;
    case 'blocked':
      text =
        'Microphone blocked. Allow it for this site in your browser, then hold the button again.';
      dot = <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-err" />;
      break;
    case 'nothing_heard':
      text = 'Nothing heard. Keep holding the button while you speak.';
      break;
    case 'error':
      text = note.text;
      dot = <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-err" />;
      break;
  }
  return (
    <p
      role="status"
      className="m-0 flex items-center gap-1.5 text-body-12 text-ink-2"
      data-testid="voice-note"
      {...(note.kind === 'error' && note.detail ? { title: note.detail } : {})}
    >
      {dot}
      {text}
    </p>
  );
}

/**
 * Le bouton micro. Tenu à la souris, au doigt, ou à la barre d'espace quand il
 * a le focus. La capture du pointeur garde le geste au bouton même quand le
 * doigt glisse : c'est elle qui permet de mesurer la glissade d'annulation.
 */
export function MicButton({ voice }: { voice: VoiceTurnControls }) {
  const origin = useRef<{ x: number; y: number; id: number } | null>(null);
  const away = useRef(false);
  const keyHeld = useRef(false);
  const { phase, blocked } = voice;

  const label =
    phase === 'listening'
      ? 'Listening, release to send'
      : phase === 'transcribing'
        ? 'Transcribing'
        : blocked
          ? 'Microphone blocked'
          : 'Hold to talk';

  return (
    <span className="group relative inline-flex">
      {phase === 'idle' && !blocked && (
        // L'indication au survol : la même phrase que le nom du bouton, qui
        // la porte déjà pour un lecteur d'écran.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute right-0 bottom-full mb-2 hidden rounded-md bg-ink px-2 py-1 text-body-12 whitespace-nowrap text-canvas group-hover:block"
          data-testid="voice-tooltip"
        >
          Hold to talk
        </span>
      )}
      <IconButton
        size="sm"
        shape="round"
        fill={phase === 'listening' ? 'attention' : blocked ? 'chrome' : 'subtle'}
        aria-label={label}
        {...(phase === 'listening' ? { 'aria-pressed': true } : {})}
        disabled={phase === 'transcribing'}
        className={`touch-none select-none ${blocked && phase === 'idle' ? 'text-err!' : ''}`}
        data-testid="composer-mic"
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.preventDefault();
          e.currentTarget.setPointerCapture?.(e.pointerId);
          origin.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          away.current = false;
          voice.press();
        }}
        onPointerMove={(e) => {
          const o = origin.current;
          if (o === null || e.pointerId !== o.id) return;
          away.current = Math.hypot(e.clientX - o.x, e.clientY - o.y) > SLIDE_CANCEL_PX;
        }}
        onPointerUp={(e) => {
          const o = origin.current;
          if (o === null || e.pointerId !== o.id) return;
          origin.current = null;
          if (away.current) voice.cancel();
          else voice.release();
        }}
        onPointerCancel={() => {
          // Le navigateur a repris le geste (un défilement, un appel) : rien ne part.
          if (origin.current === null) return;
          origin.current = null;
          voice.cancel();
        }}
        onKeyDown={(e) => {
          if (e.key === ' ') {
            e.preventDefault();
            if (!e.repeat && !keyHeld.current) {
              keyHeld.current = true;
              voice.press();
            }
          } else if (e.key === 'Escape' && keyHeld.current) {
            keyHeld.current = false;
            voice.cancel();
          }
        }}
        onKeyUp={(e) => {
          if (e.key !== ' ' || !keyHeld.current) return;
          e.preventDefault();
          keyHeld.current = false;
          voice.release();
        }}
        onBlur={() => {
          if (!keyHeld.current) return;
          keyHeld.current = false;
          voice.cancel();
        }}
      >
        {blocked && phase === 'idle' ? (
          <MicrophoneSlash size={16} weight="regular" aria-hidden="true" />
        ) : (
          <Microphone size={16} weight="regular" aria-hidden="true" />
        )}
      </IconButton>
    </span>
  );
}
