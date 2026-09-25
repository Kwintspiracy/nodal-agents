'use client';

/**
 * RunBudgetSection — ce qu'un run peut coûter et combien de temps il peut
 * travailler, pour tout l'espace (issue #442).
 *
 * Le plafond de coût existait déjà dans le runner (2 $, garde 1e), mais il se
 * réglait par une variable d'environnement que personne ne voyait, et il
 * arrêtait le run en jetant ce qu'il avait écrit. Il se règle ici, à côté des
 * autres bornes d'un run, et le runner livre désormais le travail fait avant
 * l'arrêt.
 *
 * `0` = aucun plafond, dit en toutes lettres sous chaque champ. Aucun
 * ConfirmDialog : relever ou baisser un plafond ne donne aucun pouvoir à un
 * agent ; au pire un run s'arrête plus tôt, avec ce qu'il a écrit.
 */

import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { RUN_COST_MAX_USD, RUN_HOURS_MAX } from '@nodal-agents/shared';
import { setRunBudgetAction, type RunBudgetView } from '@/lib/actions.ts';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import { runBudgetSentence } from './run-budget-copy.ts';

export default function RunBudgetSection({ initial }: { initial: RunBudgetView }) {
  const [saved, setSaved] = useState({ cost: initial.maxRunCostUsd, hours: initial.maxRunHours });
  const [costInput, setCostInput] = useState(String(initial.maxRunCostUsd));
  const [hoursInput, setHoursInput] = useState(String(initial.maxRunHours));
  const [isPending, startTransition] = useTransition();

  const cost = Number(costInput);
  const hours = Number(hoursInput);
  const costError =
    costInput.trim() === '' || !Number.isFinite(cost) || cost < 0 || cost > RUN_COST_MAX_USD
      ? `Enter a number from 0 to ${RUN_COST_MAX_USD}.`
      : undefined;
  const hoursError =
    hoursInput.trim() === '' || !Number.isFinite(hours) || hours < 0 || hours > RUN_HOURS_MAX
      ? `Enter a number from 0 to ${RUN_HOURS_MAX}.`
      : undefined;
  const dirty = cost !== saved.cost || hours !== saved.hours;

  function handleSave() {
    if (costError || hoursError || !dirty) return;
    startTransition(async () => {
      const r = await setRunBudgetAction({ maxRunCostUsd: cost, maxRunHours: hours });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      setSaved({ cost, hours });
      toast.success('Run budget saved.');
    });
  }

  const locked = !initial.isOwner || isPending;

  return (
    <div className="rounded-xl border border-rule-2 bg-paper px-[18px] py-4">
      <div className="flex items-center gap-2">
        <span className="text-medium-14 text-ink">Run budget</span>
        <MonoMicroTag tone="err">owner only</MonoMicroTag>
      </div>
      <p className="mt-1 text-body-13 leading-[1.4]! text-ink-3" data-testid="run-budget-sentence">
        {runBudgetSentence(saved.cost, saved.hours)}
      </p>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <TextInput
          label="Cost of one run (USD)"
          type="number"
          min={0}
          max={RUN_COST_MAX_USD}
          step={0.5}
          value={costInput}
          onChange={(e) => setCostInput(e.target.value)}
          disabled={locked}
          error={costError}
          className="w-32 font-mono"
          data-testid="run-budget-cost"
        />
        <TextInput
          label="Working time of one run (hours)"
          type="number"
          min={0}
          max={RUN_HOURS_MAX}
          step={0.5}
          value={hoursInput}
          onChange={(e) => setHoursInput(e.target.value)}
          disabled={locked}
          error={hoursError}
          className="w-32 font-mono"
          data-testid="run-budget-hours"
        />
      </div>
      <p className="mt-2 text-body-12 text-ink-4">
        0 means no ceiling. Waiting for an approval or for another agent does not count as work.
      </p>

      <div className="mt-3">
        <PrimaryButton
          variant="neutral"
          type="button"
          onClick={handleSave}
          disabled={locked || !dirty || !!costError || !!hoursError}
          data-testid="run-budget-save"
        >
          {isPending ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>

      {!initial.isOwner && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change this setting.
        </p>
      )}
    </div>
  );
}
