'use client';

// AgentsList — grouped + drag-and-droppable view of the entity's agents.
//
// Rendering rules:
//   - Each orchestrator gets a section header followed by its sub-agents.
//   - A worker can appear under multiple orchestrators (that's an
//     intentional schema property of agent_assignments) — the action layer
//     surfaces it under each parent and we render it accordingly.
//   - A final "Standalone" section lists workers that no orchestrator
//     owns. Hidden when empty.
//
// Reordering uses a flattened-list model: every drag-end rebuilds the
// complete cross-group order in memory, then submits the full list to
// `reorderAgentsAction`. The action sets positions to 0, 10, 20, ... for
// everything in the array. Single source of truth for the `position`
// column, no per-group bucketing bugs.
//
// Drag-and-drop scoping (dnd-kit):
//   - WORKERS reorder INSIDE their group only — each group's `<SortableContext>`
//     is scoped to its worker IDs. dnd-kit's `closestCenter` collision
//     detection + the per-group context means a drop into another group is
//     a no-op at the data layer. Cross-group reassignment is a separate
//     UX (use the Edit page to change agent_assignments).
//   - GROUPS reorder via a separate `<SortableContext>` over the orchestrator
//     IDs themselves. Dragging a team header moves the whole team.
//   - The Standalone bucket has no draggable header — its workers can
//     reorder among themselves, but the bucket as a whole stays last.
//
// Why drag-and-drop instead of ↑/↓ buttons (which we shipped first):
//   Quentin called the ↑/↓ UX "la pire UX de tous les temps" after one
//   live test. Reordering 10+ agents with arrow buttons is genuinely
//   awful. dnd-kit gives us proper drag, accessible keyboard fallback
//   (Space to grab, arrows to move, Enter to drop), and touch support.

