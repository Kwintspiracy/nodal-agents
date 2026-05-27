'use client';

// AgentsList — Grid view + Hierarchy view for /agents.
//
// Grid view:
//   3-column card grid matching `.ag-grid` / `.ag-card` from the design.
//   A ChipRow filters by derived status (All / Running / Idle / Attention /
//   Paused). Cards are clickable → /agents/{id}/edit.
//
// Hierarchy view:
//   One OrchestratorCard per orchestrator (including their worker list), then
//   a "Standalone" section for unassigned workers. dnd-kit drag-and-drop
//   allows reordering workers within a group and reordering whole teams.
//   Both behaviours are preserved from the previous AgentsList implementation.
//
// State:
//   - `tab`         — 'grid' | 'hier'
//   - `statusFilter`— grid chip filter
//   - `query`       — search string
//   - `groups`      — live-updated group list (mutated by drag ops)
//   - `activity`    — polled every 5 s, never shown stale
//
// Drag-and-drop scoping (dnd-kit — identical to previous impl):
//   Groups (orchestrators) are sortable within an outer DndContext over
//   orchestrator IDs. Each group's workers get their own nested DndContext
//   scoped to their worker IDs so cross-group drops are no-ops at the data
//   layer.

import Link from 'next/link';
import { useEffect, useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Plus } from '@phosphor-icons/react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  reorderAgentsAction,
  getActiveJobsByAgentAction,
  type ActiveAgentRow,
  type AgentGroup,
  type AgentRow,
} from '@/lib/actions.ts';
import PageTopBar from '@/components/ui/PageTopBar';
import PillTabs2 from '@/components/ui/PillTabs2';
import PageSearchInput from '@/components/ui/PageSearchInput';
import PrimaryButton from '@/components/ui/PrimaryButton';
import ChipRow, { type ChipItem } from '@/components/ui/ChipRow';
import Banner from '@/components/ui/Banner';
import AgentGridCard from '@/components/ui/AgentGridCard';
import OrchestratorCard from '@/components/ui/OrchestratorCard';
import WorkerRow from '@/components/ui/WorkerRow';
// DeleteAgentButton import intentionally omitted — delete actions live on
// the edit page (/agents/[id]/edit). Cards and rows navigate there on click.

// ─── Types ────────────────────────────────────────────────────────────────────

type Tab = 'grid' | 'hier';
type StatusFilter = 'All' | 'Running' | 'Idle' | 'Attention' | 'Paused';

/** Refresh cadence for activity badges — matches ActiveAgentsPanel on /stats. */
const ACTIVITY_POLL_MS = 5000;

interface Props {
  initialGroups: AgentGroup[];
  initialActivity: ActiveAgentRow[];
}

// ─── Root component ───────────────────────────────────────────────────────────

