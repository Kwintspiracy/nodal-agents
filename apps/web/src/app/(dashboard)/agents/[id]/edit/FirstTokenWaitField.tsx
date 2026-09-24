'use client';

/**
 * FirstTokenWaitField — combien de temps un appel au modèle peut rester muet
 * avant son premier mot, pour CET agent (issue #442).
 *
 * Vide : la plateforme décide (2 min, relevées avec la taille du contexte et
 * l'effort de raisonnement, packages/llm/src/turn-clocks.ts). Posée, la valeur
 * REMPLACE ce calcul, dans les deux sens : c'est ce qui permet de donner dix
 * minutes à un agent dont le modèle réfléchit longtemps sans toucher aux autres.
 *
 * Son propre fichier et sa propre action, enregistrés tout de suite comme le
 * budget du CLI de code : ce n'est pas l'identité de l'agent, que la barre
 * d'enregistrement du bas couvre.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { FIRST_TOKEN_WAIT_MAX_S, FIRST_TOKEN_WAIT_MIN_S } from '@nodal-agents/shared';
import { setAgentFirstTokenWaitAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';

export default function FirstTokenWaitField({
  agentId,
  initialSeconds,
  canChange,
}: {
  agentId: string;
  /** `null` : la plateforme décide. */
  initialSeconds: number | null;
  canChange: boolean;
}) {
  const [saved, setSaved] = useState<number | null>(initialSeconds);
  const [input, setInput] = useState(initialSeconds === null ? '' : String(initialSeconds));
  const [isPending, startTransition] = useTransition();

  const trimmed = input.trim();
  const value = trimmed === '' ? null : Number(trimmed);
  const error =
    value !== null &&
    (!Number.isInteger(value) || value < FIRST_TOKEN_WAIT_MIN_S || value > FIRST_TOKEN_WAIT_MAX_S)
      ? `Enter whole seconds from ${FIRST_TOKEN_WAIT_MIN_S} to ${FIRST_TOKEN_WAIT_MAX_S}, or leave it empty.`
      : undefined;
  const dirty = value !== saved;

  function save(next: number | null) {
    startTransition(async () => {
      const r = await setAgentFirstTokenWaitAction({ agentId, seconds: next });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setSaved(next);
      setInput(next === null ? '' : String(next));
      toast.success(
        next === null
          ? 'The platform now decides how long a call waits for its first word.'
          : `A call now waits up to ${next} s for its first word.`,
      );
    });
  }

  return (
    <div className="mt-4" data-testid="first-token-wait">
      <div className="flex flex-wrap items-end gap-2">
        <TextInput
          label="Wait for the first word (seconds)"
          type="number"
          min={FIRST_TOKEN_WAIT_MIN_S}
          max={FIRST_TOKEN_WAIT_MAX_S}
          step={30}
          placeholder="Platform decides"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={!canChange || isPending}
          error={error}
          className="w-40 font-mono"
          data-testid="first-token-wait-input"
        />
        <PrimaryButton
          variant="neutral"
          type="button"
          onClick={() => save(value)}
          disabled={!canChange || isPending || !dirty || !!error}
          data-testid="first-token-wait-save"
        >
          {isPending ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
      <p className="mt-1 text-body-12 text-ink-4">
        {saved === null
          ? 'Empty: 2 minutes, raised for a long context or a high reasoning effort. Set it for a model that thinks long before it writes.'
          : `Set for this agent: ${saved} s, whatever the context or the reasoning effort. Empty the field and save to let the platform decide.`}
      </p>
    </div>
  );
}