import Link from 'next/link';
import { useEffect, useMemo, useState, useSyncExternalStore, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
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
import { ChatsCircle, PencilSimple } from '@phosphor-icons/react';
import RowActionButton from '@/components/ui/RowActionButton';
import EmptyState from '@/components/ui/EmptyState';
import {
  reorderAgentsAction,
  deleteAgentAction,
  getActiveJobsByAgentAction,
  type ActiveAgentRow,
  type AgentGroup,
  type AgentRow,
} from '@/lib/actions.ts';
import DeleteAgentButton from './DeleteAgentButton.tsx';

/** Refresh cadence for the live activity badges. Same as ActiveAgentsPanel
 *  on /stats — fast enough to feel live without hammering the DB. */
const ACTIVITY_POLL_MS = 5000;

interface Props {
  initialGroups: AgentGroup[];
  /** Initial activity snapshot from the server render; refreshed client-side. */
  initialActivity: ActiveAgentRow[];
}

export default function AgentsList({ initialGroups, initialActivity }: Props) {
  // Stable content signature of the server prop. Changes whenever the set of
  // agent IDs changes (delete, add, or a reorder server-round-trip completes).
  const serverGroupsKey = useMemo(
    () =>
      initialGroups
        .flatMap((g) => [g.orchestrator?.id ?? '', ...g.workers.map((w) => w.id)])
        .join('|'),
    [initialGroups],
  );

  // getDerivedStateFromProps pattern: store both the displayed list AND the last
  // server key we derived it from inside a single state object. When the server
  // key changes (router.refresh() landed new initialGroups), we reset displayed
  // to null (= use initialGroups directly) — all in render, no effect, no ref.
  const [{ displayed, seenKey }, setGroupsState] = useState<{
    displayed: AgentGroup[] | null;
    seenKey: string;
  }>({ displayed: null, seenKey: serverGroupsKey });

  // If the server delivered new data since last render, derive updated state
  // immediately (during render). React allows setState calls during render when
  // they are guarded by a condition on a prop/derived value changing — this is
  // the documented getDerivedStateFromProps equivalent for function components.
  if (seenKey !== serverGroupsKey) {
    setGroupsState({ displayed: null, seenKey: serverGroupsKey });
  }

  // The list every render uses: optimistic override while a reorder is in
  // flight; server data the rest of the time (including right after a delete).
  const groups = (seenKey === serverGroupsKey ? displayed : null) ?? initialGroups;

  const [activity, setActivity] = useState<ActiveAgentRow[]>(initialActivity);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  // dnd-kit is not SSR-stable: its a11y announcement IDs (DndDescribedBy-N)
  // come from an internal counter that drifts between the server and client
  // renders, triggering a hydration mismatch. useSyncExternalStore is the
  // SSR-safe "are we on the client yet?" signal — false on the server + first
  // paint, true after — so we render a static (non-draggable) list for SSR +
  // hydration and mount the drag-and-drop tree client-only, where the dnd IDs
  // are only ever generated on the client.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // Index by agentId for O(1) lookup in each row. Recompute when the
  // poller delivers a new snapshot — same agent IDs but possibly new
  // counts.
  const activityByAgent = useMemo(() => {
    const m = new Map<string, ActiveAgentRow>();
    for (const a of activity) m.set(a.agentId, a);
    return m;
  }, [activity]);

  // Live polling for activity badges. Lives here (rather than each row)
  // so we do ONE network call per tick regardless of how many agents
  // are rendered.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await getActiveJobsByAgentAction();
      if (cancelled) return;
      if (r.ok) setActivity(r.data);
      // On error we silently keep the previous snapshot — a transient DB
      // hiccup shouldn't blank out the badges.
    };
    const id = setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Pointer for mouse/touch drag, Keyboard for a11y (Space → grab, arrows → move).
  // `distance: 8` on PointerSensor — a click that moves less than 8px stays a
  // click (so the Edit / Delete buttons on each row remain usable; they're
  // inside the draggable but a quick click never starts a drag).
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

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
    setGroupsState((s) => ({ ...s, displayed: next }));
    startTransition(async () => {
      const r = await reorderAgentsAction(flatten(next));
      if (!r.ok) {
        toast.error(r.message);
        setGroupsState((s) => ({ ...s, displayed: previous }));
        return;
      }
      router.refresh();
    });
  }

  // Drag-end handler for the WORKERS inside a given group. The `over.id` is
  // the worker we just dropped onto; we arrayMove within that group's
  // workers and submit.
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

  // Drag-end for GROUPS (the orchestrator section headers). Reorders teams
  // among themselves; Standalone (orchestrator === null) stays anchored at
  // the end because it has no draggable header.
  function handleGroupDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    // Find positions of the two orchestrators in the groups array. Skip
    // the Standalone bucket; its orchestrator is null and its id never
    // appears in the SortableContext.
    const oldIdx = groups.findIndex((g) => g.orchestrator?.id === active.id);
    const newIdx = groups.findIndex((g) => g.orchestrator?.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const next = arrayMove(groups, oldIdx, newIdx);
    submitReorder(next);
  }

  if (groups.length === 0) {
    return <EmptyState title="No agents yet. Create one above." />;
  }

  // IDs for the group-level SortableContext: just the orchestrators that
  // can shuffle. The Standalone bucket is excluded so it can't be dragged.
  const orchestratorIds = groups
    .map((g) => g.orchestrator?.id)
    .filter((id): id is string => Boolean(id));

  // Server + first client paint: static, non-draggable list (no dnd-kit) so
  // SSR and hydration match exactly. The drag-and-drop tree mounts below.
  if (!mounted) {
    return (
      <div className="space-y-6">
        {groups.map((g) => {
          const isStandalone = g.orchestrator === null;
          return (
            <div key={isStandalone ? '__standalone__' : (g.orchestrator?.id ?? '')}>
              {g.orchestrator ? (
                <div className="mb-2 flex items-center gap-2">
                  <span className="leading-none text-ink-4" aria-hidden>
                    ⋮⋮
                  </span>
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-ink-3">
                    Team — {g.orchestrator.name}
                  </h2>
                </div>
              ) : (
                <h2 className="mb-2 text-xs font-semibold uppercase tracking-wider text-ink-3">
                  Standalone
                </h2>
              )}
              <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
                <table className="w-full text-sm">
                  <tbody>
                    {g.orchestrator && (
                      <NonSortableRow
                        agent={g.orchestrator}
                        indent={false}
                        activity={activityByAgent.get(g.orchestrator.id) ?? null}
                      />
                    )}
                    {g.workers.map((w) => (
                      <NonSortableRow
                        key={w.id}
                        agent={w}
                        indent={Boolean(g.orchestrator)}
                        activity={activityByAgent.get(w.id) ?? null}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
      <SortableContext items={orchestratorIds} strategy={verticalListSortingStrategy}>
        <div className="space-y-6">
          {groups.map((g, gi) => {
            const isStandalone = g.orchestrator === null;
            return (
              <div key={isStandalone ? '__standalone__' : (g.orchestrator?.id ?? '')}>
                {/* Section header — sortable when it's an orchestrator (the team
                    drag handle is the grip icon on the left of the title). */}
                {g.orchestrator ? (
                  <SortableTeamHeader orchestrator={g.orchestrator} disabled={isPending} />
                ) : (
                  <h2 className="mb-2 text-xs font-semibold text-ink-3 uppercase tracking-wider">
                    Standalone
                  </h2>
                )}

                {/* Worker rows — own DndContext nested for per-group scoping. */}
                <WorkerList
                  workers={g.workers}
                  indent={Boolean(g.orchestrator)}
                  orchestrator={g.orchestrator}
                  disabled={isPending}
                  onWorkerDragEnd={(e) => handleWorkerDragEnd(gi, e)}
                  sensors={sensors}
                  activityByAgent={activityByAgent}
                />
              </div>
            );
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}

// ─── Sortable team header (orchestrator row) ─────────────────────────────────

function SortableTeamHeader({
  orchestrator,
  disabled,
}: {
  orchestrator: AgentRow;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: orchestrator.id,
    disabled,
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`mb-2 flex items-center gap-2 ${isDragging ? 'opacity-50' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label="Drag team"
        title="Drag to reorder team"
        className="cursor-grab active:cursor-grabbing text-ink-4 hover:text-ink-2 transition-colors leading-none touch-none"
      >
        ⋮⋮
      </button>
      <h2 className="text-xs font-semibold text-ink-3 uppercase tracking-wider">
        Team — {orchestrator.name}
      </h2>
    </div>
  );
}

// ─── Worker list with nested DndContext (per-group scoping) ──────────────────

function WorkerList({
  workers,
  indent,
  orchestrator,
  disabled,
  onWorkerDragEnd,
  sensors,
  activityByAgent,
}: {
  workers: AgentRow[];
  indent: boolean;
  orchestrator: AgentRow | null;
  disabled: boolean;
  onWorkerDragEnd: (e: DragEndEvent) => void;
  sensors: ReturnType<typeof useSensors>;
  activityByAgent: Map<string, ActiveAgentRow>;
}) {
  const workerIds = workers.map((w) => w.id);

  // DnDContext lives OUTSIDE the <table> — dnd-kit renders an accessibility
  // <div> (screen-reader announcer + focus restorer) and the HTML spec
  // refuses <div> as a direct child of <tbody>, which makes React hydration
  // error out. SortableContext is a pure provider (no DOM) so it can live
  // inside <tbody> next to the <tr> children.
  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onWorkerDragEnd}>
      <div className="bg-paper border border-rule-2 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <tbody>
            <SortableContext items={workerIds} strategy={verticalListSortingStrategy}>
              {/* Orchestrator's own row first — not draggable HERE (the team
                  header drag handle moves the whole team). The drag-handle
                  column stays as a spacer for visual alignment. */}
              {orchestrator && (
                <NonSortableRow
                  agent={orchestrator}
                  indent={false}
                  activity={activityByAgent.get(orchestrator.id) ?? null}
                />
              )}
              {workers.map((w) => (
                <SortableWorkerRow
                  key={w.id}
                  agent={w}
                  indent={indent}
                  disabled={disabled}
                  activity={activityByAgent.get(w.id) ?? null}
                />
              ))}
            </SortableContext>
          </tbody>
        </table>
      </div>
    </DndContext>
  );
}

// ─── Sortable worker row ─────────────────────────────────────────────────────

function SortableWorkerRow({
  agent,
  indent,
  disabled,
  activity,
}: {
  agent: AgentRow;
  indent: boolean;
  disabled: boolean;
  activity: ActiveAgentRow | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
    disabled,
  });

  return (
    <tr
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`border-b border-rule-2 last:border-0 ${isDragging ? 'opacity-50 bg-hover' : ''}`}
    >
      <td className={`px-5 py-3 ${indent ? 'pl-10' : ''}`}>
        <div className="flex items-center gap-3">
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label="Drag row"
            title="Drag to reorder"
            className="cursor-grab active:cursor-grabbing text-ink-4 hover:text-ink-3 transition-colors leading-none touch-none select-none"
          >
            ⋮⋮
          </button>
          <AgentAvatar agent={agent} />
          <AgentLabel agent={agent} />
          <ActivityBadge agent={agent} activity={activity} />
        </div>
      </td>
      <RowActions agent={agent} />
    </tr>
  );
}

// ─── Non-sortable row (orchestrator's own row inside its team table) ─────────

function NonSortableRow({
  agent,
  indent,
  activity,
}: {
  agent: AgentRow;
  indent: boolean;
  activity: ActiveAgentRow | null;
}) {
  return (
    <tr className="border-b border-rule-2 last:border-0">
      <td className={`px-5 py-3 ${indent ? 'pl-10' : ''}`}>
        <div className="flex items-center gap-3">
          {/* Spacer aligning with the drag handle on worker rows below. */}
          <span className="w-4 inline-block" aria-hidden />
          <AgentAvatar agent={agent} />
          <AgentLabel agent={agent} />
          <ActivityBadge agent={agent} activity={activity} />
        </div>
      </td>
      <RowActions agent={agent} />
    </tr>
  );
}

// ─── Shared row pieces ───────────────────────────────────────────────────────

function AgentAvatar({ agent }: { agent: AgentRow }) {
  if (agent.avatarUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={agent.avatarUrl}
        alt=""
        width={32}
        height={32}
        className="w-8 h-8 rounded-full object-cover border border-rule-2 shrink-0"
      />
    );
  }
  // Initials fallback — first letter of the agent name in a neutral chip.
  // Keeps row height stable whether an avatar is set or not.
  return (
    <div className="w-8 h-8 rounded-full bg-hover text-ink-3 text-xs font-semibold flex items-center justify-center shrink-0">
      {agent.name.charAt(0).toUpperCase()}
    </div>
  );
}

function AgentLabel({ agent }: { agent: AgentRow }) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2">
        <span className="text-ink font-medium truncate">{agent.name}</span>
        {agent.isDefault && (
          <span className="text-[10px] font-semibold text-run uppercase tracking-wider">
            default
          </span>
        )}
        {agent.role === 'orchestrator' && (
          <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">
            orchestrator
          </span>
        )}
      </div>
      <span className="font-mono text-ink-3 text-[11px]">{agent.slug}</span>
      {agent.model && <span className="ml-2 text-ink-4 text-[11px]">· {agent.model}</span>}
    </div>
  );
}

// ─── Live activity badge ─────────────────────────────────────────────────────

/**
 * Renders a small live indicator next to an agent's name when at least one
 * job is in flight. Three buckets, priority-ordered:
 *
 *   - `processing` (blue, animated pulse): a worker is actively running an
 *     LLM turn right now. Most visually "alive" because it's the only
 *     state that actively burns tokens.
 *   - `awaiting` (amber, soft pulse): paused waiting for a child job or a
 *     human approval. Still in flight but not consuming compute.
 *   - `pending` (yellow, static): claimed but never picked up — usually a
 *     recovery candidate. Static dot signals "stuck, not running".
 *
 * Nothing renders when the agent is idle (no active jobs). The badge
 * links to `/jobs?agentId=<id>` so a click jumps to the filtered job
 * list — same target as the ActiveAgentsPanel cards on /stats so the
 * mental model stays consistent.
 */
function ActivityBadge({ agent, activity }: { agent: AgentRow; activity: ActiveAgentRow | null }) {
  if (!activity || activity.total === 0) return null;

  // Pick the most "alive" bucket for the dot color.
  // processing > awaiting > pending. Tooltip below shows the full
  // breakdown so the user can see every category at a glance.
  const dot =
    activity.processing > 0
      ? { color: 'bg-run', pulse: true, label: `${activity.processing} running` }
      : activity.awaiting > 0
        ? {
            color: 'bg-warn',
            pulse: true,
            label: `${activity.awaiting} awaiting`,
          }
        : { color: 'bg-warn', pulse: false, label: `${activity.pending} pending` };

  const tooltipLines: string[] = [];
  if (activity.processing > 0) tooltipLines.push(`${activity.processing} processing`);
  if (activity.awaiting > 0) tooltipLines.push(`${activity.awaiting} awaiting`);
  if (activity.pending > 0) tooltipLines.push(`${activity.pending} pending`);

  return (
    <Link
      href={`/jobs?agentId=${agent.id}`}
      title={tooltipLines.join(' · ')}
      onPointerDown={(e) => e.stopPropagation()}
      className="ml-1 inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full bg-hover hover:bg-hover border border-rule text-[11px] text-ink-2 transition-colors shrink-0"
    >
      <span className="relative inline-flex w-2 h-2 shrink-0">
        {dot.pulse && (
          <span
            className={`absolute inset-0 inline-flex h-full w-full rounded-full opacity-60 animate-ping ${dot.color}`}
          />
        )}
        <span className={`relative inline-flex w-2 h-2 rounded-full ${dot.color}`} />
      </span>
      <span className="font-mono tabular-nums">{activity.total}</span>
      <span className="text-ink-3 text-[10px]">active</span>
    </Link>
  );
}

function RowActions({ agent }: { agent: AgentRow }) {
  return (
    <td className="px-5 py-3 text-right">
      {/* Icon-only on mobile, label on desktop — keeps the row inside narrow
          screens instead of clipping the buttons against the card edge. */}
      <div className="flex items-center justify-end gap-2">
        <RowActionButton
          href={`/agents/${agent.id}/channels`}
          icon={<ChatsCircle size={13} />}
          title="Channels"
          responsive
        >
          Channels
        </RowActionButton>
        <RowActionButton
          href={`/agents/${agent.id}/edit`}
          icon={<PencilSimple size={13} />}
          title="Edit"
          responsive
        >
          Edit
        </RowActionButton>
        <DeleteAgentButton id={agent.id} name={agent.name} deleteAction={deleteAgentAction} />
      </div>
    </td>
  );
}
