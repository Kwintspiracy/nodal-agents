// RunStepTimeline — vertical step rail for job detail pages.
// Maps the design's .rl-steps / .rl-step pattern to composable React.
//
// Each step is either done / current / failed / queued.
// The connecting line between pills is drawn via a ::before-equivalent
// pseudo using Tailwind's `before:` modifier on the pill wrapper.

import type { ReactNode } from 'react';
import { GearSix, Check, X } from '@phosphor-icons/react/dist/ssr';
import Disc from './Disc.tsx';
import MonoCode from './MonoCode.tsx';

export type RunStep = {
  id: string;
  /** Human-friendly name (= toolName prettified, or explicit label). */
  name: string;
  /** Raw tool name as it appears in the message, shown as MonoCode. */
  toolName?: string;
  /** Serialised JSON input object. */
  input?: unknown;
  /** Result payload (string or stringified). */
  output?: unknown;
  status: 'done' | 'current' | 'failed' | 'queued';
  /** Optional per-step reasoning text from the assistant message that
   *  preceded this tool_use block. */
  reasoning?: string;
  durationMs?: number;
};

type Props = {
  steps: RunStep[];
};

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/** Truncate long output for display; full content is in the collapsible. */
function truncate(s: string, max = 200): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

/** Map a raw tool_name like "web_search" → "Web search". */
function labelFromToolName(toolName: string): string {
  return toolName.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const STATUS_DISC: Record<RunStep['status'], ReactNode> = {
  done: <Check size={12} weight="bold" />,
  failed: <X size={12} weight="bold" />,
  current: <GearSix size={12} weight="bold" />,
  queued: <GearSix size={12} weight="bold" />,
};

const DISC_VARIANT: Record<RunStep['status'], 'skill' | 'conn' | 'neutral'> = {
  done: 'conn',
  failed: 'neutral', // overridden with red bg below
  current: 'skill',
  queued: 'neutral',
};

/**
 * RunStepTimeline — vertical timeline of tool-call steps inside a job run.
 *
 * Connects each step pill with a 1 px vertical line and shows:
 *   - index pill (✓ for done, ✗ for failed, spinning gear for current, dim for queued)
 *   - step name + raw tool name as MonoCode
 *   - input JSON block (always shown for non-queued steps)
 *   - output / result (truncated; shown only when available)
 *   - right-hand stat column: durationMs + status label
 *
 * Optional reasoning text (assistant text that preceded the tool call) is
 * rendered between the previous step and this one as a small italic annotation.
 */
export default function RunStepTimeline({ steps }: Props) {
  if (steps.length === 0) {
    return <p className="px-[18px] py-4 text-xs text-ink-4">No tool steps recorded yet.</p>;
  }

  return (
    <div className="py-2">
      {steps.map((step, idx) => {
        const isDone = step.status === 'done';
        const isFailed = step.status === 'failed';
        const isCurrent = step.status === 'current';
        const isQueued = step.status === 'queued';
        const isLast = idx === steps.length - 1;

        const inputStr = pretty(step.input);
        const outputStr = pretty(step.output);

        const stepLabel =
          step.name || (step.toolName ? labelFromToolName(step.toolName) : `Step ${idx + 1}`);

        return (
          <div key={step.id}>
            {/* Reasoning annotation between steps */}
            {step.reasoning && (
              <div className="mx-[18px] mb-2 mt-1 rounded-md border border-dashed border-rule bg-canvas px-3 py-2">
                <p className="font-mono text-[11px] italic leading-[1.5] text-ink-3">
                  {step.reasoning}
                </p>
              </div>
            )}

            {/* Step row */}
            <div
              className={`relative grid items-start gap-[14px] px-[18px] py-[14px]`}
              style={{ gridTemplateColumns: '46px 1fr auto' }}
            >
              {/* Vertical connector line — pseudo-like approach with absolute */}
              {!isLast && (
                <span
                  aria-hidden
                  className="pointer-events-none absolute left-[33px] top-[44px] bottom-[-14px] w-px bg-rule-2"
                />
              )}

              {/* Index pill */}
              <div
                className={`relative z-10 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full ${isCurrent ? 'ring-4 ring-skill-vivid/15' : ''}`}
              >
                {isFailed ? (
                  <span className="inline-flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-full bg-err/80 text-white">
                    <X size={12} weight="bold" />
                  </span>
                ) : (
                  <Disc variant={DISC_VARIANT[step.status]} size="sm">
                    {isDone ? <Check size={12} weight="bold" /> : STATUS_DISC[step.status]}
                  </Disc>
                )}
              </div>

              {/* Main content */}
              <div className="min-w-0">
                {/* Row 1: name + tool name */}
                <div className="mb-1 flex flex-wrap items-center gap-2">
                  <span
                    className={`text-[13.5px] font-medium leading-none ${
                      isQueued ? 'text-ink-3' : 'text-ink'
                    }`}
                  >
                    {stepLabel}
                  </span>
                  {step.toolName && <MonoCode>{step.toolName}</MonoCode>}
                </div>

                {/* Input block */}
                {inputStr && !isQueued && (
                  <pre
                    className={`mt-[6px] overflow-auto rounded-[6px] border px-[10px] py-2 font-mono text-[11px] leading-[1.4] text-ink-2 ${
                      isCurrent
                        ? 'border-skill-vivid/30 bg-skill-vivid/5'
                        : 'border-dashed border-rule-2 bg-canvas/50'
                    }`}
                  >
                    {inputStr}
                  </pre>
                )}

                {/* Output / result */}
                {outputStr && (isDone || isFailed) && (
                  <p
                    className={`mt-[6px] font-mono text-[11px] leading-[1.4] ${
                      isFailed ? 'text-err' : 'text-ink-3'
                    }`}
                  >
                    → {truncate(outputStr)}
                  </p>
                )}
              </div>

              {/* Stat column */}
              <div className="min-w-[80px] shrink-0 text-right font-mono text-[10px] leading-[1.5] tracking-[0.04em] text-ink-4">
                {step.durationMs !== undefined && (
                  <div className="font-medium text-ink-2">{step.durationMs}ms</div>
                )}
                <div
                  className={
                    isDone
                      ? 'text-ok'
                      : isFailed
                        ? 'text-err'
                        : isCurrent
                          ? 'text-skill-vivid'
                          : 'text-ink-4'
                  }
                >
                  {isDone ? 'ok' : isFailed ? 'failed' : isCurrent ? 'running' : 'queued'}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
