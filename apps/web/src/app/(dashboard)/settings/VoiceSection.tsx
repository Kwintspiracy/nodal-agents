'use client';

/**
 * VoiceSection — Réglages → Workspace → Voice (#969) : la voix avec laquelle
 * Nodal parle, dans chaque tour dit et pour l'audio que génère un agent.
 *
 * Le propriétaire, 03/11 : « tu pourrais mettre un réglage dans Nodal qui me
 * permette de switcher de voix quand je veux pour tester ? ».
 *
 * L'écran est un client des routes du runner, par la porte web, comme un
 * module (règle du #948) : il LIT la voix enregistrée et ce que chaque source
 * offre (`GET /api/voice/setting`), ENREGISTRE un choix (`PUT`), et fait
 * entendre une voix (`POST /api/voice/sample`) par le chemin même du tour.
 *
 * Ce que l'écran montre est ce que le moteur applique (règle du 01/11) : la
 * voix affichée est la ligne en base, et aucun choix n'est fait à la place de
 * la personne. Changer de source vide le modèle et la voix : le premier de la
 * liste serait un choix que personne n'a fait. Une source sans clé, une liste
 * que le fournisseur n'a pas pu dire, un refus : chacun se dit, sous le champ
 * qu'il concerne (invariant #4).
 *
 * « Play a sample » fait entendre la voix QUE L'ÉCRAN MONTRE, enregistrée ou
 * non : c'est pour comparer avant de choisir. Elle passe par la même
 * résolution et la même file de phrases que le tour (`openReplyVoice`).
 */

import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Play, Stop } from '@phosphor-icons/react';
import {
  VOICE_SOURCES,
  type VoiceSetting,
  type VoiceSource,
  type VoiceState,
} from '@nodal-agents/shared';
import PrimaryButton from '@/components/ui/PrimaryButton';
import SegmentedControl from '@/components/ui/SegmentedControl';
import Select from '@/components/ui/Select';
import FieldLabel from '@/components/ui/FieldLabel';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import { startSpokenStream, stopSpeaking, useSpeaking } from '../chat/voice-playback.ts';
import {
  playVoiceSample,
  readVoiceState,
  saveVoiceSetting,
  type VoiceRefusal,
} from './voice-setting-client.ts';
import {
  SAMPLE_SENTENCE,
  SOURCE_LABELS,
  listedText,
  refusalText,
  sampleErrorText,
  settingProblemText,
  sourceUnavailableText,
} from './voice-copy.ts';

type Draft = { source: VoiceSource; model: string; voice: string };

const same = (a: Draft | null, b: VoiceSetting | null): boolean =>
  a !== null && b !== null && a.source === b.source && a.model === b.model && a.voice === b.voice;

export default function VoiceSection() {
  const [state, setState] = useState<VoiceState | null>(null);
  const [loadError, setLoadError] = useState<VoiceRefusal | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [sampleError, setSampleError] = useState<{ text: string; detail?: string } | null>(null);
  /** L'essai est demandé et sa voix arrive encore. */
  const [playing, setPlaying] = useState(false);
  const [isSaving, startSaving] = useTransition();
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
      setDraft(r.data.setting);
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

  const saved = state.setting;
  const source = draft?.source ?? null;
  const choices = source ? state.sources.find((s) => s.source === source) : undefined;
  const models = choices?.state === 'available' ? choices.models : [];
  const model = models.find((m) => m.id === draft?.model);
  const complete =
    draft !== null && model !== undefined && model.voices.some((v) => v.id === draft.voice);
  const dirty = draft !== null && !same(draft, saved);

  function pickSource(next: VoiceSource) {
    setSaveError(null);
    setSampleError(null);
    if (draft?.source === next) return;
    // Rien n'est choisi à la place de la personne : le modèle et la voix restent à choisir.
    setDraft({ source: next, model: '', voice: '' });
  }

  function pickModel(id: string) {
    setSaveError(null);
    setSampleError(null);
    if (!draft) return;
    const offers = models.find((m) => m.id === id)?.voices ?? [];
    // La voix choisie reste si le nouveau modèle l'offre aussi.
    setDraft({
      ...draft,
      model: id,
      voice: offers.some((v) => v.id === draft.voice) ? draft.voice : '',
    });
  }

  function pickVoice(id: string) {
    setSaveError(null);
    setSampleError(null);
    if (draft) setDraft({ ...draft, voice: id });
  }

  function cancel() {
    setSaveError(null);
    setSampleError(null);
    setDraft(saved);
  }

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (!draft || !dirty) return;
    if (!complete) {
      setSaveError('Choose a model and a voice to save.');
      return;
    }
    const setting = draft;
    startSaving(async () => {
      const r = await saveVoiceSetting(setting);
      if (!r.ok) {
        setSaveError(refusalText(r.refusal));
        return;
      }
      setState((s) => (s ? { sources: s.sources, setting } : s));
      toast.success('Voice saved. The next turn speaks with it.');
    });
  }

  async function sample() {
    if (!draft || !complete) return;
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
      ...(dirty ? { setting: draft } : {}),
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

  return (
    <form onSubmit={save} className="flex flex-col gap-4" data-testid="voice-section">
      {!saved && state.settingProblem && (
        <p className="text-body-13 text-warn" role="alert" data-testid="voice-setting-problem">
          {settingProblemText(state.settingProblem.code)}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <FieldLabel>Source</FieldLabel>
        <SegmentedControl<VoiceSource>
          ariaLabel="Voice source"
          value={source}
          onChange={pickSource}
          disabled={isSaving}
          options={VOICE_SOURCES.map((s) => ({
            value: s,
            label: SOURCE_LABELS[s] ?? s,
            testId: `voice-source-${s}`,
          }))}
        />
        {choices?.state === 'unavailable' && (
          <p className="text-body-13 text-warn" data-testid="voice-source-unavailable">
            {sourceUnavailableText(choices.source, choices.code, choices.detail)}
          </p>
        )}
      </div>

      {choices?.state === 'available' && (
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
              onChange={(e) => pickVoice(e.target.value)}
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
            {listedText(choices.source, choices.cacheSeconds)}
          </p>
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
            disabled={!complete || isSaving}
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

      {saveError && (
        <p className="text-body-13 text-warn" role="alert" data-testid="voice-save-error">
          {saveError}
        </p>
      )}

      {dirty && <SetCtaRow onCancel={cancel} pending={isSaving} />}
    </form>
  );
}
