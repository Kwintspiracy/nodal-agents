import { notFound } from 'next/navigation';
import Link from 'next/link';
import { GearSix } from '@phosphor-icons/react/dist/ssr';
import { getJobDetailAction } from '@/lib/actions.ts';
import JobPageRefresher from './JobPageRefresher.tsx';
import StatusBadge from '@/components/StatusBadge.tsx';
import BackButton from '@/components/ui/BackButton.tsx';
import RunStepTimeline, { type RunStep } from '@/components/ui/RunStepTimeline.tsx';
import RunApprovalBanner from '@/components/ui/RunApprovalBanner.tsx';
import MonoCode from '@/components/ui/MonoCode.tsx';
import StatusPill from '@/components/ui/StatusPill.tsx';
import CancelJobButton from '../CancelJobButton.tsx';

// Force dynamic — this page reads per-request DB state.
export const dynamic = 'force-dynamic';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

// ─── Message → Step mapping ────────────────────────────────────────────────
//
// Messages are in Anthropic / AI SDK v4 / AI SDK v6 format. We normalise
// tool_use / tool-call blocks into RunStep objects and match them to their
// corresponding tool_result / tool-result blocks by toolCallId.
//
// Strategy:
//   1. Walk every message in order.
//   2. Assistant text before a tool call becomes a "reasoning" annotation on
//      the NEXT step built from that turn's tool calls.
//   3. Each tool_use / tool-call becomes a RunStep (status TBD).
//   4. Each tool_result / tool-result is keyed by toolCallId and stored.
//   5. After the walk, match results to steps:
//      - matched, no error → done
//      - matched, is_error or result starts with "Error" → failed
//      - not matched (latest in-flight) → current (only the last unmatched)
//      - earlier unmatched without any result = also current (rare edge case)

type RawBlock = Record<string, unknown>;
type RawMsg = Record<string, unknown>;

function extractBlocks(msg: RawMsg): RawBlock[] {
  const content = msg['content'];
  if (typeof content === 'string') return [];
  if (!Array.isArray(content)) return [];
  return content.filter((b): b is RawBlock => typeof b === 'object' && b !== null);
}

function blockType(b: RawBlock): string {
  return typeof b['type'] === 'string' ? b['type'] : '';
}

function isToolCall(b: RawBlock): boolean {
  const t = blockType(b);
  return t === 'tool_use' || t === 'tool-call';
}

function isToolResult(b: RawBlock): boolean {
  const t = blockType(b);
  return t === 'tool_result' || t === 'tool-result';
}

function toolCallId(b: RawBlock): string {
  return String(b['id'] ?? b['toolCallId'] ?? '');
}

function toolResultId(b: RawBlock): string {
  return String(b['tool_use_id'] ?? b['toolCallId'] ?? '');
}

function toolName(b: RawBlock): string {
  return String(b['name'] ?? b['toolName'] ?? 'unknown');
}

function toolInput(b: RawBlock): unknown {
  return b['input'] ?? b['args'] ?? {};
}

function toolResultPayload(b: RawBlock): unknown {
  // AI SDK v6: output.value; v4: result; Anthropic: content
  const v6 = b['output'];
  if (v6 && typeof v6 === 'object' && 'value' in (v6 as object)) {
    return (v6 as Record<string, unknown>)['value'];
  }
  return b['content'] ?? b['result'] ?? null;
}

function isResultError(b: RawBlock, payload: unknown): boolean {
  if (b['is_error'] === true) return true;
  if (typeof payload === 'string' && payload.startsWith('Error')) return true;
  return false;
}

