'use client';

/**
 * VoiceListeningForm — which model turns what you SAY into text.
 *
 * Machine-global, unlike the speaking voice, which belongs to each agent: there
 * is one microphone. It exists because the choice used to be a constant in the
 * code, and a constant nobody revisits is how the voice mode spent weeks on a
 * route that took 3.5 seconds and dropped a word every other turn.
 *
 * The model is a free-text field rather than a list. Any list here would be a
 * copy of a vendor catalogue that moves weekly, and a build that cannot name a
 * model released last week is worse than one that passes the name through and
 * reports the vendor's own refusal.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { setTranscriptionChoiceAction } from '@/lib/actions.ts';
import { SetForm } from '@/components/ui/SetForm.tsx';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';

interface Props {
  initialProvider: string;
  initialModel: string;
  available: string[];
}

/**
 * Models measured on this install, offered as hints rather than as the only
 * choices. Same audio, same instruction, four passes each, 2026-08-11 — the
 * numbers are here because "which one is better" is otherwise unanswerable
 * from a settings page.
 */
const SUGGESTIONS = [
  'mistralai/voxtral-small-24b-2507',
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
];

export default function VoiceListeningForm({ initialProvider, initialModel, available }: Props) {
  const [provider, setProvider] = useState(initialProvider);
  const [model, setModel] = useState(initialModel);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    startTransition(async () => {
      const r = await setTranscriptionChoiceAction({ provider, model });
      if (!r.ok) toast.error(r.message);
      else toast.success('Listening updated.');
    });
  }

  return (
    <form onSubmit={handleSubmit}>
      <SetForm>
        <div className="space-y-3">
          <p className="text-body-13 leading-[1.5]! text-ink-3">
            Which model turns what you say into text on the Voice page. Measured here:{' '}
            <span className="whitespace-nowrap">voxtral-small</span> takes about 1.4s and gets it
            right every time; <span className="whitespace-nowrap">gemini-2.5-flash</span> through
            Google directly takes 3.5s and drops a word about half the time.
          </p>
          <Select label="Provider" value={provider} onChange={(e) => setProvider(e.target.value)}>
            {/* First and default: the route already picks the fastest measured
                route, so an install that never opens this page gets it. */}
            <option value="">Default</option>
            {available.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
          <div>
            <TextInput
              label="Model"
              list="stt-model-options"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="mistralai/voxtral-small-24b-2507"
            />
            <datalist id="stt-model-options">
              {SUGGESTIONS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <p className="mt-1 text-legacy-11 text-ink-4">
              Leave empty to use the provider&rsquo;s default.
            </p>
          </div>
        </div>
        <SetCtaRow
          onCancel={() => {
            setProvider(initialProvider);
            setModel(initialModel);
          }}
          pending={isPending}
        />
      </SetForm>
    </form>
  );
}
