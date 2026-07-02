'use client';

/**
 * MemoriesClient — the interactive shell for the Memories page.
 *
 * Owns all filter state (tab, agent, search, archived) and renders:
 *   - PageTopBar with PillTabs2 + PageSearchInput + "New Memory" CTA (opens
 *     NewMemoryModal — manual entry via createMemoryAction)
 *   - 2-stat strip (Total memories, Pinned) — Storage/Last-write omitted (no DB data)
 *   - Agent filter ChipRow
 *   - Memory table: Disc + fact | Agent | Category chip | Importance | Last accessed | Actions
 *
 * Tab semantics:
 *   All     — non-archived rows (default)
 *   Archived — archived === true rows
 *
 * Importance is editable inline (star rating, 1-5) — clicking a star sets a
 * USER override that locks the fact so the curator never re-scores it again
 * (importance_locked). Tags are omitted from the table — too granular for
 * this overview surface. They remain accessible through the raw data if a
 * detail view is added later.
 *
 * Search: on the "All" tab, a non-empty query is debounced (300ms) into a
 * real FTS lookup on the server (searchMemoriesAction — same search_tsv/
 * ts_rank engine the agent's query_memory tool uses, but touch:false so
 * browsing never inflates access_count). While the debounce/roundtrip is in
 * flight, an instant client-side substring filter over the already-loaded
 * page keeps the table from flashing empty. The Archived tab always uses the
 * client-side filter — FTS only covers non-archived rows.
 */

import { useState, useMemo, useEffect, useTransition } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import PageShell from '@/components/ui/PageShell';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2, { type PillTab2 } from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import MetricCard from '@/components/ui/MetricCard';
import ChipRow, { type ChipItem } from '@/components/ui/ChipRow';
import Disc from '@/components/ui/Disc';
import AgentAvatar from '@/components/ui/AgentAvatar';
import LiveDot from '@/components/ui/LiveDot';
import IconButton from '@/components/ui/IconButton';
import ConfirmDialog from '@/components/ConfirmDialog';
import NewMemoryModal from './NewMemoryModal';
import {
  archiveMemoryAction,
  unarchiveMemoryAction,
  deleteMemoryAction,
  updateMemoryImportanceAction,
  unpinMemoryImportanceAction,
  searchMemoriesAction,
  type MemoryListRow,
} from '@/lib/actions';
import type { AgentRow } from '@/lib/actions';

// ─── Category metadata ────────────────────────────────────────────────────────

type MemCategory = 'preference' | 'context' | 'outcome' | 'learned_rule';

const CATEGORY_META: Record<MemCategory, { color: string; label: string; icon: React.ReactNode }> =
  {
    preference: {
      color: '#3565ff',
      label: 'Preference',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="4" cy="5" r="1" fill="currentColor" />
          <circle cx="4" cy="11" r="1" fill="currentColor" />
          <circle cx="4" cy="8" r="1" fill="currentColor" />
          <path d="M7 5h6M7 8h6M7 11h4" />
        </svg>
      ),
    },
    context: {
      color: '#22a3aa',
      label: 'Context',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <circle cx="8" cy="8" r="5.5" />
          <path d="M3 8h10M8 2.5c2 1.5 3 3.3 3 5.5s-1 4-3 5.5c-2-1.5-3-3.3-3-5.5s1-4 3-5.5z" />
        </svg>
      ),
    },
    outcome: {
      color: '#1e7a44',
      label: 'Outcome',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M3.5 2.5h6L12.5 5.5v8h-9z" />
          <path d="M9.5 2.5v3h3" />
        </svg>
      ),
    },
    learned_rule: {
      color: '#ff5631',
      label: 'Rule',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6">
          <path d="M2.5 3.5h9v6h-5l-3 3v-3h-1zM5.5 7.5h8v4h-1l-2 2v-2h-5z" />
        </svg>
      ),
    },
  };

function getCategoryMeta(category: string | null | undefined) {
  const key = (category ?? 'context') as MemCategory;
  return CATEGORY_META[key] ?? CATEGORY_META.context;
}

// ─── Sub-components ───────────────────────────────────────────────────────────

/** Coloured chip that renders category label + icon, with 13% alpha background. */
function CategoryChip({ category }: { category: string | null | undefined }) {
  const m = getCategoryMeta(category);
  return (
    <span
      style={{ background: m.color + '22', color: m.color }}
      className="inline-flex h-[24px] items-center gap-1.5 rounded-[6px] px-2.5 text-[11.5px] font-medium leading-none capitalize [&_svg]:h-[12px] [&_svg]:w-[12px]"
    >
      {m.icon}
      {m.label}
    </span>
  );
}

