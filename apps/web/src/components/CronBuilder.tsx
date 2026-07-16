'use client';

import { useMemo, useState } from 'react';
import {
  buildCron,
  detectMode,
  parseCron,
  type BuildCronInput,
  type FrequencyMode,
} from '@/lib/cron.ts';
import Select from '@/components/ui/Select';
import TextInput from '@/components/ui/TextInput';
import ToggleChip from '@/components/ui/ToggleChip';

interface Props {
  /** Hidden input name — keeps form data flow (`name="cronExpr"` by default). */
  name?: string;
  /** Cron expression to seed (edit mode). */
  initial?: string;
}

const DAYS = [
  { n: 1, label: 'Mon' },
  { n: 2, label: 'Tue' },
  { n: 3, label: 'Wed' },
  { n: 4, label: 'Thu' },
  { n: 5, label: 'Fri' },
  { n: 6, label: 'Sat' },
  { n: 0, label: 'Sun' },
];

const PRESET_INTERVALS = [1, 5, 10, 15, 30];

export default function CronBuilder({ name = 'cronExpr', initial }: Props) {
  const seed = useMemo<{ mode: FrequencyMode; values: BuildCronInput }>(
    () =>
      initial ? detectMode(initial) : { mode: 'daily', values: { mode: 'daily', time: '09:00' } },
    [initial],
  );

  const [mode, setMode] = useState<FrequencyMode>(seed.mode);
  const [everyMinutes, setEveryMinutes] = useState<number>(seed.values.everyMinutes ?? 5);
  const [time, setTime] = useState<string>(seed.values.time ?? '09:00');
  const [weekdays, setWeekdays] = useState<number[]>(seed.values.weekdays ?? [1, 2, 3, 4, 5]);
  const [dayOfMonth, setDayOfMonth] = useState<number>(seed.values.dayOfMonth ?? 1);
  const [custom, setCustom] = useState<string>(seed.values.custom ?? initial ?? '0 9 * * *');

  const expr = useMemo<string>(() => {
    const input: BuildCronInput = { mode, everyMinutes, time, weekdays, dayOfMonth, custom };
    return buildCron(input);
  }, [mode, everyMinutes, time, weekdays, dayOfMonth, custom]);

  const preview = useMemo(() => parseCron(expr), [expr]);

  function toggleWeekday(n: number) {
    setWeekdays((prev) => (prev.includes(n) ? prev.filter((d) => d !== n) : [...prev, n].sort()));
  }

  return (
    <div className="space-y-3">
      {/* eslint-disable-next-line no-restricted-syntax -- native hidden field
          carrying the derived cron expression into the enclosing form's
          FormData; not a visible field, no design-system counterpart. */}
      <input type="hidden" name={name} value={expr} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="cron-mode" className="block text-xs text-ink-3 mb-1">
            Frequency
          </label>
          <Select
            id="cron-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as FrequencyMode)}
            className="bg-hover"
          >
            <option value="minutes">Every N minutes</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="custom">Custom (cron)</option>
          </Select>
        </div>

        {mode === 'minutes' && (
          <div>
            <label htmlFor="cron-every" className="block text-xs text-ink-3 mb-1">
              Every
            </label>
            <Select
              id="cron-every"
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(parseInt(e.target.value, 10))}
              className="bg-hover"
            >
              {PRESET_INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'minute' : 'minutes'}
                </option>
              ))}
            </Select>
          </div>
        )}

        {mode === 'hourly' && (
          <div>
            <label htmlFor="cron-min-of-hour" className="block text-xs text-ink-3 mb-1">
              At minute
            </label>
            <TextInput
              id="cron-min-of-hour"
              type="number"
              min={0}
              max={59}
              value={parseInt(time.split(':')[1] ?? '0', 10)}
              onChange={(e) => {
                const n = Math.max(0, Math.min(59, parseInt(e.target.value || '0', 10)));
                setTime(`00:${String(n).padStart(2, '0')}`);
              }}
              className="bg-hover"
            />
          </div>
        )}

        {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
          <div>
            <label htmlFor="cron-time" className="block text-xs text-ink-3 mb-1">
              Time
            </label>
            <TextInput
              id="cron-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="bg-hover"
            />
          </div>
        )}
      </div>

      {mode === 'weekly' && (
        <div>
          <label className="block text-xs text-ink-3 mb-1">Days</label>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => (
              <ToggleChip
                key={d.n}
                active={weekdays.includes(d.n)}
                onClick={() => toggleWeekday(d.n)}
              >
                {d.label}
              </ToggleChip>
            ))}
          </div>
        </div>
      )}

      {mode === 'monthly' && (
        <div>
          <label htmlFor="cron-dom" className="block text-xs text-ink-3 mb-1">
            Day of month
          </label>
          <TextInput
            id="cron-dom"
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) =>
              setDayOfMonth(Math.max(1, Math.min(31, parseInt(e.target.value || '1', 10))))
            }
            className="w-32 bg-hover"
          />
        </div>
      )}

      {mode === 'custom' && (
        <div>
          <label htmlFor="cron-custom" className="block text-xs text-ink-3 mb-1">
            Cron expression
          </label>
          <TextInput
            id="cron-custom"
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="0 9 * * *"
            className="bg-hover font-mono"
          />
          <p className="text-legacy-11 text-ink-4 mt-1">
            Format: minute hour day-of-month month day-of-week
          </p>
        </div>
      )}

      <CronPreview expr={expr} preview={preview} />
    </div>
  );
}

function CronPreview({ expr, preview }: { expr: string; preview: ReturnType<typeof parseCron> }) {
  if (!preview.ok) {
    return (
      <div className="bg-warn-bg border border-err/30 rounded-md px-3 py-2 text-xs text-err">
        <span className="font-semibold">Invalid:</span> {preview.error}
      </div>
    );
  }

  return (
    <div className="bg-canvas border border-rule-2 rounded-md px-3 py-2 space-y-1">
      <div className="flex items-center gap-2 text-xs">
        <span className="text-ink-3">Schedule:</span>
        <span className="text-ink">{preview.humanLabel}</span>
        <code className="ml-auto text-mono-11 text-run">{expr}</code>
      </div>
      <div className="text-legacy-11 text-ink-4" suppressHydrationWarning>
        Next runs: {preview.nextRuns.map((d) => formatNextRun(d)).join(' · ')}
      </div>
    </div>
  );
}

function formatNextRun(d: Date): string {
  return d.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
