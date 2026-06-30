'use client';

// DelegationTable — the Runs view, from the Figma "Delegation" design.
// Runs are pre-ordered parent-then-children by the server action, so each
// orchestrator sits directly above the runs it delegated. Role is shown by a
// LEFT ACCENT bar + indentation (no role badges): orchestrator = lime,
// delegated = blue + indented "from X", standalone = none.
// The whole row is clickable (→ run detail) and its tooltip is the task.
// Theme-aware (semantic tokens + StatusPill/AgentAvatar) and responsive.

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import type { DelegationRunRow } from '@/lib/actions.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { ArrowElbowDownRight, Clock, PaperPlaneTilt, Browser } from '@phosphor-icons/react';

const ACCENT: Record<DelegationRunRow['role'], string> = {
  orchestrator: '#d4ff2e',
  delegated: '#3565ff',
  standalone: 'transparent',
};

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}
function statusLabel(status: string | null): string {
  const MAP: Record<string, string> = {
    pending: 'Queued',
    processing: 'Running',
    completed: 'Done',
    failed: 'Failed',
    awaiting_approval: 'Awaiting',
    awaiting_delegation: 'Awaiting',
    cancelled: 'Cancelled',
  };
  return MAP[status ?? ''] ?? 'Pending';
}

// "Trigger" = what actually kicked off the top-level run. Only orchestrator /
// standalone runs have a real one (Cron / Telegram / Dashboard). A DELEGATED run
// has no trigger of its own — it was spawned by its orchestrator, whose trigger
// shows one row above. (NodalAI has no Kanban "task board"; channels like
// `task-board` / `internal` are just delegation mechanics, not real triggers, so
// they're never surfaced as a trigger.)
type Trig = { label: string; cls: string; Icon: typeof Clock };
const CRON: Trig = { label: 'Cron', cls: 'bg-agent-vivid text-[#1a2200]', Icon: Clock };
const TELEGRAM: Trig = { label: 'Telegram', cls: 'bg-conn-vivid text-white', Icon: PaperPlaneTilt };
const DASHBOARD: Trig = { label: 'Dashboard', cls: 'bg-ink-3 text-paper', Icon: Browser };
const TRIGGER_LEGEND: Trig[] = [CRON, TELEGRAM, DASHBOARD];

function triggerFor(r: DelegationRunRow): Trig | null {
  if (r.role === 'delegated') return null; // inherits its orchestrator's trigger
  if (r.channel === 'cron') return CRON;
  if (r.channel === 'telegram') return TELEGRAM;
  if (r.channel === 'dashboard' || r.channel === 'api') return DASHBOARD;
  return null; // internal / task-board / other → no real external trigger
}

const isLive = (s: string | null) =>
  s === 'processing' || s === 'pending' || (s?.startsWith('awaiting') ?? false);
const pad = (n: number) => String(n).padStart(2, '0');

function startedLabel(createdAt: Date | null, status: string | null): string {
  if (isLive(status) && createdAt) {
    const sec = Math.max(0, Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000));
    return `live · ${pad(Math.floor(sec / 60))}:${pad(sec % 60)}`;
  }
  if (!createdAt) return '—';
  return new Date(createdAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}
function durationLabel(c: Date | null, d: Date | null, status: string | null): string {
  if (isLive(status) || !c || !d) return '—';
  const sec = Math.max(0, Math.floor((new Date(d).getTime() - new Date(c).getTime()) / 1000));
  return sec >= 60 ? `${Math.floor(sec / 60)}m ${pad(sec % 60)}s` : `${sec}s`;
}
// Abbreviate token counts: 5210 → 5.2K, 102340 → 102K, 1043772 → 1.0M.
function abbrevTokens(n: number): string {
  if (n <= 0) return '—';
  if (n < 1000) return String(n);
  const trim = (x: number) => (Math.round(x * 10) / 10).toString().replace(/\.0$/, '');
  if (n < 1_000_000) return (n / 1000 >= 100 ? String(Math.round(n / 1000)) : trim(n / 1000)) + 'K';
  return (n / 1_000_000 >= 100 ? String(Math.round(n / 1_000_000)) : trim(n / 1_000_000)) + 'M';
}

const TH =
  'px-4 py-2.5 font-mono text-[11px] font-normal uppercase tracking-[0.12em] text-ink-3 whitespace-nowrap';
const TD = 'px-4 py-3 align-middle';

