'use client';

/**
 * VoiceSection — Réglages → Workspace → Voice (#969) : la voix avec laquelle
 * Nodal parle, dans chaque tour dit et pour l'audio que génère un agent, et
 * l'oreille qui écrit ce qu'on lui dit (#976).
 *
 * Le propriétaire, 03/11 : « tu pourrais mettre un réglage dans Nodal qui me
 * permette de switcher de voix quand je veux pour tester ? ».
 *
 * DEUX PARTS, CHACUNE AVEC SA SOURCE (#1048, maquette validée le 11/11) :
 * « Speaking » (OpenRouter, Google, Local server) et « Listening »
 * (OpenRouter, Local server). « Local server » est un serveur que la personne
 * fait tourner (un serveur Whisper, une voix sur sa carte graphique), joint à
 * l'adresse qu'elle tape, avec une clé facultative. Nodal n'en livre aucun et
 * ne le démarre ni ne l'arrête. Ses modèles sont lus à cette adresse (rien
 * listé : la personne tape le nom) ; ses voix se tapent toujours.
 *
 * Sous chaque part, un ÉTAT toujours visible : elle répond (le modèle, son
 * temps sur l'échantillon, l'heure du contrôle) ou non (la raison, l'heure),
 * avec « Check again ». C'est l'épreuve même de l'enregistrement
 * (`POST /api/voice/check`), quelle que soit la source.
 *
 * L'écran est un client des routes du runner, par la porte web, comme un
 * module (règle du #948) : il LIT le réglage (`GET /api/voice/setting`),
 * ENREGISTRE un choix (`PUT`), fait entendre une voix (`POST /api/voice/sample`),
 * demande l'état d'une part (`POST /api/voice/check`) et les modèles d'un
 * serveur (`POST /api/voice/server/models`). Une clé tapée part au runner,
 * qui la chiffre ; elle ne revient jamais (`hasKey`).
 *
 * Ce que l'écran montre est ce que le moteur applique (règle du 01/11) : la
 * voix affichée est la ligne en base, et aucun choix n'est fait à la place de
 * la personne. Changer de source vide le modèle et la voix (sauf à revenir à
 * la source enregistrée, qui retrouve ses valeurs) : le premier de la liste
 * serait un choix que personne n'a fait. Une source sans clé, une liste que
 * le fournisseur n'a pas pu dire, un refus : chacun se dit, sous le champ
 * qu'il concerne (invariant #4).
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Stop } from '@phosphor-icons/react';
import {
  TRANSCRIPTION_SOURCES,
  VOICE_SOURCES,
  type ListeningEarInput,
  type SpeakingVoiceInput,
  type TranscriptionSource,
  type VoiceCheck,
  type VoicePart,
  type VoiceServerInput,
  type VoiceServerView,
  type VoiceSettingInput,
  type VoiceSettingView,
  type VoiceSource,
  type VoiceState,
} from '@nodal-agents/shared';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Select from '@/components/ui/Select';
import TextInput from '@/components/ui/TextInput';
import FieldLabel from '@/components/ui/FieldLabel';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { startSpokenStream, stopSpeaking, useSpeaking } from '../chat/voice-playback.ts';
import {
  checkVoicePart,
  listServerModels,
  playVoiceSample,
  readVoiceState,
  saveVoiceSetting,
  type VoiceRefusal,
} from './voice-setting-client.ts';
import {
  KEY_KEPT_PLACEHOLDER,
  KEY_PLACEHOLDER,
  SAMPLE_SENTENCE,
  SOURCE_LABELS,
  clockOf,
  destinationOf,
  earListedText,
  earUnavailableText,
  listedText,
  notAnsweringText,
  notCheckedText,
  notFaithfulHelp,
  refusalText,
  sampleErrorText,
  secondsOf,
  serverDownHelp,
  serverHint,
  serverListedText,
  settingProblemText,
  sourceUnavailableText,
  type ServerListing,
} from './voice-copy.ts';

/** The source reached at an address the person gives (#1048). */
const SERVER = 'openai-compatible';

/** How long typing pauses before a server is asked (its models, the trial). */
const TYPING_PAUSE_MS = 400;

/** A server as the screen holds it: the address typed, and a key typed now (empty: none typed). */
type ServerDraft = { address: string; key: string };

type Draft = {
  source: VoiceSource | null;
  model: string;
  voice: string;
  speechServer: ServerDraft | null;
  transcriptionSource: TranscriptionSource | null;
  transcriptionModel: string;
  transcriptionServer: ServerDraft | null;
};

