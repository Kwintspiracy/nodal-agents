'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { codeTaskDoctorAction } from '@/lib/actions.ts';
import PrimaryButton from '@/components/ui/PrimaryButton';
import TextInput from '@/components/ui/TextInput';
import Select from '@/components/ui/Select';
import Switch from '@/components/ui/Switch';

// ProviderRow — one row per coding-CLI provider (Claude Code / Codex): a
// health check (Test → codeTaskDoctorAction) on top, and its model/effort
// defaults underneath (agents.cli_defaults, migration 0074). Lives in the
// Tools tab (ToolsTabContent.tsx), inside the code-task tool group's
// configuration panel — moved out of the Autonomy tab's CodeTaskSection,
// which now only owns the Yolo toggle and the daily budget (Quentin's
// correction: autonomy and capability configuration are different concerns).
//
// Model/effort are now dropdowns fed by the doctor's own `models`/`efforts`
// lists (the runner's read of the CLI's own alias list / local model cache —
// never a hardcoded catalog we'd have to keep in sync). The doctor runs once
// on mount (not just on "Test" click) so the dropdowns are populated without
// an extra click; "Test" re-runs the same probe. Effort is a closed enum
// (no free entry). Model additionally offers "Custom…" because codex's cache
// can miss a model, and claude accepts full model names beyond its 3 stable
// aliases — the CLI is the source of truth for what it accepts, and a bad
// value fails loud at the next run rather than being pre-validated here.

export type DoctorState =
  | { state: 'idle' }
  | { state: 'testing' }
  | { state: 'pass'; message: string }
  | { state: 'fail'; message: string };

const MODEL_CUSTOM = '__custom__';

