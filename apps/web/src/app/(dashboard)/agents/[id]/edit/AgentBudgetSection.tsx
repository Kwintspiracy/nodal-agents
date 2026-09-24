'use client';

/**
 * AgentBudgetSection — le budget de l'agent, tous fournisseurs confondus
 * (issue #447).
 *
 * Décision de Quentin, 23/09 : un budget par agent, dans son onglet Settings,
 * qui compte ENSEMBLE les appels d'API de n'importe quel fournisseur et les
 * runs des CLI de code. Avant, le seul champ bornait les runs de CLI de code,
 * vivait dans la carte d'approbation de l'onglet Autonomy, et n'apparaissait
 * que si ce groupe d'outils était actif.
 *
 * Ce qui est dépensé vient de l'action, qui lit la MÊME somme que le runner
 * et la garde des CLI (`readAgentBudgetState`) : l'écran ne peut pas dire
 * autre chose que ce que la machine applique.
 *
 * Atteint, un plafond arrête les runs de l'agent entre deux tours, en livrant
 * ce qu'ils ont écrit, jusqu'à la fin de la fenêtre. C'est la pause : la
 * section la dit en tête, en rouge, avec l'heure où elle se lève.
 */

import { useCallback, useEffect, useState, useTransition } from 'react';
import { toast } from 'sonner';
import {
  AGENT_BUDGET_ALERT_MAX_PCT,
  AGENT_BUDGET_ALERT_MIN_PCT,
  AGENT_BUDGET_DAILY_MAX_USD,
  AGENT_BUDGET_MONTHLY_MAX_USD,
} from '@nodal-agents/shared';
import { getAgentBudgetAction, setAgentBudgetAction, type AgentBudgetView } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import { budgetStatus } from './agent-budget-copy.ts';

export default function AgentBudgetSection({
  agentId,
  canChange,
}: {
  agentId: string;
  canChange: boolean;
}) {
  const [view, setView] = useState<AgentBudgetView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [alert, setAlert] = useState('');
  const [isPending, startTransition] = useTransition();

  const load = useCallback(async () => {
    const r = await getAgentBudgetAction(agentId);
    if (!r.ok) {
      setLoadError(r.message);
      return;
    }
    setView(r.data);
    setDaily(String(r.data.dailyUsd));
    setMonthly(String(r.data.monthlyUsd));
    setAlert(String(r.data.alertPct));
  }, [agentId]);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (!cancelled) void load();
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  if (loadError) {
    return <p className="text-body-13 text-err">{loadError}</p>;
  }
  if (!view) {
    return <p className="text-body-13 text-ink-4">Loading the budget…</p>;
  }

  const d = Number(daily);
  const m = Number(monthly);
  const a = Number(alert);
  const errors = {
    daily:
      daily.trim() === '' || !Number.isFinite(d) || d < 0 || d > AGENT_BUDGET_DAILY_MAX_USD
        ? `Enter a number from 0 to ${AGENT_BUDGET_DAILY_MAX_USD}.`
        : undefined,
    monthly:
      monthly.trim() === '' || !Number.isFinite(m) || m < 0 || m > AGENT_BUDGET_MONTHLY_MAX_USD
        ? `Enter a number from 0 to ${AGENT_BUDGET_MONTHLY_MAX_USD}.`
        : undefined,
    alert:
      !Number.isInteger(a) || a < AGENT_BUDGET_ALERT_MIN_PCT || a > AGENT_BUDGET_ALERT_MAX_PCT
        ? `Enter a whole number from ${AGENT_BUDGET_ALERT_MIN_PCT} to ${AGENT_BUDGET_ALERT_MAX_PCT}.`
        : undefined,
  };
  const invalid = !!(errors.daily || errors.monthly || errors.alert);
  const dirty = d !== view.dailyUsd || m !== view.monthlyUsd || a !== view.alertPct;
  const status = budgetStatus(view);

  function save() {
    if (invalid || !dirty) return;
    startTransition(async () => {
      const r = await setAgentBudgetAction({ agentId, dailyUsd: d, monthlyUsd: m, alertPct: a });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success('Budget saved.');
      await load();
    });
  }

  return (
    <div data-testid="agent-budget">
      {status && (
        <p
          data-testid="agent-budget-status"
          className={`mb-3 rounded-lg px-3 py-2 text-body-13 ${
            status.tone === 'err' ? 'bg-err/10 text-err' : 'bg-warn/10 text-warn'
          }`}
        >
          {status.text}
        </p>
      )}

      <dl className="grid grid-cols-2 gap-3 text-body-13" data-testid="agent-budget-spend">
        <div>
          <dt className="text-ink-4">Spent today</dt>
          <dd className="font-mono text-ink">
            ${view.todayUsd.toFixed(2)}
            {view.dailyUsd > 0 && (
              <span className="text-ink-4"> of ${view.dailyUsd.toFixed(2)}</span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-ink-4">Spent this month</dt>
          <dd className="font-mono text-ink">
            ${view.monthUsd.toFixed(2)}
            {view.monthlyUsd > 0 && (
              <span className="text-ink-4"> of ${view.monthlyUsd.toFixed(2)}</span>
            )}
          </dd>
        </div>
      </dl>

      <div className="mt-4 flex flex-wrap items-start gap-4">
        <TextInput
          label="Daily ceiling (USD)"
          type="number"
          min={0}
          max={AGENT_BUDGET_DAILY_MAX_USD}
          step={1}
          value={daily}
          onChange={(e) => setDaily(e.target.value)}
          disabled={!canChange || isPending}
          error={errors.daily}
          className="w-32 font-mono"
          data-testid="agent-budget-daily"
        />
        <TextInput
          label="Monthly ceiling (USD)"
          type="number"
          min={0}
          max={AGENT_BUDGET_MONTHLY_MAX_USD}
          step={5}
          value={monthly}
          onChange={(e) => setMonthly(e.target.value)}
          disabled={!canChange || isPending}
          error={errors.monthly}
          className="w-32 font-mono"
          data-testid="agent-budget-monthly"
        />
        <TextInput
          label="Warn from (%)"
          type="number"
          min={AGENT_BUDGET_ALERT_MIN_PCT}
          max={AGENT_BUDGET_ALERT_MAX_PCT}
          step={5}
          value={alert}
          onChange={(e) => setAlert(e.target.value)}
          disabled={!canChange || isPending}
          error={errors.alert}
          className="w-24 font-mono"
          data-testid="agent-budget-alert"
        />
      </div>
      <p className="mt-2 text-body-12 text-ink-4">
        0 means no ceiling. API calls of every provider and coding CLI runs count together. Days and
        months follow the workspace time zone ({view.timezone}).
      </p>
      <div className="mt-3">
        <PrimaryButton
          variant="neutral"
          type="button"
          onClick={save}
          disabled={!canChange || isPending || !dirty || invalid}
          data-testid="agent-budget-save"
        >
          {isPending ? 'Saving…' : 'Save'}
        </PrimaryButton>
      </div>
      {!canChange && (
        <p className="mt-2 text-body-12 text-ink-4">
          Only the workspace owner can change this budget.
        </p>
      )}
    </div>
  );
}