export default function AgentsList({ initialGroups, initialActivity }: Props) {
  const [groups, setGroups] = useState<AgentGroup[]>(initialGroups);
  const [activity, setActivity] = useState<ActiveAgentRow[]>(initialActivity);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [tab, setTab] = useState<Tab>('grid');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('All');
  const [query, setQuery] = useState('');

  // Flat list of all agents (deduped) — used for the grid.
  const flatAgents = useMemo<AgentRow[]>(() => {
    const seen = new Set<string>();
    const out: AgentRow[] = [];
    for (const g of groups) {
      if (g.orchestrator && !seen.has(g.orchestrator.id)) {
        seen.add(g.orchestrator.id);
        out.push(g.orchestrator);
      }
      for (const w of g.workers) {
        if (!seen.has(w.id)) {
          seen.add(w.id);
          out.push(w);
        }
      }
    }
    return out;
  }, [groups]);

  // O(1) activity lookup.
  const activityByAgent = useMemo(() => {
    const m = new Map<string, ActiveAgentRow>();
    for (const a of activity) m.set(a.agentId, a);
    return m;
  }, [activity]);

  // Live polling — one call per tick, shared across all cards.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await getActiveJobsByAgentAction();
      if (cancelled) return;
      if (r.ok) setActivity(r.data);
    };
    const id = setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // dnd-kit sensors — shared between grid-level and worker-level contexts.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // ── Reorder helpers ─────────────────────────────────────────────────────────

  function flatten(gs: AgentGroup[]): string[] {
    const out: string[] = [];
    for (const g of gs) {
      if (g.orchestrator) out.push(g.orchestrator.id);
      for (const w of g.workers) out.push(w.id);
    }
    return out;
  }

  function submitReorder(next: AgentGroup[]) {
    const previous = groups;
    setGroups(next);
    startTransition(async () => {
      const r = await reorderAgentsAction(flatten(next));
      if (!r.ok) {
        toast.error(r.message);
        setGroups(previous);
        return;
      }
      router.refresh();
    });
  }

  function handleWorkerDragEnd(groupIdx: number, e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const group = groups[groupIdx];
    if (!group) return;
    const oldIdx = group.workers.findIndex((w) => w.id === active.id);
    const newIdx = group.workers.findIndex((w) => w.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const newWorkers = arrayMove(group.workers, oldIdx, newIdx);
    const next = groups.map((g, i) => (i === groupIdx ? { ...g, workers: newWorkers } : g));
    submitReorder(next);
  }

  function handleGroupDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = groups.findIndex((g) => g.orchestrator?.id === active.id);
    const newIdx = groups.findIndex((g) => g.orchestrator?.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    submitReorder(arrayMove(groups, oldIdx, newIdx));
  }

  // ── Derived filtered list for grid ─────────────────────────────────────────

  const filteredGrid = useMemo(() => {
    let list = flatAgents;
    if (query.trim()) {
      const q = query.toLowerCase();
      list = list.filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          a.slug.toLowerCase().includes(q) ||
          (a.role ?? '').toLowerCase().includes(q),
      );
    }
    if (statusFilter !== 'All') {
      list = list.filter((a) => {
        const act = activityByAgent.get(a.id) ?? null;
        const s = deriveStatusLabel(act);
        return s === statusFilter;
      });
    }
    return list;
  }, [flatAgents, query, statusFilter, activityByAgent]);

  // ── Status chip counts ──────────────────────────────────────────────────────

  const chipCounts = useMemo(() => {
    const counts: Record<StatusFilter, number> = {
      All: flatAgents.length,
      Running: 0,
      Idle: 0,
      Attention: 0,
      Paused: 0,
    };
    for (const a of flatAgents) {
      const s = deriveStatusLabel(activityByAgent.get(a.id) ?? null);
      counts[s] = (counts[s] ?? 0) + 1;
    }
    return counts;
  }, [flatAgents, activityByAgent]);

  const STATUS_CHIPS: ChipItem<StatusFilter>[] = [
    { value: 'All', label: 'All', count: chipCounts.All },
    { value: 'Running', label: 'Running', count: chipCounts.Running },
    { value: 'Idle', label: 'Idle', count: chipCounts.Idle },
    { value: 'Attention', label: 'Attention', count: chipCounts.Attention },
    { value: 'Paused', label: 'Paused', count: chipCounts.Paused },
  ];

  const orchestratorIds = groups
    .map((g) => g.orchestrator?.id)
    .filter((id): id is string => Boolean(id));

  // ── Empty state ─────────────────────────────────────────────────────────────

  if (groups.length === 0) {
    return (
      <div className="mt-4 rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
        <p className="text-[13px] leading-[1.5] text-ink-3">No agents yet. Create one above.</p>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="pb-10">
      {/* Top bar */}
      <PageTopBar
        tabs={
          <PillTabs2<Tab>
            value={tab}
            onChange={(v) => {
              setTab(v);
              setQuery('');
              setStatusFilter('All');
            }}
            tabs={[
              { value: 'grid', label: 'Grid', count: flatAgents.length },
              { value: 'hier', label: 'Hierarchy', count: groups.length },
            ]}
          />
        }
        search={<PageSearchInput value={query} onChange={setQuery} placeholder="Search agents…" />}
        cta={
          <PrimaryButton variant="ink" href="/agents/new">
            <Plus size={13} weight="bold" />
            New agent
          </PrimaryButton>
        }
      />

      {/* ── Grid view ─────────────────────────────────────────────────────── */}
      {tab === 'grid' && (
        <div className="pt-4">
          <ChipRow
            items={STATUS_CHIPS}
            value={statusFilter}
            onChange={setStatusFilter}
            className="mb-4"
          />

          {filteredGrid.length === 0 ? (
            <div className="rounded-2xl border border-rule-2 bg-paper px-6 py-12 text-center">
              <p className="text-[13px] text-ink-3">No agents match the current filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
              {filteredGrid.map((agent) => (
                <AgentGridCard
                  key={agent.id}
                  agent={agent}
                  activity={activityByAgent.get(agent.id) ?? null}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── Hierarchy view ────────────────────────────────────────────────── */}
      {tab === 'hier' && (
        <div className="pt-4 space-y-0">
          <Banner variant="tip" className="mb-4">
            Drag any worker row to reorder it within its team. Drag an orchestrator header to
            reorder teams.
          </Banner>

          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handleGroupDragEnd}
          >
            <SortableContext items={orchestratorIds} strategy={verticalListSortingStrategy}>
              <div className="space-y-3.5">
                {groups.map((g, gi) => {
                  const isStandalone = g.orchestrator === null;

                  if (isStandalone) {
                    // Standalone bucket — workers with no orchestrator parent.
                    return (
                      <StandaloneSection
                        key="__standalone__"
                        workers={g.workers}
                        disabled={isPending}
                        sensors={sensors}
                        activityByAgent={activityByAgent}
                        onDragEnd={(e) => handleWorkerDragEnd(gi, e)}
                      />
                    );
                  }

                  return (
                    <SortableOrchestratorSection
                      key={g.orchestrator!.id}
                      orchestrator={g.orchestrator!}
                      workers={g.workers}
                      disabled={isPending}
                      sensors={sensors}
                      activityByAgent={activityByAgent}
                      onWorkerDragEnd={(e) => handleWorkerDragEnd(gi, e)}
                    />
                  );
                })}
              </div>
            </SortableContext>
          </DndContext>

          {/* "+ New orchestrator" dashed button */}
          <Link
            href="/agents/new"
            className="mt-4 flex items-center justify-center gap-3.5 rounded-[12px] border border-dashed border-rule bg-transparent px-4 py-4 text-[13.5px] font-medium text-ink-2 transition-colors hover:bg-hover"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-[8px] bg-canvas dark:bg-white/[0.06]">
              <Plus size={14} weight="bold" />
            </span>
            New orchestrator
            <span className="font-normal text-ink-4">· group workers under a coordinator</span>
          </Link>
        </div>
      )}
    </div>
  );
}

// ─── Sortable orchestrator section ───────────────────────────────────────────

function SortableOrchestratorSection({
  orchestrator,
  workers,
  disabled,
  sensors,
  activityByAgent,
  onWorkerDragEnd,
}: {
  orchestrator: AgentRow;
  workers: AgentRow[];
  disabled: boolean;
  sensors: ReturnType<typeof useSensors>;
  activityByAgent: Map<string, ActiveAgentRow>;
  onWorkerDragEnd: (e: DragEndEvent) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: orchestrator.id,
    disabled,
  });

  const router = useRouter();

  return (
    <OrchestratorCard
      orchestrator={orchestrator}
      workerCount={workers.length}
      cardRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-50' : ''}
      dragHandleProps={{ ...attributes, ...listeners }}
    >
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onWorkerDragEnd}>
        <SortableContext items={workers.map((w) => w.id)} strategy={verticalListSortingStrategy}>
          {/* Orchestrator's own entry at the top — non-sortable, spacer drag handle */}
          <NonSortableWorkerRow
            agent={orchestrator}
            activity={activityByAgent.get(orchestrator.id) ?? null}
            onClick={() => router.push(`/agents/${orchestrator.id}/edit`)}
            isOrchestrator
          />
          {workers.map((w) => (
            <SortableWorkerEntry
              key={w.id}
              agent={w}
              disabled={disabled}
              activity={activityByAgent.get(w.id) ?? null}
              onClick={() => router.push(`/agents/${w.id}/edit`)}
            />
          ))}
        </SortableContext>
      </DndContext>
    </OrchestratorCard>
  );
}

// ─── Standalone section (no orchestrator parent) ─────────────────────────────

function StandaloneSection({
  workers,
  disabled,
  sensors,
  activityByAgent,
  onDragEnd,
}: {
  workers: AgentRow[];
  disabled: boolean;
  sensors: ReturnType<typeof useSensors>;
  activityByAgent: Map<string, ActiveAgentRow>;
  onDragEnd: (e: DragEndEvent) => void;
}) {
  const router = useRouter();

  return (
    <div>
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-widest text-ink-3">
        Standalone
      </h2>
      <div className="rounded-[14px] border border-rule-2 bg-paper p-3">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
          <SortableContext items={workers.map((w) => w.id)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1.5">
              {workers.map((w) => (
                <SortableWorkerEntry
                  key={w.id}
                  agent={w}
                  disabled={disabled}
                  activity={activityByAgent.get(w.id) ?? null}
                  onClick={() => router.push(`/agents/${w.id}/edit`)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </div>
    </div>
  );
}

// ─── Sortable worker entry (wraps WorkerRow + useSortable) ───────────────────

function SortableWorkerEntry({
  agent,
  disabled,
  activity,
  onClick,
}: {
  agent: AgentRow;
  disabled: boolean;
  activity: ActiveAgentRow | null;
  onClick: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
    disabled,
  });

  return (
    <WorkerRow
      agent={agent}
      activity={activity}
      rowRef={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={isDragging ? 'opacity-50' : ''}
      dragHandleProps={{ ...attributes, ...listeners }}
      onClick={onClick}
    />
  );
}

// ─── Non-sortable worker row (orchestrator's own slot in the team) ────────────

function NonSortableWorkerRow({
  agent,
  activity,
  onClick,
  isOrchestrator,
}: {
  agent: AgentRow;
  activity: ActiveAgentRow | null;
  onClick: () => void;
  isOrchestrator?: boolean;
}) {
  return (
    <WorkerRow
      agent={agent}
      activity={activity}
      onClick={onClick}
      className={isOrchestrator ? 'border-b border-rule-2 pb-2.5 mb-0.5' : ''}
    />
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

type StatusFilterLabel = 'Running' | 'Idle' | 'Attention' | 'Paused';

function deriveStatusLabel(activity: ActiveAgentRow | null): StatusFilterLabel {
  if (!activity || activity.total === 0) return 'Idle';
  if (activity.processing > 0) return 'Running';
  if (activity.awaiting > 0) return 'Attention';
  return 'Idle';
}