/** Whether a lastAccessedAt timestamp is "recent" (< 2 min ago). */
function isRecent(ts: string | Date | null | undefined): boolean {
  if (!ts) return false;
  const d = ts instanceof Date ? ts : new Date(ts);
  return Date.now() - d.getTime() < 2 * 60 * 1000;
}

function formatAccessed(ts: string | Date | null | undefined): string {
  if (!ts) return '—';
  const d = ts instanceof Date ? ts : new Date(ts);
  const delta = Date.now() - d.getTime();
  if (delta < 60_000) return 'just now';
  if (delta < 3600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3600_000)}h ago`;
  return d.toLocaleDateString();
}

// ─── Row actions ──────────────────────────────────────────────────────────────

function RowActions({ id, archived }: { id: string; archived: boolean }) {
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleArchive() {
    startTransition(async () => {
      const action = archived ? unarchiveMemoryAction : archiveMemoryAction;
      const r = await action(id);
      if (!r.ok) toast.error(r.message);
      else toast.success(archived ? 'Memory restored' : 'Memory archived');
    });
  }

  function performDelete() {
    setConfirmOpen(false);
    startTransition(async () => {
      const r = await deleteMemoryAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Memory deleted');
    });
  }

  return (
    <>
      <div className="flex items-center justify-end gap-1.5">
        <button
          type="button"
          onClick={handleArchive}
          disabled={isPending}
          className="rounded-md border border-rule-2 px-2.5 py-1 text-[11.5px] font-medium text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-40"
        >
          {archived ? 'Restore' : 'Archive'}
        </button>
        <IconButton
          size="sm"
          disabled={isPending}
          onClick={() => setConfirmOpen(true)}
          title="Delete memory"
        >
          <svg viewBox="0 0 16 16" fill="currentColor" className="h-[13px] w-[13px]">
            <circle cx="4" cy="8" r="1.2" />
            <circle cx="8" cy="8" r="1.2" />
            <circle cx="12" cy="8" r="1.2" />
          </svg>
        </IconButton>
      </div>
      <ConfirmDialog
        open={confirmOpen}
        title="Delete memory?"
        message="This memory will be permanently removed. This action cannot be undone."
        confirmLabel="Delete"
        onConfirm={performDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}

// ─── Importance stars ─────────────────────────────────────────────────────────

/**
 * Interactive 1-5 star rating. Clicking a star pins the fact's importance —
 * the user override that wins over the agent's initial guess AND the
 * curator's usage-driven re-scoring (importance_locked=true from here on).
 * A labelled "Pinned" pill marks facts already locked; it's a real button
 * ("Unpin" on hover) — clicking it hands authority back to the curator
 * without touching the current value.
 */
function ImportanceStars({
  id,
  importance,
  locked,
}: {
  id: string;
  importance: number;
  locked: boolean;
}) {
  const [isPending, startTransition] = useTransition();

  function handleClick(value: number) {
    if (isPending || value === importance) return;
    startTransition(async () => {
      const r = await updateMemoryImportanceAction(id, value);
      if (!r.ok) toast.error(r.message);
      else toast.success(`Importance pinned to ${value}`);
    });
  }

  function handleUnpin() {
    if (isPending) return;
    startTransition(async () => {
      const r = await unpinMemoryImportanceAction(id);
      if (!r.ok) toast.error(r.message);
      else toast.success('Importance unpinned — the curator can adjust it again');
    });
  }

  return (
    <div className="inline-flex items-center gap-1">
      <div className="inline-flex items-center gap-0.5" aria-label={`Importance ${importance} of 5`}>
        {[1, 2, 3, 4, 5].map((value) => (
          <button
            key={value}
            type="button"
            disabled={isPending}
            onClick={() => handleClick(value)}
            title={`Set importance to ${value}`}
            className="p-0.5 text-ink-4 transition-colors hover:text-amber-500 disabled:opacity-50"
          >
            <svg
              viewBox="0 0 16 16"
              className="h-[12px] w-[12px]"
              fill={value <= importance ? '#f5a623' : 'none'}
              stroke={value <= importance ? '#f5a623' : 'currentColor'}
              strokeWidth="1.3"
            >
              <path d="M8 1.5l1.9 3.9 4.3.6-3.1 3 .7 4.3L8 11.3l-3.8 2 .7-4.3-3.1-3 4.3-.6z" />
            </svg>
          </button>
        ))}
      </div>
      {locked && (
        <button
          type="button"
          disabled={isPending}
          onClick={handleUnpin}
          title="Pinned by you — click to let the curator manage it again"
          className="group inline-flex h-[20px] cursor-pointer items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/10 px-2 text-[10px] font-medium text-amber-600 transition-colors hover:border-rule hover:bg-hover hover:text-ink disabled:cursor-default disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" className="h-[9px] w-[9px] shrink-0" fill="currentColor">
            <path d="M8 1a3 3 0 0 0-3 3v2H4a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4a3 3 0 0 0-3-3zm-1.5 5V4a1.5 1.5 0 0 1 3 0v2z" />
          </svg>
          <span className="group-hover:hidden">Pinned</span>
          <span className="hidden group-hover:inline">Unpin</span>
        </button>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

type Tab = 'all' | 'archived';

interface Props {
  /** Full non-paginated list — client-side filtering is fast enough for
   *  the typical memory counts (hundreds, not millions). */
  initialItems: MemoryListRow[];
  agents: AgentRow[];
  totalCount: number;
}

export default function MemoriesClient({ initialItems, agents, totalCount }: Props) {
  const [tab, setTab] = useState<Tab>('all');
  const [agentFilter, setAgentFilter] = useState<string>('all');
  const [q, setQ] = useState('');
  const [newMemoryOpen, setNewMemoryOpen] = useState(false);

  // FTS search state — see the module doc comment above for the debounce +
  // instant-fallback design. searchedQuery is the query the CURRENT
  // searchResults answer; the `filtered` memo below only trusts it once it
  // matches the live `q`/`tab` — so there's nothing to reset here when the
  // query is cleared or the tab changes: a stale searchResults value just
  // stops matching the guard and is ignored (no synchronous setState needed
  // in the "nothing to search" branch, which is what react-hooks/
  // set-state-in-effect flags).
  const [searchResults, setSearchResults] = useState<MemoryListRow[] | null>(null);
  const [searchedQuery, setSearchedQuery] = useState<string | null>(null);
  const [isSearching, startSearchTransition] = useTransition();

  useEffect(() => {
    const trimmed = q.trim();
    if (tab !== 'all' || !trimmed) return;
    const handle = setTimeout(() => {
      startSearchTransition(async () => {
        const r = await searchMemoriesAction(trimmed);
        if (!r.ok) {
          toast.error(r.message);
          return;
        }
        setSearchResults(r.data);
        setSearchedQuery(trimmed);
      });
    }, 300);
    return () => clearTimeout(handle);
  }, [q, tab]);

  // Derived counts
  const allCount = useMemo(() => initialItems.filter((m) => !m.archived).length, [initialItems]);
  const archivedCount = useMemo(
    () => initialItems.filter((m) => m.archived).length,
    [initialItems],
  );

  // Filtered list
  const filtered = useMemo(() => {
    const trimmedQ = q.trim();

    // FTS path: "All" tab, a query whose server results have landed.
    if (tab === 'all' && trimmedQ && searchResults !== null && searchedQuery === trimmedQ) {
      let list = searchResults;
      if (agentFilter !== 'all') list = list.filter((m) => m.agent_id === agentFilter);
      return list;
    }

    // Client-side path: no query, Archived tab (FTS doesn't cover archived
    // rows — keywordSearch filters archived=false), or the FTS roundtrip for
    // the current query hasn't landed yet (instant fallback while debouncing).
    let list = initialItems;
    if (tab === 'all') list = list.filter((m) => !m.archived);
    else list = list.filter((m) => m.archived);
    if (agentFilter !== 'all') list = list.filter((m) => m.agent_id === agentFilter);
    if (trimmedQ) {
      const lower = trimmedQ.toLowerCase();
      list = list.filter(
        (m) =>
          m.fact.toLowerCase().includes(lower) ||
          (m.agentName ?? '').toLowerCase().includes(lower) ||
          (m.category ?? '').toLowerCase().includes(lower) ||
          (m.skill_tags ?? []).some((t: string) => t.toLowerCase().includes(lower)),
      );
    }
    return list;
  }, [initialItems, tab, agentFilter, q, searchResults, searchedQuery]);

  // Agents that actually have memories in the current dataset
  const agentChipItems = useMemo<ChipItem<string>[]>(() => {
    const counts = new Map<string, number>();
    for (const m of initialItems) {
      if (m.agent_id && m.agentName) {
        counts.set(m.agent_id, (counts.get(m.agent_id) ?? 0) + 1);
      }
    }
    const items: ChipItem<string>[] = [
      {
        value: 'all',
        label: 'All agents',
        count: `· ${totalCount}`,
      },
    ];
    for (const a of agents) {
      const ct = counts.get(a.id);
      if (ct) {
        items.push({
          value: a.id,
          label: (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-[7px] w-[7px] rounded-full bg-agent-vivid" />
              {a.name}
            </span>
          ),
          count: `· ${ct}`,
        });
      }
    }
    return items;
  }, [initialItems, agents, totalCount]);

  // PillTabs2 tabs
  const tabs: PillTab2<Tab>[] = [
    { value: 'all', label: 'All', count: allCount },
    { value: 'archived', label: 'Archived', count: archivedCount },
  ];

  return (
    <PageShell
      title="Memory"
      subtitle="What your agents remember between runs."
      toolbar={
        <PageTopBar
          tabs={<PillTabs2 tabs={tabs} value={tab} onChange={setTab} />}
          search={
            <PageSearchInput
              value={q}
              onChange={setQ}
              placeholder="Search memories…"
              minWidth={260}
            />
          }
          cta={
            <PrimaryButton variant="neutral" onClick={() => setNewMemoryOpen(true)}>
              + New Memory
            </PrimaryButton>
          }
        />
      }
    >
      {/* Stat strip ─────────────────────────────────────────────────────── */}
      {/* Storage / Last-write cards omitted: no quota or live-write tracking in DB */}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-2">
        <MetricCard label="Total memories" value={String(totalCount)} />
        <MetricCard
          label="Archived"
          value={String(archivedCount)}
          subtle="excluded from agent context"
        />
      </div>

      {/* Agent filter chip row ───────────────────────────────────────────── */}
      <ChipRow
        items={agentChipItems}
        value={agentFilter}
        onChange={setAgentFilter}
        className="mt-3"
      />

      {/* Light loading affordance for the debounced FTS search roundtrip */}
      {isSearching && <div className="mt-2 text-[11px] text-ink-4">Searching…</div>}

      {/* Memory table ───────────────────────────────────────────────────── */}
      <div className="mt-4 overflow-hidden rounded-xl border border-rule-2 bg-paper">
        {filtered.length === 0 ? (
          <div className="px-6 py-12 text-center text-sm text-ink-4">
            No memories match these filters.{' '}
            {tab === 'all' && !q && agentFilter === 'all'
              ? 'Agents save memories automatically when they call save_memory.'
              : 'Try a different filter.'}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-rule-2">
                  <th className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4">
                    Memory
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4 md:table-cell">
                    Agent
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4 lg:table-cell">
                    Category
                  </th>
                  <th className="px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4">
                    Importance
                  </th>
                  <th className="hidden px-5 py-3 text-left text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4 xl:table-cell">
                    Last accessed
                  </th>
                  <th className="px-5 py-3 text-right text-[10.5px] font-semibold uppercase tracking-wider whitespace-nowrap text-ink-4">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => {
                  const meta = getCategoryMeta(m.category);
                  const recent = isRecent(m.last_accessed_at);
                  return (
                    <tr
                      key={m.id}
                      className="align-middle border-b border-rule-2/60 transition-colors last:border-0 hover:bg-hover/50"
                    >
                      {/* Memory: Disc + fact text */}
                      <td className="px-5 py-3.5">
                        <div className="flex items-start gap-3">
                          <Disc
                            variant="neutral"
                            size="md"
                            shape="square"
                            background={meta.color}
                            className="mt-0.5 shrink-0 [&_svg]:h-[14px] [&_svg]:w-[14px]"
                          >
                            {meta.icon}
                          </Disc>
                          <div className="min-w-0">
                            <div className="line-clamp-2 text-[13px] leading-snug text-ink">
                              {m.fact}
                            </div>
                            <div className="mt-0.5 font-mono text-[11px] text-ink-4">
                              {m.created_at ? new Date(m.created_at).toLocaleString() : '—'}
                              {(m.access_count ?? 0) > 0 ? ` · accessed ${m.access_count}×` : ''}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Agent */}
                      <td className="hidden px-5 py-3.5 md:table-cell">
                        {m.agentName ? (
                          <Link
                            href={`/agents`}
                            className="inline-flex items-center gap-2 text-[12px] text-ink-2 transition-colors hover:text-ink"
                          >
                            <AgentAvatar name={m.agentName} size="sm" />
                            {m.agentName}
                          </Link>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </td>

                      {/* Category chip */}
                      <td className="hidden px-5 py-3.5 lg:table-cell">
                        <CategoryChip category={m.category} />
                      </td>

                      {/* Importance stars — click a star to pin (locks against the curator).
                          Always visible: this is the actionable control, not metadata. */}
                      <td className="px-5 py-3.5">
                        <ImportanceStars
                          id={m.id}
                          importance={m.importance}
                          locked={m.importance_locked}
                        />
                      </td>

                      {/* Last accessed */}
                      <td className="hidden px-5 py-3.5 xl:table-cell">
                        <span className="inline-flex items-center gap-1.5 font-mono text-[12px] text-ink-3">
                          {formatAccessed(m.last_accessed_at)}
                          {recent && <LiveDot variant="ok" size="sm" />}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-5 py-3.5 text-right">
                        <RowActions id={m.id} archived={m.archived ?? false} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <NewMemoryModal open={newMemoryOpen} onClose={() => setNewMemoryOpen(false)} />
    </PageShell>
  );
}