function labelFromToolName(raw: string): string {
  return raw.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

interface IntermediateStep {
  id: string;
  name: string;
  toolName: string;
  input: unknown;
  reasoning?: string;
}

export function stepsFromMessages(messages: RawMsg[]): RunStep[] {
  // First pass: collect all tool calls and tool results, noting reasoning.
  const steps: IntermediateStep[] = [];
  const results = new Map<string, { payload: unknown; isError: boolean }>();

  for (const msg of messages) {
    const role = msg['role'];
    const blocks = extractBlocks(msg);

    if (role === 'assistant') {
      // Collect leading text blocks as reasoning for the subsequent tool calls.
      let pendingReasoning = '';
      const toolCallBlocks: RawBlock[] = [];
      let seenToolCall = false;

      for (const b of blocks) {
        if (isToolCall(b)) {
          seenToolCall = true;
          toolCallBlocks.push(b);
        } else if (!seenToolCall && blockType(b) === 'text') {
          const txt = String(b['text'] ?? '').trim();
          if (txt) pendingReasoning = txt;
        }
      }

      for (let i = 0; i < toolCallBlocks.length; i++) {
        const b = toolCallBlocks[i]!;
        steps.push({
          id: toolCallId(b) || `step-${steps.length}`,
          name: labelFromToolName(toolName(b)),
          toolName: toolName(b),
          input: toolInput(b),
          // Only attach reasoning to the first tool call in the turn.
          reasoning: i === 0 && pendingReasoning ? pendingReasoning : undefined,
        });
      }
    }

    // Tool results can appear in user messages (AI SDK) or their own messages.
    for (const b of blocks) {
      if (isToolResult(b)) {
        const rid = toolResultId(b);
        if (rid) {
          const payload = toolResultPayload(b);
          results.set(rid, {
            payload,
            isError: isResultError(b, payload),
          });
        }
      }
    }
  }

  // Second pass: determine step status.
  const runSteps: RunStep[] = [];
  const unmatchedIds: string[] = [];

  for (const step of steps) {
    const result = results.get(step.id);
    if (result) {
      runSteps.push({
        ...step,
        output: pretty(result.payload),
        status: result.isError ? 'failed' : 'done',
      });
    } else {
      unmatchedIds.push(step.id);
      runSteps.push({
        ...step,
        status: 'queued', // will be promoted below
      });
    }
  }

  // The last unmatched call = current. Earlier unmatched = queued (plan-ahead
  // scenario that doesn't apply to our data, but handle it defensively).
  if (unmatchedIds.length > 0) {
    const lastUnmatched = unmatchedIds[unmatchedIds.length - 1]!;
    for (const s of runSteps) {
      if (s.id === lastUnmatched) {
        s.status = 'current';
        break;
      }
    }
  }

  return runSteps;
}

// ─── Telemetry helpers ────────────────────────────────────────────────────

function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtNum(n: number | null | undefined): string {
  if (n == null) return '—';
  return n.toLocaleString();
}

// ─── Page ────────────────────────────────────────────────────────────────

type Props = { params: Promise<{ id: string }> };

export default async function JobDetailPage({ params }: Props) {
  const { id } = await params;
  const result = await getJobDetailAction(id);

  if (!result.ok) {
    if (result.code === 'not_found') notFound();
    return (
      <div className="space-y-4">
        <BackButton href="/jobs" label="Jobs" />
        <p className="text-sm text-err">{result.message}</p>
      </div>
    );
  }

  const job = result.data;
  const isLive = !TERMINAL.has(job.status ?? '');
  const isAwaitingApproval = job.status === 'awaiting_approval';
  const messages = Array.isArray(job.messages) ? (job.messages as RawMsg[]) : [];

  const steps = stepsFromMessages(messages);
  const doneCount = steps.filter((s) => s.status === 'done' || s.status === 'failed').length;
  const progressPct = steps.length > 0 ? Math.round((doneCount / steps.length) * 100) : 0;

  // Distinct tool names used in this run.
  const skillsUsed = [...new Set(steps.map((s) => s.toolName).filter(Boolean))] as string[];

  // Status pill variant mapping.
  function statusVariant(s: string): 'done' | 'warn' | 'run' | 'idle' {
    if (s === 'completed') return 'done';
    if (s === 'failed' || s === 'cancelled') return 'warn';
    if (s === 'processing' || s === 'awaiting_approval' || s === 'awaiting_delegation')
      return 'run';
    return 'idle';
  }

  return (
    <div className="space-y-5">
      {/* Back + agent breadcrumb */}
      <div className="flex items-center gap-3 flex-wrap">
        <BackButton href="/jobs" label="Jobs" />
        {job.agentName && (
          <span className="text-sm font-medium text-ink">
            {job.agentName}
            {job.agentSlug && <MonoCode className="ml-1.5">{job.agentSlug}</MonoCode>}
          </span>
        )}
        <span className="ml-auto font-mono text-[11px] text-ink-4">{job.id}</span>
      </div>

      {/* Page heading */}
      <div>
        <h1 className="text-[22px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">
          {job.agentName ?? 'Agent'}{' '}
          <em className="not-italic text-ink-2">
            {isLive ? 'is working.' : job.status === 'completed' ? 'completed.' : job.status + '.'}
          </em>
        </h1>
        {job.task && <p className="mt-1 text-[13.5px] leading-[1.5] text-ink-3">{job.task}</p>}
      </div>

      {/* Main two-column grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_300px] lg:items-start">
        {/* LEFT — Timeline panel */}
        <div className="rounded-2xl border border-rule-2 bg-paper">
          {/* Panel header */}
          <div className="flex items-center gap-[14px] border-b border-rule-2 px-[18px] py-[16px]">
            <div className="flex-1 min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-[15px] font-semibold leading-[1.15] tracking-[-0.01em] text-ink">
                  Run timeline
                </span>
                <StatusPill
                  variant={statusVariant(job.status ?? 'pending')}
                  label={job.status ?? 'pending'}
                />
                {isLive && <CancelJobButton jobId={job.id} />}
              </div>
              <p className="mt-0.5 font-mono text-[10.5px] tracking-[0.06em] text-ink-4">
                {job.channel ?? 'manual'} · {job.id.slice(0, 8)}
              </p>
            </div>
            {steps.length > 0 && (
              <span className="shrink-0 font-mono text-[10.5px] tracking-[0.06em] text-ink-3">
                STEP {Math.min(doneCount + 1, steps.length)} / {steps.length}
              </span>
            )}
          </div>

          {/* Progress bar */}
          {steps.length > 0 && (
            <div className="mx-[18px] h-[4px] overflow-hidden rounded-full bg-black/5">
              <div
                className="h-full rounded-full bg-skill-vivid transition-[width] duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          )}

          {/* Timeline */}
          <RunStepTimeline steps={steps} />

          {/* Result / error at the bottom of the panel (terminal jobs) */}
          {!isLive && (job.result || job.error) && (
            <div className="border-t border-rule-2 px-[18px] py-[14px] space-y-3">
              {job.result && (
                <div>
                  <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
                    Result
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-lg border border-rule-2 bg-canvas p-3 font-mono text-[11px] leading-[1.5] text-ink-2 whitespace-pre-wrap">
                    {job.result}
                  </pre>
                </div>
              )}
              {job.error && (
                <div>
                  <p className="mb-1 font-mono text-[9.5px] uppercase tracking-[0.14em] text-err">
                    Error
                  </p>
                  <pre className="max-h-64 overflow-auto rounded-lg border border-err/30 bg-warn-bg p-3 font-mono text-[11px] leading-[1.5] text-err whitespace-pre-wrap">
                    {job.error}
                  </pre>
                </div>
              )}
            </div>
          )}

          {/* Live page refresher — calls router.refresh() every 3 s while
              the job is active. The whole server component re-renders so
              the timeline, progress bar, and status chip all update without
              a separate polling channel. Unmounts automatically when the
              parent stops rendering it (isLive becomes false). */}
          {isLive && <JobPageRefresher status={job.status ?? 'pending'} />}

          {/* Approval banner */}
          {isAwaitingApproval && (
            <RunApprovalBanner
              title="Approval required before continuing"
              body="The agent has paused and is waiting for a human decision before it proceeds."
            />
          )}
        </div>

        {/* RIGHT — Telemetry sidebar */}
        <div className="sticky top-5 rounded-2xl border border-rule-2 bg-paper p-4 space-y-4">
          {/* Run telemetry */}
          <div>
            <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
              Run telemetry
            </p>
            <div className="space-y-1.5">
              {[
                ['Elapsed', formatDuration(job.totalDurationMs)],
                ['Tokens in', fmtNum(job.inputTokens)],
                ['Tokens out', fmtNum(job.outputTokens)],
                ['Turn', String(job.turn ?? 0)],
                ['Chain count', String(job.chainCount ?? 0)],
                ['Delegation depth', String(job.delegationDepth ?? 0)],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-2">
                  <span className="text-[12px] text-ink-3">{label}</span>
                  <span className="font-mono text-[11px] text-ink-2">{value}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Skills called */}
          {skillsUsed.length > 0 && (
            <div>
              <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
                Skills called
              </p>
              <div className="flex flex-wrap gap-1.5">
                {skillsUsed.map((name) => (
                  <span
                    key={name}
                    className="inline-flex h-6 items-center gap-1 rounded-[5px] bg-skill-vivid/10 px-2 font-mono text-[10.5px] text-skill-vivid"
                  >
                    <GearSix size={10} weight="bold" />
                    {name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Delegation */}
          {(job.parentJobId || job.children.length > 0) && (
            <div>
              <p className="mb-2 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-4">
                Delegation
              </p>
              {job.parentJobId && (
                <div className="mb-1.5 text-[12px]">
                  <span className="text-ink-4 mr-1.5">↑ parent</span>
                  <Link
                    href={`/jobs/${job.parentJobId}`}
                    className="font-mono text-[11px] text-run hover:underline"
                  >
                    {job.parentJobId.slice(0, 12)}…
                  </Link>
                </div>
              )}
              {job.children.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] text-ink-4">↓ {job.children.length} child job(s)</p>
                  {job.children.map((child) => (
                    <Link
                      key={child.id}
                      href={`/jobs/${child.id}`}
                      className="flex items-center gap-2 rounded-lg border border-rule-2 bg-canvas px-2.5 py-1.5 text-[11px] hover:border-rule transition-colors"
                    >
                      <span className="min-w-0 flex-1 truncate font-medium text-ink">
                        {child.agentName ?? '—'}
                      </span>
                      <StatusBadge status={child.status ?? 'pending'} />
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
