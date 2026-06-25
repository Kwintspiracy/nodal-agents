'use client';

import { useMemo, useState } from 'react';
import {
  buildCron,
  detectMode,
  parseCron,
  type BuildCronInput,
  type FrequencyMode,
} from '@/lib/cron.ts';

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
      <input type="hidden" name={name} value={expr} />

      <div className="grid grid-cols-2 gap-3">
        <div>
          <label htmlFor="cron-mode" className="block text-xs text-ink-3 mb-1">
            Frequency
          </label>
          <select
            id="cron-mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as FrequencyMode)}
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
          >
            <option value="minutes">Every N minutes</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="custom">Custom (cron)</option>
          </select>
        </div>

        {mode === 'minutes' && (
          <div>
            <label htmlFor="cron-every" className="block text-xs text-ink-3 mb-1">
              Every
            </label>
            <select
              id="cron-every"
              value={everyMinutes}
              onChange={(e) => setEveryMinutes(parseInt(e.target.value, 10))}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
            >
              {PRESET_INTERVALS.map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? 'minute' : 'minutes'}
                </option>
              ))}
            </select>
          </div>
        )}

        {mode === 'hourly' && (
          <div>
            <label htmlFor="cron-min-of-hour" className="block text-xs text-ink-3 mb-1">
              At minute
            </label>
            <input
              id="cron-min-of-hour"
              type="number"
              min={0}
              max={59}
              value={parseInt(time.split(':')[1] ?? '0', 10)}
              onChange={(e) => {
                const n = Math.max(0, Math.min(59, parseInt(e.target.value || '0', 10)));
                setTime(`00:${String(n).padStart(2, '0')}`);
              }}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
            />
          </div>
        )}

        {(mode === 'daily' || mode === 'weekly' || mode === 'monthly') && (
          <div>
            <label htmlFor="cron-time" className="block text-xs text-ink-3 mb-1">
              Time
            </label>
            <input
              id="cron-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
            />
          </div>
        )}
      </div>

      {mode === 'weekly' && (
        <div>
          <label className="block text-xs text-ink-3 mb-1">Days</label>
          <div className="flex flex-wrap gap-1.5">
            {DAYS.map((d) => {
              const on = weekdays.includes(d.n);
              return (
                <button
                  key={d.n}
                  type="button"
                  onClick={() => toggleWeekday(d.n)}
                  className={`px-2.5 py-1 text-xs font-medium rounded border ${
                    on
                      ? 'bg-run-bg border-run/30 text-run'
                      : 'border-rule-2 text-ink-3 hover:border-rule hover:text-ink'
                  }`}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {mode === 'monthly' && (
        <div>
          <label htmlFor="cron-dom" className="block text-xs text-ink-3 mb-1">
            Day of month
          </label>
          <input
            id="cron-dom"
            type="number"
            min={1}
            max={31}
            value={dayOfMonth}
            onChange={(e) =>
              setDayOfMonth(Math.max(1, Math.min(31, parseInt(e.target.value || '1', 10))))
            }
            className="w-32 bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink focus:border-ink-3 focus:outline-none"
          />
        </div>
      )}

      {mode === 'custom' && (
        <div>
          <label htmlFor="cron-custom" className="block text-xs text-ink-3 mb-1">
            Cron expression
          </label>
          <input
            id="cron-custom"
            type="text"
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="0 9 * * *"
            className="w-full bg-hover border border-rule rounded-md px-2 py-1.5 text-sm text-ink placeholder:text-ink-4 focus:border-ink-3 focus:outline-none font-mono"
          />
          <p className="text-[11px] text-ink-4 mt-1">
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
        <code className="ml-auto font-mono text-[11px] text-run">{expr}</code>
      </div>
      <div className="text-[11px] text-ink-4" suppressHydrationWarning>
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