export function ProviderRow({
  label,
  provider,
  defaults,
  enabled = true,
  toggleLocked = false,
  onToggleEnabled,
  onSaveDefaults,
}: {
  label: string;
  provider: 'claude' | 'codex';
  defaults: { model?: string; effort?: string; enabled?: boolean } | undefined;
  /** Owner allow-flag — false: the agent cannot call this provider via code_task. */
  enabled?: boolean;
  /** True when this is the LAST enabled provider — the switch locks on. */
  toggleLocked?: boolean;
  /** Absent = no allow-toggle rendered (the runtime card reuses this row without one). */
  onToggleEnabled?: (next: boolean) => void | Promise<void>;
  onSaveDefaults: (model: string | null, effort: string | null) => void | Promise<void>;
}) {
  const savedModel = defaults?.model ?? '';
  const savedEffort = defaults?.effort ?? '';

  const [doctorState, setDoctorState] = useState<DoctorState>({ state: 'idle' });
  const [models, setModels] = useState<string[] | null>(null);
  const [efforts, setEfforts] = useState<string[]>([]);

  // '' = CLI default, MODEL_CUSTOM = free entry (see customModel), else one
  // of `models`. Starts as the saved value so the free-text field is correct
  // even before the doctor has resolved the catalog.
  const [modelChoice, setModelChoice] = useState<string>(savedModel ? MODEL_CUSTOM : '');
  const [customModel, setCustomModel] = useState<string>(savedModel);
  const [effort, setEffort] = useState<string>(savedEffort);
  const [savingDefaults, setSavingDefaults] = useState(false);

  // Resolve the saved model against the catalog exactly once, the first time
  // it loads — a known alias/model pre-selects the dropdown, an unknown one
  // (or no catalog at all) stays in free-entry mode. Guarded so re-running
  // the doctor via "Test" doesn't stomp on an in-progress edit.
  const resolvedRef = useRef(false);
  useEffect(() => {
    if (resolvedRef.current || models === null) return;
    resolvedRef.current = true;
    if (savedModel && models.includes(savedModel)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setModelChoice(savedModel);
    }
  }, [models, savedModel]);

  const runDoctor = useCallback(async () => {
    setDoctorState({ state: 'testing' });
    const result = await codeTaskDoctorAction({ provider });
    if (!result.ok) {
      setDoctorState({ state: 'fail', message: result.message });
      return;
    }
    const report = result.data;
    setModels(report.models);
    setEfforts(report.efforts);
    if (report.binaryFound && report.loggedIn !== 'no') {
      setDoctorState({
        state: 'pass',
        message: `${report.version ?? 'installed'} (logged in: ${report.loggedIn})`,
      });
    } else {
      setDoctorState({ state: 'fail', message: report.fix ?? 'Not available on this machine.' });
    }
  }, [provider]);

  useEffect(() => {
    // Probe on mount so the dropdowns are populated without an extra click;
    // "Test" below re-runs the same function.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void runDoctor();
  }, [runDoctor]);

  async function handleSave() {
    const finalModel =
      models === null || modelChoice === MODEL_CUSTOM
        ? customModel.trim() || null
        : modelChoice || null;
    const finalEffort = effort || null;
    setSavingDefaults(true);
    await onSaveDefaults(finalModel, finalEffort);
    setSavingDefaults(false);
  }

  // Effort options always include the currently-saved value even if the
  // doctor hasn't resolved yet (or a stale value fell out of the CLI's own
  // list) — the select must never silently drop what's actually saved.
  const effortOptions = Array.from(new Set([...efforts, ...(effort ? [effort] : [])]));

  return (
    <div className={`rounded-lg border border-rule-2 px-3 py-2.5 ${enabled ? '' : 'bg-canvas/50'}`}>
      <div className="flex items-center justify-between gap-3">
        {onToggleEnabled && (
          <div className="flex shrink-0 items-center">
            <Switch
              checked={enabled}
              onChange={() => {
                if (!toggleLocked) void onToggleEnabled(!enabled);
              }}
              disabled={toggleLocked}
              ariaLabel={`Allow ${label} for this agent`}
              trackClassName={enabled ? 'border-ok/40 bg-ok/20' : 'border-rule-2 bg-canvas'}
              thumbClassName={enabled ? 'translate-x-[18px] bg-ok' : 'translate-x-[2px] bg-ink-3'}
            />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <div className={`text-body-13 ${enabled ? 'text-ink' : 'text-ink-4'}`}>
            {label}
            {toggleLocked && (
              <span className="ml-2 text-body-12 text-ink-4">at least one provider stays on</span>
            )}
            {!enabled && <span className="ml-2 text-body-12 text-ink-4">off for this agent</span>}
          </div>
          {enabled && doctorState.state === 'pass' && (
            <div className="mt-1 rounded-md border border-ok/30 bg-ok-bg px-2 py-1 text-body-12 text-ok">
              {doctorState.message}
            </div>
          )}
          {enabled && doctorState.state === 'fail' && (
            <div className="mt-1 rounded-md border border-err/30 bg-warn-bg px-2 py-1 text-body-12 text-err break-all">
              {doctorState.message}
            </div>
          )}
        </div>
        <PrimaryButton
          variant="neutral"
          type="button"
          onClick={() => void runDoctor()}
          disabled={doctorState.state === 'testing' || !enabled}
        >
          {doctorState.state === 'testing' ? 'Testing…' : 'Test'}
        </PrimaryButton>
      </div>

      {enabled && (
        <>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            {models === null ? (
              <TextInput
                label="Model"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="CLI default"
                className="font-mono"
                containerClassName="min-w-40 flex-1"
              />
            ) : (
              <Select
                label="Model"
                value={modelChoice}
                onChange={(e) => setModelChoice(e.target.value)}
                containerClassName="min-w-40 flex-1"
              >
                <option value="">CLI default</option>
                {models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value={MODEL_CUSTOM}>Custom…</option>
              </Select>
            )}

            <Select
              label="Effort"
              value={effort}
              onChange={(e) => setEffort(e.target.value)}
              containerClassName="w-32 shrink-0"
            >
              <option value="">CLI default</option>
              {effortOptions.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </Select>

            <PrimaryButton
              variant="neutral"
              type="button"
              onClick={() => void handleSave()}
              disabled={savingDefaults}
            >
              {savingDefaults ? 'Saving…' : 'Save'}
            </PrimaryButton>
          </div>

          {models !== null && modelChoice === MODEL_CUSTOM && (
            <TextInput
              value={customModel}
              onChange={(e) => setCustomModel(e.target.value)}
              placeholder="Full model name"
              className="mt-2 font-mono"
            />
          )}
        </>
      )}
    </div>
  );
}