const EMPTY: Draft = {
  source: null,
  model: '',
  voice: '',
  speechServer: null,
  transcriptionSource: null,
  transcriptionModel: '',
  transcriptionServer: null,
};

const trimAddress = (a: string): string => a.trim().replace(/\/+$/, '');

function validAddress(a: string): boolean {
  try {
    const u = new URL(a.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function draftOf(s: VoiceSettingView): Draft {
  return {
    source: s.source,
    model: s.model,
    voice: s.voice,
    speechServer: s.speechServer ? { address: s.speechServer.address, key: '' } : null,
    transcriptionSource: s.transcriptionSource,
    transcriptionModel: s.transcriptionModel,
    transcriptionServer: s.transcriptionServer
      ? { address: s.transcriptionServer.address, key: '' }
      : null,
  };
}

/**
 * The server as the runner takes it. A key typed now is sent; none typed
 * keeps the saved one ONLY at the saved address (`keep`); otherwise none.
 */
function serverInput(d: ServerDraft, saved: VoiceServerView | undefined): VoiceServerInput {
  const address = trimAddress(d.address);
  const typed = d.key.trim();
  return {
    address,
    key: typed
      ? { value: typed }
      : saved?.hasKey && trimAddress(saved.address) === address
        ? 'keep'
        : 'none',
  };
}

const savedSpeechServer = (d: Draft, saved: VoiceSettingView | null) =>
  saved && saved.source === d.source ? saved.speechServer : undefined;
const savedEarServer = (d: Draft, saved: VoiceSettingView | null) =>
  saved && saved.transcriptionSource === d.transcriptionSource
    ? saved.transcriptionServer
    : undefined;

/** The part that speaks as the runner takes it, or `null` while a field is missing. */
function speakingInput(d: Draft, saved: VoiceSettingView | null): SpeakingVoiceInput | null {
  if (!d.source || !d.model.trim() || !d.voice.trim()) return null;
  if (d.source !== SERVER) return { source: d.source, model: d.model, voice: d.voice };
  if (!d.speechServer || !validAddress(d.speechServer.address)) return null;
  return {
    source: d.source,
    model: d.model.trim(),
    voice: d.voice.trim(),
    speechServer: serverInput(d.speechServer, savedSpeechServer(d, saved)),
  };
}

/** The part that listens as the runner takes it, or `null` while a field is missing. */
function listeningInput(d: Draft, saved: VoiceSettingView | null): ListeningEarInput | null {
  if (!d.transcriptionSource || !d.transcriptionModel.trim()) return null;
  if (d.transcriptionSource !== SERVER) {
    return { transcriptionSource: d.transcriptionSource, transcriptionModel: d.transcriptionModel };
  }
  if (!d.transcriptionServer || !validAddress(d.transcriptionServer.address)) return null;
  return {
    transcriptionSource: d.transcriptionSource,
    transcriptionModel: d.transcriptionModel.trim(),
    transcriptionServer: serverInput(d.transcriptionServer, savedEarServer(d, saved)),
  };
}

const sameServer = (d: ServerDraft | null, s: VoiceServerView | undefined): boolean =>
  d === null
    ? s === undefined
    : s !== undefined && trimAddress(d.address) === trimAddress(s.address) && d.key.trim() === '';

/** The part that SPEAKS is the one saved (the sample and the check then send nothing). */
const sameVoice = (a: Draft | null, b: VoiceSettingView | null): boolean =>
  a !== null &&
  b !== null &&
  a.source === b.source &&
  a.model === b.model &&
  a.voice === b.voice &&
  sameServer(a.speechServer, b.speechServer);

const sameEar = (a: Draft | null, b: VoiceSettingView | null): boolean =>
  a !== null &&
  b !== null &&
  a.transcriptionSource === b.transcriptionSource &&
  a.transcriptionModel === b.transcriptionModel &&
  sameServer(a.transcriptionServer, b.transcriptionServer);

/** What a part shows under it: never nothing (#1048). */
type CheckView =
  | { key: string; state: 'checking' }
  | { key: string; state: 'done'; check: VoiceCheck }
  | { key: string; state: 'failed'; refusal: VoiceRefusal };

type Listings = Partial<Record<VoicePart, { key: string; listing: ServerListing }>>;

export default function VoiceSection() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [loadError, setLoadError] = useState<VoiceRefusal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<VoiceRefusal | null>(null);
  const [sampleError, setSampleError] = useState<{ text: string; detail?: string } | null>(null);
  /** L'essai est demandé et sa voix arrive encore. */
  const [playing, setPlaying] = useState(false);
  const [isSaving, startSaving] = useTransition();
  const [listings, setListings] = useState<Listings>({});
  const [checks, setChecks] = useState<Partial<Record<VoicePart, CheckView>>>({});
  /** The request each part's state answers now: a late answer to an older one is dropped. */
  const wanted = useRef<Partial<Record<VoicePart, string>>>({});
  const sampleAbort = useRef<AbortController | null>(null);
  // La voix de l'essai joue encore après la fin du flux : le Stop reste là
  // tant qu'elle s'entend.
  const speaking = useSpeaking();
  const audible = playing || speaking?.reply === SAMPLE_SENTENCE;

  useEffect(() => {
    let live = true;
    void readVoiceState().then((r) => {
      if (!live) return;
      if (!r.ok) {
        setLoadError(r.refusal);
        return;
      }
      setState(r.data);
      setDraft(r.data.setting ? draftOf(r.data.setting) : null);
    });
    return () => {
      live = false;
    };
  }, []);

  const stopSample = useCallback(() => {
    sampleAbort.current?.abort();
    sampleAbort.current = null;
    stopSpeaking();
    setPlaying(false);
  }, []);

  useEffect(() => stopSample, [stopSample]);

  const saved = state?.setting ?? null;

  // ── The models of a server, at the address on screen (#1048) ──────────────
  const speechServerReq =
    draft?.source === SERVER && draft.speechServer && validAddress(draft.speechServer.address)
      ? serverInput(draft.speechServer, savedSpeechServer(draft, saved))
      : null;
  const earServerReq =
    draft?.transcriptionSource === SERVER &&
    draft.transcriptionServer &&
    validAddress(draft.transcriptionServer.address)
      ? serverInput(draft.transcriptionServer, savedEarServer(draft, saved))
      : null;
  const speechServerKey = speechServerReq ? JSON.stringify(speechServerReq) : '';
  const earServerKey = earServerReq ? JSON.stringify(earServerReq) : '';

  useServerModels('speaking', speechServerKey, setListings);
  useServerModels('listening', earServerKey, setListings);

  const listingOf = (part: VoicePart, key: string): ServerListing | null => {
    if (key === '') return null;
    const kept = listings[part];
    return kept?.key === key ? kept.listing : { state: 'loading' };
  };
  const speechListing = listingOf('speaking', speechServerKey);
  const earListing = listingOf('listening', earServerKey);

  // ── What each part offers, and whether it is complete ─────────────────────
  const source = draft?.source ?? null;
  const keyedChoices =
    source && source !== SERVER ? state?.sources.find((s) => s.source === source) : undefined;
  const models = keyedChoices?.state === 'available' ? keyedChoices.models : [];
  const model = models.find((m) => m.id === draft?.model);
  // A model a server lists is picked among its list; one that lists none, or
  // that could not be asked, leaves the name to the person, and the trial
  // (the check, the save) says whether it answers.
  const listedOk = (l: ServerListing | null, id: string): boolean =>
    l?.state !== 'listed' || l.models.length === 0 || l.models.some((m) => m.id === id);
  const voiceComplete =
    draft !== null &&
    (source === SERVER
      ? speakingInput(draft, saved) !== null && listedOk(speechListing, draft.model.trim())
      : model !== undefined && model.voices.some((v) => v.id === draft.voice));
  const ear = state?.transcription;
  const earModels = ear?.state === 'available' ? ear.models : [];
  const earSource = draft?.transcriptionSource ?? null;
  const earComplete =
    draft !== null &&
    (earSource === SERVER
      ? listeningInput(draft, saved) !== null &&
        listedOk(earListing, draft.transcriptionModel.trim())
      : earSource !== null && earModels.some((m) => m.id === draft.transcriptionModel));
  const voiceDirty = draft !== null && !sameVoice(draft, saved);
  const earDirty = draft !== null && !sameEar(draft, saved);
  const dirty = voiceDirty || earDirty;

  // ── The state of each part: the trial of a save (#1048) ───────────────────
  const voiceInput = draft && voiceComplete ? speakingInput(draft, saved) : null;
  const earInput = draft && earComplete ? listeningInput(draft, saved) : null;
  const speakingKey = voiceInput
    ? JSON.stringify({ part: 'speaking', ...(voiceDirty ? { speaking: voiceInput } : {}) })
    : '';
  const listeningKey = earInput
    ? JSON.stringify({
        part: 'listening',
        ...(earDirty ? { listening: earInput } : {}),
        // The sample is said by the voice on screen when it is complete.
        ...(voiceDirty && voiceInput ? { speaking: voiceInput } : {}),
      })
    : '';

  const runCheck = useCallback((key: string, fresh: boolean) => {
    const req = JSON.parse(key) as Parameters<typeof checkVoicePart>[0];
    const part = req.part;
    wanted.current[part] = key;
    setChecks((c) => ({ ...c, [part]: { key, state: 'checking' } }));
    void checkVoicePart({ ...req, ...(fresh ? { fresh: true } : {}) }).then((r) => {
      if (wanted.current[part] !== key) return;
      setChecks((c) => ({
        ...c,
        [part]: r.ok
          ? { key, state: 'done', check: r.data }
          : { key, state: 'failed', refusal: r.refusal },
      }));
    });
  }, []);

  const typedSpeaking = source === SERVER;
  const typedEar = earSource === SERVER;
  useEffect(() => {
    if (!speakingKey) {
      wanted.current.speaking = undefined;
      return;
    }
    if (wanted.current.speaking === speakingKey) return;
    const t = setTimeout(() => runCheck(speakingKey, false), typedSpeaking ? TYPING_PAUSE_MS : 0);
    return () => clearTimeout(t);
  }, [speakingKey, typedSpeaking, runCheck]);
  useEffect(() => {
    if (!listeningKey) {
      wanted.current.listening = undefined;
      return;
    }
    if (wanted.current.listening === listeningKey) return;
    const t = setTimeout(() => runCheck(listeningKey, false), typedEar ? TYPING_PAUSE_MS : 0);
    return () => clearTimeout(t);
  }, [listeningKey, typedEar, runCheck]);

  if (loadError) {
    return (
      <p className="text-body-13 text-warn" role="alert" data-testid="voice-load-error">
        {refusalText(loadError)} Reload the page, and check the runner is up.
      </p>
    );
  }
  if (!state) {
    return (
      <p className="text-body-13 text-ink-3" data-testid="voice-loading">
        Reading the voice…
      </p>
    );
  }

  function edit(next: (d: Draft) => Draft, part: VoicePart) {
    setSaveError(null);
    if (part === 'speaking') setSampleError(null);
    setDraft((d) => next(d ?? EMPTY));
  }

  function pickSource(next: VoiceSource) {
    if (draft?.source === next) return;
    edit((d) => {
      // Back to the saved source: its saved values. Elsewhere: nothing chosen
      // in the person's place, the model and the voice are to choose.
      if (saved && saved.source === next) {
        const s = draftOf(saved);
        return {
          ...d,
          source: s.source,
          model: s.model,
          voice: s.voice,
          speechServer: s.speechServer,
        };
      }
      return {
        ...d,
        source: next,
        model: '',
        voice: '',
        speechServer: next === SERVER ? { address: '', key: '' } : null,
      };
    }, 'speaking');
  }

  function pickEarSource(next: TranscriptionSource) {
    if (draft?.transcriptionSource === next) return;
    edit((d) => {
      if (saved && saved.transcriptionSource === next) {
        const s = draftOf(saved);
        return {
          ...d,
          transcriptionSource: s.transcriptionSource,
          transcriptionModel: s.transcriptionModel,
          transcriptionServer: s.transcriptionServer,
        };
      }
      return {
        ...d,
        transcriptionSource: next,
        transcriptionModel: '',
        transcriptionServer: next === SERVER ? { address: '', key: '' } : null,
      };
    }, 'listening');
  }

  function pickModel(id: string) {
    edit((d) => {
      const offers = models.find((m) => m.id === id)?.voices ?? [];
      // La voix choisie reste si le nouveau modèle l'offre aussi (un serveur
      // ne liste pas ses voix : la voix tapée reste).
      return {
        ...d,
        model: id,
        voice: d.source === SERVER || offers.some((v) => v.id === d.voice) ? d.voice : '',
      };
    }, 'speaking');
  }

  function cancel() {
    setSaveError(null);
    setSampleError(null);
    setDraft(saved ? draftOf(saved) : null);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !dirty) return;
    if (!voiceInput || !earInput) {
      setSaveError({ error: voiceInput ? 'choose_ear' : 'choose_voice' });
      return;
    }
    const setting: VoiceSettingInput = { ...voiceInput, ...earInput };
    startSaving(async () => {
      const r = await saveVoiceSetting(setting);
      if (!r.ok) {
        setSaveError(r.refusal);
        return;
      }
      setState((s) => (s ? { ...s, setting: r.data, settingProblem: undefined } : s));
      setDraft(draftOf(r.data));
      toast.success('Voice saved. The next turn speaks with it.');
    });
  }

  async function sample() {
    if (!voiceInput) return;
    stopSample();
    setSampleError(null);
    const ctrl = new AbortController();
    sampleAbort.current = ctrl;
    setPlaying(true);
    const played: { failed: { text: string; detail?: string } | null } = { failed: null };
    const spoken = startSpokenStream({
      reply: SAMPLE_SENTENCE,
      onError: (message) => {
        played.failed = { text: 'The sample could not be played.', detail: message };
        setSampleError(played.failed);
      },
    });
    const r = await playVoiceSample({
      text: SAMPLE_SENTENCE,
      // La voix enregistrée part sans réglage : le runner relit la sienne.
      ...(voiceDirty ? { setting: voiceInput } : {}),
      signal: ctrl.signal,
      onAudio: (chunk) => spoken.push(chunk),
      onAudioEnd: (sentence, complete) => spoken.endSentence(sentence, complete),
    });
    spoken.end();
    if (sampleAbort.current === ctrl) sampleAbort.current = null;
    if (r.ok === 'aborted') return;
    if (!r.ok) {
      stopSpeaking();
      setPlaying(false);
      setSampleError({ text: refusalText(r.refusal) });
      return;
    }
    if (r.data.speechError) {
      stopSpeaking();
      setPlaying(false);
      setSampleError({
        text: sampleErrorText(r.data.speechError, r.data.source),
        ...(r.data.speechError.detail ? { detail: r.data.speechError.detail } : {}),
      });
      return;
    }
    setPlaying(false);
  }

  const unsaved: string[] = [];
  if (draft?.source && voiceDirty) {
    unsaved.push(
      saved && saved.source !== draft.source
        ? `speaking moves from ${destinationOf(saved.source, saved.speechServer?.address)} to ${destinationOf(draft.source, draft.speechServer?.address)}`
        : `speaking changes to ${draft.model || 'a model to choose'}`,
    );
  }
  if (draft?.transcriptionSource && earDirty) {
    unsaved.push(
      saved && saved.transcriptionSource !== draft.transcriptionSource
        ? `listening moves from ${destinationOf(saved.transcriptionSource, saved.transcriptionServer?.address)} to ${destinationOf(draft.transcriptionSource, draft.transcriptionServer?.address)}`
        : `listening changes to ${draft.transcriptionModel || 'a model to choose'}`,
    );
  }

  const speechHint = serverHint('speaking');
  const earHint = serverHint('listening');

  return (
    <form onSubmit={save} className="flex flex-col gap-5" data-testid="voice-section">
      {!saved && state.settingProblem && (
        <p className="text-body-13 text-warn" role="alert" data-testid="voice-setting-problem">
          {settingProblemText(state.settingProblem.code)}
        </p>
      )}

      {/* ── Speaking ─────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3" data-testid="voice-speaking">
        <h3 className="text-medium-13 text-ink-2">Speaking</h3>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Source</FieldLabel>
          <SegmentedControl<VoiceSource>
            ariaLabel="Speaking source"
            value={source}
            onChange={pickSource}
            disabled={isSaving}
            options={VOICE_SOURCES.map((s) => ({
              value: s,
              label: SOURCE_LABELS[s] ?? s,
              testId: `voice-source-${s}`,
            }))}
          />
          {source === SERVER && (
            <p className="text-body-13 text-ink-3" data-testid="voice-speech-hint">
              {speechHint.before}
              <code className="font-mono text-ink-2">{speechHint.route}</code>
              {speechHint.after}
            </p>
          )}
          {keyedChoices?.state === 'unavailable' && (
            <p className="text-body-13 text-warn" data-testid="voice-source-unavailable">
              {sourceUnavailableText(keyedChoices.source, keyedChoices.code, keyedChoices.detail)}
            </p>
          )}
        </div>

        {source === SERVER && draft?.speechServer && (
          <ServerFields
            part="speaking"
            server={draft.speechServer}
            savedServer={savedSpeechServer(draft, saved)}
            disabled={isSaving}
            onChange={(next) => edit((d) => ({ ...d, speechServer: next }), 'speaking')}
          />
        )}

        {keyedChoices?.state === 'available' && (
          <>
            <div className="flex flex-wrap gap-4">
              <Select
                label="Model"
                value={draft?.model ?? ''}
                onChange={(e) => pickModel(e.target.value)}
                disabled={isSaving}
                required
                containerClassName="min-w-[260px] flex-1"
                data-testid="voice-model"
              >
                <option value="">Choose a model</option>
                {models.map((m) => (
                  <option key={m.id} value={m.id} disabled={m.voices.length === 0}>
                    {m.voices.length === 0 ? `${m.label} (no voices listed)` : m.label}
                  </option>
                ))}
              </Select>
              <Select
                label="Voice"
                value={draft?.voice ?? ''}
                onChange={(e) => {
                  const voice = e.target.value;
                  edit((d) => ({ ...d, voice }), 'speaking');
                }}
                disabled={isSaving || !model}
                required
                containerClassName="min-w-[200px] flex-1"
                data-testid="voice-voice"
              >
                <option value="">Choose a voice</option>
                {(model?.voices ?? []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.description ? `${v.label}, ${v.description}` : v.label}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-body-13 text-ink-3" data-testid="voice-listed">
              {listedText(keyedChoices.source, keyedChoices.cacheSeconds)}
            </p>
          </>
        )}

        {source === SERVER && draft?.speechServer && (
          <>
            <div className="flex flex-wrap gap-4">
              <ServerModelField
                testId="voice-model"
                label="Model"
                value={draft.model}
                listing={speechListing}
                disabled={isSaving}
                containerClassName="min-w-[260px] flex-1"
                onChange={(id) => pickModel(id)}
              />
              <TextInput
                label="Voice"
                value={draft.voice}
                onChange={(e) => {
                  const voice = e.target.value;
                  edit((d) => ({ ...d, voice }), 'speaking');
                }}
                disabled={isSaving}
                placeholder="A voice your server offers"
                containerClassName="min-w-[200px] flex-1"
                data-testid="voice-voice-typed"
              />
            </div>
            <ListedLine
              testId="voice-listed"
              line={serverListedText(draft.speechServer.address, speechListing, 'speaking')}
            />
          </>
        )}

        <div className="flex flex-wrap items-center gap-3">
          {audible ? (
            <PrimaryButton
              type="button"
              variant="neutral"
              size="sm"
              onClick={stopSample}
              data-testid="voice-sample-stop"
            >
              <Stop size={14} weight="fill" aria-hidden /> Stop
            </PrimaryButton>
          ) : (
            <PrimaryButton
              type="button"
              variant="neutral"
              size="sm"
              onClick={() => void sample()}
              disabled={!voiceComplete || isSaving}
              data-testid="voice-sample"
            >
              <Play size={14} weight="fill" aria-hidden /> Play a sample
            </PrimaryButton>
          )}
          {sampleError && (
            <span className="text-body-13 text-warn" role="alert" data-testid="voice-sample-error">
              {sampleError.text}
              {sampleError.detail && (
                <span className="block text-xs text-ink-4">{sampleError.detail}</span>
              )}
            </span>
          )}
        </div>

        <PartStatus
          part="speaking"
          complete={voiceComplete}
          view={speakingKey && checks.speaking?.key === speakingKey ? checks.speaking : undefined}
          server={source === SERVER}
          onCheckAgain={() => {
            if (speakingKey) runCheck(speakingKey, true);
          }}
        />
      </div>

      <div className="h-px bg-rule" aria-hidden />

      {/* ── Listening ────────────────────────────────────────────────────── */}
      <div className="flex flex-col gap-3" data-testid="voice-listening">
        <h3 className="text-medium-13 text-ink-2">Listening</h3>
        <div className="flex flex-col gap-1.5">
          <FieldLabel>Source</FieldLabel>
          <SegmentedControl<TranscriptionSource>
            ariaLabel="Listening source"
            value={earSource}
            onChange={pickEarSource}
            disabled={isSaving}
            options={TRANSCRIPTION_SOURCES.map((s) => ({
              value: s,
              label: SOURCE_LABELS[s] ?? s,
              testId: `voice-ear-source-${s}`,
            }))}
          />
          {earSource === SERVER && (
            <p className="text-body-13 text-ink-3" data-testid="voice-transcription-hint">
              {earHint.before}
              <code className="font-mono text-ink-2">{earHint.route}</code>
              {earHint.after}
            </p>
          )}
        </div>

        {earSource === SERVER && draft?.transcriptionServer && (
          <>
            <ServerFields
              part="listening"
              server={draft.transcriptionServer}
              savedServer={savedEarServer(draft, saved)}
              disabled={isSaving}
              onChange={(next) => edit((d) => ({ ...d, transcriptionServer: next }), 'listening')}
            />
            <ServerModelField
              testId="voice-transcription"
              label="Transcription model"
              value={draft.transcriptionModel}
              listing={earListing}
              disabled={isSaving}
              containerClassName="max-w-[420px]"
              onChange={(id) => edit((d) => ({ ...d, transcriptionModel: id }), 'listening')}
            />
            <ListedLine
              testId="voice-transcription-listed"
              line={serverListedText(draft.transcriptionServer.address, earListing, 'listening')}
            />
          </>
        )}

        {earSource !== SERVER && ear && (
          <div className="flex flex-col gap-1.5">
            {ear.state === 'available' ? (
              <>
                <Select
                  label="Transcription model"
                  value={draft?.transcriptionModel ?? ''}
                  onChange={(e) => {
                    const id = e.target.value;
                    edit((d) => ({ ...d, transcriptionModel: id }), 'listening');
                  }}
                  disabled={isSaving || draft === null || earSource === null}
                  required
                  containerClassName="max-w-[420px]"
                  data-testid="voice-transcription"
                >
                  <option value="">Choose a model</option>
                  {earModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </Select>
                <p className="text-body-13 text-ink-3" data-testid="voice-transcription-listed">
                  {earListedText(ear.cacheSeconds)}
                </p>
              </>
            ) : (
              <>
                <FieldLabel>Transcription model</FieldLabel>
                <p className="text-body-13 text-warn" data-testid="voice-transcription-unavailable">
                  {earUnavailableText(ear.code, ear.detail)}
                </p>
              </>
            )}
          </div>
        )}

        <PartStatus
          part="listening"
          complete={earComplete}
          view={
            listeningKey && checks.listening?.key === listeningKey ? checks.listening : undefined
          }
          server={earSource === SERVER}
          onCheckAgain={() => {
            if (listeningKey) runCheck(listeningKey, true);
          }}
        />
      </div>

      {saveError && (
        <div className="flex flex-col gap-1" role="alert">
          <p className="text-body-13 text-warn" data-testid="voice-save-error">
            {saveError.error === 'choose_ear'
              ? 'Choose a transcription model to save.'
              : saveError.error === 'choose_voice'
                ? 'Choose a model and a voice to save.'
                : refusalText({
                    ...saveError,
                    ...(saveError.error === 'transcription_not_faithful' && draft
                      ? { model: draft.transcriptionModel }
                      : {}),
                  })}
          </p>
          {saveError.error === 'transcription_not_faithful' && saveError.heard !== undefined && (
            <p className="text-body-13 text-ink-3" data-testid="voice-save-error-help">
              {notFaithfulHelp(
                saved
                  ? destinationOf(saved.transcriptionSource, saved.transcriptionServer?.address)
                  : null,
              )}
            </p>
          )}
        </div>
      )}

      {dirty && unsaved.length > 0 && (
        <p className="text-body-13 text-ink-3" data-testid="voice-unsaved">
          Unsaved change: {unsaved.join('; ')}.
        </p>
      )}
      {dirty && <SetCtaRow onCancel={cancel} pending={isSaving} />}
    </form>
  );
}

/** Reads a server's models whenever the address (or key) on screen settles. */
function useServerModels(
  part: VoicePart,
  key: string,
  setListings: React.Dispatch<React.SetStateAction<Listings>>,
): void {
  useEffect(() => {
    if (!key) return;
    let live = true;
    const t = setTimeout(() => {
      void listServerModels(part, JSON.parse(key) as VoiceServerInput).then((r) => {
        if (!live) return;
        const listing: ServerListing = r.ok
          ? r.data.state === 'listed'
            ? { state: 'listed', models: r.data.models }
            : {
                state: 'unavailable',
                code: r.data.code,
                ...(r.data.detail ? { detail: r.data.detail } : {}),
              }
          : {
              state: 'unavailable',
              code: r.refusal.error,
              ...(r.refusal.detail ? { detail: r.refusal.detail } : {}),
            };
        setListings((l) => ({ ...l, [part]: { key, listing } }));
      });
    }, TYPING_PAUSE_MS);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [part, key, setListings]);
}

/** The address and the optional key of a server the person runs. */
function ServerFields({
  part,
  server,
  savedServer,
  disabled,
  onChange,
}: {
  part: VoicePart;
  server: ServerDraft;
  savedServer: VoiceServerView | undefined;
  disabled: boolean;
  onChange: (next: ServerDraft) => void;
}) {
  const prefix = part === 'speaking' ? 'voice-speech' : 'voice-transcription';
  const keptHere =
    savedServer?.hasKey === true &&
    trimAddress(savedServer.address) === trimAddress(server.address);
  return (
    <div className="flex flex-wrap gap-4">
      <TextInput
        label="Address"
        type="url"
        value={server.address}
        onChange={(e) => onChange({ ...server, address: e.target.value })}
        disabled={disabled}
        placeholder="http://127.0.0.1:8786/v1"
        containerClassName="min-w-[260px] flex-1"
        data-testid={`${prefix}-address`}
      />
      <TextInput
        label="Key (optional)"
        type="password"
        autoComplete="off"
        value={server.key}
        onChange={(e) => onChange({ ...server, key: e.target.value })}
        disabled={disabled}
        placeholder={keptHere ? KEY_KEPT_PLACEHOLDER : KEY_PLACEHOLDER}
        containerClassName="min-w-[200px] flex-1"
        data-testid={`${prefix}-key`}
      />
    </div>
  );
}

/**
 * A server's model: picked among those it lists, typed when it lists none,
 * and the saved one when it could not be asked.
 */
function ServerModelField({
  testId,
  label,
  value,
  listing,
  disabled,
  containerClassName,
  onChange,
}: {
  testId: string;
  label: string;
  value: string;
  listing: ServerListing | null;
  disabled: boolean;
  containerClassName: string;
  onChange: (id: string) => void;
}) {
  if (listing?.state === 'listed' && listing.models.length === 0) {
    return (
      <TextInput
        label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        placeholder="The model name your server expects"
        containerClassName={containerClassName}
        data-testid={`${testId}-typed`}
      />
    );
  }
  const ids = listing?.state === 'listed' ? listing.models.map((m) => m.id) : [];
  const shown = value && !ids.includes(value) ? [value, ...ids] : ids;
  return (
    <Select
      label={label}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled || listing?.state !== 'listed'}
      required
      containerClassName={containerClassName}
      data-testid={testId}
    >
      <option value="">Choose a model</option>
      {shown.map((id) => (
        <option key={id} value={id}>
          {id}
        </option>
      ))}
    </Select>
  );
}

function ListedLine({
  testId,
  line,
}: {
  testId: string;
  line: { text: string; route?: string; after?: string };
}) {
  return (
    <p className="text-body-13 text-ink-3" data-testid={testId}>
      {line.text}
      {line.route && <code className="font-mono text-ink-2">{line.route}</code>}
      {line.after}
    </p>
  );
}

/** Under each part, always: it answers, it does not, it is being tried, or it is incomplete. */
function PartStatus({
  part,
  complete,
  view,
  server,
  onCheckAgain,
}: {
  part: VoicePart;
  complete: boolean;
  view: CheckView | undefined;
  server: boolean;
  onCheckAgain: () => void;
}) {
  const testId = `voice-${part}-status`;
  const again = (
    <PrimaryButton
      type="button"
      variant="neutral"
      size="sm"
      onClick={onCheckAgain}
      data-testid={`voice-${part}-check-again`}
    >
      Check again
    </PrimaryButton>
  );
  if (!complete) {
    return (
      <div role="status" className="rounded-lg bg-hover px-3 py-2.5" data-testid={testId}>
        <span className="text-body-13 text-ink-2">
          <strong className="font-medium">Not checked yet.</strong> {notCheckedText(part)}
        </span>
      </div>
    );
  }
  if (!view || view.state === 'checking') {
    return (
      <div role="status" className="rounded-lg bg-hover px-3 py-2.5" data-testid={testId}>
        <span className="text-body-13 text-ink-3">Trying the sample “OK.”…</span>
      </div>
    );
  }
  if (view.state === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center gap-2.5 rounded-lg bg-warn/10 px-3 py-2.5"
        data-testid={testId}
      >
        <span className="flex-1 text-body-13 text-warn">{refusalText(view.refusal)}</span>
        {again}
      </div>
    );
  }
  const c = view.check;
  if (c.state === 'answers') {
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-2.5 rounded-lg bg-ok/10 px-3 py-2.5"
        data-testid={testId}
      >
        <span className="size-2.5 shrink-0 rounded-full bg-ok" aria-hidden />
        <span className="min-w-[240px] flex-1 text-body-13 text-ink">
          <strong className="font-medium text-ok">Answers.</strong>{' '}
          {part === 'listening'
            ? `${c.model} wrote back the sample “OK.” in ${secondsOf(c.latencyMs)}.`
            : `${c.model} spoke the sample.`}{' '}
          Checked at {clockOf(c.checkedAt)}.
        </span>
        {again}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-2.5 rounded-lg bg-warn/10 px-3 py-2.5"
      data-testid={testId}
    >
      <span className="size-2.5 shrink-0 rounded-full bg-warn" aria-hidden />
      <span className="flex min-w-[240px] flex-1 flex-col gap-1">
        <span className="text-body-13 text-ink">
          <strong className="font-medium text-warn">Not answering.</strong> {notAnsweringText(c)}{' '}
          Checked at {clockOf(c.checkedAt)}.
        </span>
        {server && c.code === 'speech_unreachable' && (
          <span className="text-body-13 text-ink-3" data-testid={`voice-${part}-status-help`}>
            {serverDownHelp(part)}
          </span>
        )}
      </span>
      {again}
    </div>
  );
}