export default function DelegationTable({
  rows,
  query = '',
}: {
  rows: DelegationRunRow[];
  query?: string;
}) {
  const router = useRouter();

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.agentName.toLowerCase().includes(q) ||
        r.task.toLowerCase().includes(q) ||
        (r.fromAgentName?.toLowerCase().includes(q) ?? false),
    );
  }, [rows, query]);

  return (
    <div>
      <div className="overflow-hidden rounded-2xl border border-rule-2 bg-paper">
        {/* Legend — decodes the trigger icons */}
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 border-b border-rule-2 px-5 py-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-4">
              Trigger
            </span>
            {TRIGGER_LEGEND.map((t) => (
              <span
                key={t.label}
                className="inline-flex items-center gap-1.5 text-[11px] text-ink-3"
              >
                <span
                  className={`inline-flex size-[16px] items-center justify-center rounded ${t.cls}`}
                >
                  <t.Icon size={10} weight="fill" />
                </span>
                {t.label}
              </span>
            ))}
          </div>
        </div>

        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-[14px] text-ink-4">
            {rows.length === 0 ? 'No runs yet.' : 'No runs match the search.'}
          </div>
        ) : (
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-rule-2">
                <th className={`${TH} text-left`}>Agent</th>
                <th className={`${TH} text-left`}>Trigger</th>
                <th className={`${TH} hidden text-left md:table-cell`}>Started</th>
                <th className={`${TH} hidden text-right lg:table-cell`}>Duration</th>
                <th className={`${TH} text-right`}>Tokens</th>
                <th className={`${TH} hidden text-right sm:table-cell`}>Cost</th>
                <th className={`${TH} text-right`}>Status</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const delegated = r.role === 'delegated';
                const tokens = r.inputTokens + r.outputTokens;
                const trig = triggerFor(r);
                return (
                  <tr
                    key={r.id}
                    title={r.task}
                    onClick={() => router.push(`/jobs/${r.id}`)}
                    className={`cursor-pointer border-b border-rule-2 transition-colors last:border-0 hover:bg-hover-2 ${
                      delegated ? 'bg-hover' : ''
                    }`}
                  >
                    {/* Agent — left accent via inset shadow (theme-safe) */}
                    <td className={TD} style={{ boxShadow: `inset 3px 0 0 ${ACCENT[r.role]}` }}>
                      <div className={`flex items-center gap-2.5 ${delegated ? 'pl-2' : ''}`}>
                        {delegated && (
                          <ArrowElbowDownRight size={14} className="shrink-0 text-ink-4" />
                        )}
                        <AgentAvatar name={r.agentName} imageUrl={r.agentAvatarUrl} size="md" />
                        <div className="min-w-0">
                          <div className="truncate text-[13px] text-ink">{r.agentName}</div>
                          {delegated && r.fromAgentName && (
                            <div className="truncate text-[11px] leading-tight text-ink-3">
                              from {r.fromAgentName}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>

                    {/* Trigger — only top-level runs have one; delegated → "—" */}
                    <td className={TD}>
                      {trig ? (
                        <span
                          title={trig.label}
                          className={`inline-flex size-[24px] items-center justify-center rounded-md ${trig.cls}`}
                        >
                          <trig.Icon size={13} weight="fill" />
                        </span>
                      ) : (
                        <span className="text-[12.5px] text-ink-4">—</span>
                      )}
                    </td>

                    {/* Started */}
                    <td
                      className={`${TD} hidden text-left text-[12.5px] whitespace-nowrap text-ink-2 md:table-cell`}
                    >
                      {startedLabel(r.createdAt, r.status)}
                    </td>
                    {/* Duration */}
                    <td
                      className={`${TD} hidden text-right font-mono text-[12.5px] whitespace-nowrap text-ink-2 lg:table-cell`}
                    >
                      {durationLabel(r.createdAt, r.completedAt, r.status)}
                    </td>
                    {/* Tokens */}
                    <td
                      className={`${TD} text-right font-mono text-[12.5px] whitespace-nowrap text-ink-2`}
                    >
                      {abbrevTokens(tokens)}
                    </td>
                    {/* Cost */}
                    <td
                      className={`${TD} hidden text-right font-mono text-[12.5px] whitespace-nowrap text-ink-2 sm:table-cell`}
                    >
                      {r.costUsd > 0 ? `$${r.costUsd.toFixed(2)}` : '—'}
                    </td>
                    {/* Status */}
                    <td className={`${TD} text-right`}>
                      <StatusPill variant={statusVariant(r.status)} label={statusLabel(r.status)} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
