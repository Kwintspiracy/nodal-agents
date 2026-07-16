'use client';

// AgentsList — the card-based hierarchy view of the entity's agents.
//
// Rendering rules:
//   - Each orchestrator gets a card: header (avatar, name, personality
//     preview, Channels/Edit — Delete moved to the agent edit page's
//     Settings tab danger zone) + an indented, dashed-line-connected
//     list of its worker rows + an "Add worker" footer.
//   - A worker can appear under multiple orchestrators (that's an
//     intentional schema property of agent_assignments) — the action layer
//     surfaces it under each parent and we render it accordingly.
//   - A final "Unassigned" card lists workers that no orchestrator owns.
//     Always rendered (even with zero workers) — it's the drop target a
//     worker lands on when dragged out of every team, so it can't disappear
//     just because it's momentarily empty.
//
// Drag-and-drop scoping (dnd-kit), single DndContext for the whole board:
//   - GROUP HEADERS reorder among themselves via one `<SortableContext>` over
//     the orchestrator ids. Dragging a card header moves the whole team.
//   - WORKER ROWS reorder within a team AND move ACROSS teams (or to/from
//     Unassigned). Each team's worker list is its own `<SortableContext>` +
//     `useDroppable` container (so an empty team is still a valid drop
//     target); `onDragOver` relocates the dragged worker between the
//     in-memory group arrays live (the standard dnd-kit multi-container
//     pattern), `onDragEnd` commits: same-container drop → `reorderAgentsAction`
//     (position only), cross-container drop → `moveWorkerAssignmentAction`
//     (agent_assignments membership).
//   - Header drags and worker drags share the DndContext (nesting two
//     contexts would make dnd-kit register cross-card worker drops against
//     the wrong context) — `active.data.current.type` tags which handler
//     a given drag belongs to.
//
// Why one board instead of the old per-group nested contexts: cross-group
// drag needs every team's worker list mounted under the SAME DndContext, or
// dnd-kit has no way to detect a drop landing in a different team's list.
//
// Why drag-and-drop instead of ↑/↓ buttons (which we shipped first):
//   Quentin called the ↑/↓ UX "la pire UX de tous les temps" after one
//   live test. dnd-kit gives us proper drag, accessible keyboard fallback
//   (Space to grab, arrows to move, Enter to drop), and touch support.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  type ReactNode,
} from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ChatsCircle, PencilSimple, DotsSixVertical } from '@phosphor-icons/react';
import RowActionButton from '@/components/ui/RowActionButton';
import EmptyState from '@/components/ui/EmptyState';
import DsAgentAvatar from '@/components/ui/AgentAvatar';
import EdAddButton from '@/components/ui/EdAddButton';
import AgentForm from '@/components/AgentForm.tsx';
import {
  reorderAgentsAction,
  moveWorkerAssignmentAction,
  getActiveJobsByAgentAction,
  type ActiveAgentRow,
  type AgentGroup,
  type AgentRow,
  type LlmKeyUiRow,
} from '@/lib/actions.ts';
import AddWorkerModal from './AddWorkerModal.tsx';

/** Refresh cadence for the live activity badges. Same as ActiveAgentsPanel
 *  on /stats — fast enough to feel live without hammering the DB. */
const ACTIVITY_POLL_MS = 5000;

/** Container key for the Unassigned bucket (orchestrator === null). Prefixed
 *  container ids (below) never collide with a real agent uuid, so a worker
 *  row's sortable id and its enclosing container's droppable id can safely
 *  coexist in the same DndContext. */
const STANDALONE_KEY = '__standalone__';

function containerIdOf(group: AgentGroup): string {
  return `container:${group.orchestrator?.id ?? STANDALONE_KEY}`;
}

function orchestratorIdFromContainerId(containerId: string): string | null {
  const raw = containerId.replace(/^container:/, '');
  return raw === STANDALONE_KEY ? null : raw;
}

/** Ensures an Unassigned bucket is always present in the client-rendered
 *  list, even when the server omitted it (empty). Without this, a worker
 *  dragged out of every team would have nowhere to visually land. */
function ensureStandalone(groups: AgentGroup[]): AgentGroup[] {
  if (groups.some((g) => g.orchestrator === null)) return groups;
  return [...groups, { orchestrator: null, workers: [] }];
}

/** Resolves the container id (see `containerIdOf`) that currently owns a
 *  given drag-event id — which is either a worker's raw agent id, or a
 *  container id itself (dropped on the empty area of a team). */
function findContainerId(groups: AgentGroup[], id: string): string | null {
  if (id.startsWith('container:')) return id;
  for (const g of groups) {
    if (g.workers.some((w) => w.id === id)) return containerIdOf(g);
  }
  return null;
}

interface Props {
  initialGroups: AgentGroup[];
  /** Initial activity snapshot from the server render; refreshed client-side. */
  initialActivity: ActiveAgentRow[];
  /** Full flat agent list — powers the "Add worker" picker and the
   *  "New orchestrator" create modal's sub-agent picker. */
  agents: AgentRow[];
  llmKeys: LlmKeyUiRow[];
}

export default function AgentsList({
  initialGroups,
  initialActivity,
  agents,
  llmKeys,
}: Props) {
  // Stable content signature of the server prop. Changes whenever the set of
  // agent IDs or team memberships changes (delete, add, move, or a reorder
  // server-round-trip completes).
  const serverGroupsKey = useMemo(
    () =>
      initialGroups
        .flatMap((g) => [
          g.orchestrator ? `o:${g.orchestrator.id}` : 'standalone',
          ...g.workers.map((w) => w.id),
        ])
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

  if (seenKey !== serverGroupsKey) {
    setGroupsState({ displayed: null, seenKey: serverGroupsKey });
  }

  // The list every render uses: optimistic override while a drag/move is in
  // flight; server data the rest of the time (including right after a
  // delete). Unassigned is always present so it's always a valid drop target.
  const groups = ensureStandalone((seenKey === serverGroupsKey ? displayed : null) ?? initialGroups);

  const [activity, setActivity] = useState<ActiveAgentRow[]>(initialActivity);
  const [isPending, startTransition] = useTransition();
  const [addWorkerForId, setAddWorkerForId] = useState<string | null>(null);
  const router = useRouter();

  // dnd-kit is not SSR-stable: its a11y announcement IDs (DndDescribedBy-N)
  // come from an internal counter that drifts between the server and client
  // renders, triggering a hydration mismatch. useSyncExternalStore is the
  // SSR-safe "are we on the client yet?" signal — false on the server + first
  // paint, true after — so we render a static (non-draggable) board for SSR +
  // hydration and mount the drag-and-drop tree client-only.
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

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
    };
    const id = setInterval(() => void tick(), ACTIVITY_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

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

  function commitWorkerMove(
    workerId: string,
    fromOrchestratorId: string | null,
    toOrchestratorId: string | null,
    previous: AgentGroup[],
  ) {
    startTransition(async () => {
      const r = await moveWorkerAssignmentAction({ workerId, fromOrchestratorId, toOrchestratorId });
      if (!r.ok) {
        toast.error(r.message);
        setGroupsState((s) => ({ ...s, displayed: previous }));
        return;
      }
      router.refresh();
    });
  }

  // Drag-end for GROUP HEADERS — reorders teams among themselves; Unassigned
  // stays anchored last because it has no draggable header.
  function handleGroupDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const oldIdx = groups.findIndex((g) => g.orchestrator?.id === active.id);
    const newIdx = groups.findIndex((g) => g.orchestrator?.id === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    submitReorder(arrayMove(groups, oldIdx, newIdx));
  }

  // originContainerId is captured at drag start (before onDragOver has a
  // chance to relocate the item) so onDragEnd can tell "did this cross into
  // a different team" apart from "reordered within the same one". The
  // pre-drag groups snapshot lets a failed server call roll back cleanly.
  const workerDragOriginRef = useRef<string | null>(null);
  const workerDragSnapshotRef = useRef<AgentGroup[] | null>(null);

  function handleDragStart(e: DragStartEvent) {
    if (e.active.data.current?.['type'] !== 'worker') return;
    workerDragOriginRef.current = findContainerId(groups, String(e.active.id));
    workerDragSnapshotRef.current = groups;
  }

  // Live relocation while dragging over a DIFFERENT team's container — moves
  // the worker between the in-memory group arrays so the drop target's
  // placeholder shows where it will land. Same-container hover is left to
  // dnd-kit's own SortableContext animation.
  function handleDragOver(e: DragOverEvent) {
    const { active, over } = e;
    if (active.data.current?.['type'] !== 'worker' || !over) return;
    const activeId = String(active.id);
    const fromId = findContainerId(groups, activeId);
    const toId = findContainerId(groups, String(over.id));
    if (!fromId || !toId || fromId === toId) return;

    setGroupsState((s) => {
      const base = ensureStandalone(s.displayed ?? groups);
      const fromIdx = base.findIndex((g) => containerIdOf(g) === fromId);
      const toIdx = base.findIndex((g) => containerIdOf(g) === toId);
      if (fromIdx < 0 || toIdx < 0) return s;
      const worker = base[fromIdx]!.workers.find((w) => w.id === activeId);
      if (!worker) return s;
      const newFromWorkers = base[fromIdx]!.workers.filter((w) => w.id !== activeId);
      const overIdx = base[toIdx]!.workers.findIndex((w) => w.id === String(over.id));
      const insertAt = overIdx >= 0 ? overIdx : base[toIdx]!.workers.length;
      const newToWorkers = [...base[toIdx]!.workers];
      newToWorkers.splice(insertAt, 0, worker);
      const next = base.map((g, i) =>
        i === fromIdx
          ? { ...g, workers: newFromWorkers }
          : i === toIdx
            ? { ...g, workers: newToWorkers }
            : g,
      );
      return { ...s, displayed: next };
    });
  }

  function handleDragEnd(e: DragEndEvent) {
    const type = e.active.data.current?.['type'];
    if (type === 'header') {
      handleGroupDragEnd(e);
      return;
    }
    if (type !== 'worker') return;

    const originId = workerDragOriginRef.current;
    const snapshot = workerDragSnapshotRef.current;
    workerDragOriginRef.current = null;
    workerDragSnapshotRef.current = null;

    const { active, over } = e;
    if (!over || !originId) return;
    const activeId = String(active.id);
    const finalId = findContainerId(groups, String(over.id)) ?? findContainerId(groups, activeId);
    if (!finalId) return;

    if (finalId === originId) {
      // Same team at drop time: pure intra-group reorder (a round-trip
      // through another team during the drag is already reconciled back to
      // this state by handleDragOver).
      const gi = groups.findIndex((g) => containerIdOf(g) === finalId);
      if (gi < 0) return;
      const workers = groups[gi]!.workers;
      const oldIdx = workers.findIndex((w) => w.id === activeId);
      const newIdx = workers.findIndex((w) => w.id === String(over.id));
      if (oldIdx < 0 || newIdx < 0 || oldIdx === newIdx) return;
      const newWorkers = arrayMove(workers, oldIdx, newIdx);
      submitReorder(groups.map((g, i) => (i === gi ? { ...g, workers: newWorkers } : g)));
      return;
    }

    // Cross-team: `groups` already reflects the moved worker (onDragOver
    // relocated it live) — persist the new membership.
    commitWorkerMove(
      activeId,
      orchestratorIdFromContainerId(originId),
      orchestratorIdFromContainerId(finalId),
      snapshot ?? groups,
    );
  }

  function handleWorkersAssigned(orchestratorId: string, added: AgentRow[]) {
    setGroupsState((s) => {
      const base = ensureStandalone(s.displayed ?? groups);
      const next = base.map((g) =>
        g.orchestrator?.id === orchestratorId
          ? { ...g, workers: [...g.workers, ...added.filter((a) => !g.workers.some((w) => w.id === a.id))] }
          : g,
      );
      return { ...s, displayed: next };
    });
  }

  if (agents.length === 0) {
    return <EmptyState title="No agents yet. Create one above." />;
  }

  const orchestratorIds = groups
    .map((g) => g.orchestrator?.id)
    .filter((id): id is string => Boolean(id));

  const addWorkerOrchestrator = addWorkerForId
    ? (groups.find((g) => g.orchestrator?.id === addWorkerForId)?.orchestrator ?? null)
    : null;
  const addWorkerCurrentIds = addWorkerForId
    ? (groups.find((g) => g.orchestrator?.id === addWorkerForId)?.workers.map((w) => w.id) ?? [])
    : [];

  const newOrchestratorButton = (
    <AgentForm
      llmKeys={llmKeys}
      agents={agents}
      initialRole="router"
      renderTrigger={(open) => (
        <EdAddButton size="lg" onClick={open} hint="group workers under a coordinator">
          New orchestrator
        </EdAddButton>
      )}
    />
  );

  const modals = addWorkerOrchestrator && (
    <AddWorkerModal
      open={Boolean(addWorkerForId)}
      onClose={() => setAddWorkerForId(null)}
      orchestrator={addWorkerOrchestrator}
      allAgents={agents}
      currentWorkerIds={addWorkerCurrentIds}
      onAssigned={(added) => handleWorkersAssigned(addWorkerOrchestrator.id, added)}
    />
  );

  // Server + first client paint: static, non-draggable board (no dnd-kit) so
  // SSR and hydration match exactly. The drag-and-drop tree mounts below.
  // Render order: orchestrator cards → "New orchestrator" CTA → Unassigned.
  // The CTA sits between the teams it creates and the bucket it feeds from,
  // inside the same gap-5 column so spacing stays uniform.
  const orchGroups = groups.filter((g) => g.orchestrator !== null);
  const standaloneGroup = groups.find((g) => g.orchestrator === null) ?? null;

  if (!mounted) {
    return (
      <div className="flex flex-col gap-5">
        {orchGroups.map((g) => (
          <StaticAgentCard
            key={g.orchestrator?.id ?? STANDALONE_KEY}
            group={g}
            activityByAgent={activityByAgent}
            onAddWorker={setAddWorkerForId}
          />
        ))}
        {newOrchestratorButton}
        {standaloneGroup && (
          <StaticAgentCard
            key={STANDALONE_KEY}
            group={standaloneGroup}
            activityByAgent={activityByAgent}
            onAddWorker={setAddWorkerForId}
          />
        )}
        {modals}
      </div>
    );
  }

  return (
    <>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        <div className="flex flex-col gap-5">
          <SortableContext items={orchestratorIds} strategy={verticalListSortingStrategy}>
            {orchGroups.map((g) => (
              <SortableAgentCard
                key={g.orchestrator?.id ?? STANDALONE_KEY}
                group={g}
                disabled={isPending}
                activityByAgent={activityByAgent}
                onAddWorker={setAddWorkerForId}
              />
            ))}
          </SortableContext>
          {newOrchestratorButton}
          {standaloneGroup && (
            <SortableAgentCard
              key={STANDALONE_KEY}
              group={standaloneGroup}
              disabled={isPending}
              activityByAgent={activityByAgent}
              onAddWorker={setAddWorkerForId}
            />
          )}
        </div>
      </DndContext>
      {modals}
    </>
  );
}

// ─── Card shell (shared layout, parameterised by header/rows renderer) ───────

interface CardBodyProps {
  group: AgentGroup;
  onAddWorker: (orchestratorId: string) => void;
  header: ReactNode;
  workersZone: ReactNode;
}

function CardShell({ group, header, workersZone, onAddWorker }: CardBodyProps) {
  const orchestrator = group.orchestrator;
  return (
    <div className="rounded-2xl border border-rule-2 bg-paper p-[17px]">
      {orchestrator ? (
        header
      ) : (
        <p className="text-legacy-10 font-normal uppercase tracking-[0.12em] text-ink-3">Unassigned</p>
      )}
      <div className={orchestrator ? 'pl-5 pt-4' : 'pt-4'}>
        <div
          className={
            orchestrator
              ? 'flex flex-col gap-2 border-l border-dashed border-rule-2 pl-[17px]'
              : 'flex flex-col gap-2'
          }
        >
          {workersZone}
          {orchestrator && (
            <EdAddButton size="sm" onClick={() => onAddWorker(orchestrator.id)}>
              Add worker
            </EdAddButton>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sortable (mounted, drag-and-drop-enabled) card ───────────────────────────

function SortableAgentCard({
  group,
  disabled,
  activityByAgent,
  onAddWorker,
}: {
  group: AgentGroup;
  disabled: boolean;
  activityByAgent: Map<string, ActiveAgentRow>;
  onAddWorker: (orchestratorId: string) => void;
}) {
  const orchestrator = group.orchestrator;
  const containerId = containerIdOf(group);
  const { setNodeRef: setDropRef } = useDroppable({ id: containerId, data: { type: 'container' } });

  return (
    <CardShell
      group={group}
      onAddWorker={onAddWorker}
      header={
        orchestrator && (
          <SortableCardHeader
            orchestrator={orchestrator}
            disabled={disabled}
            activity={activityByAgent.get(orchestrator.id) ?? null}
          />
        )
      }
      workersZone={
        <SortableContext
          items={group.workers.map((w) => w.id)}
          strategy={verticalListSortingStrategy}
        >
          <div ref={setDropRef} className="flex w-full flex-col gap-2">
            {group.workers.map((w) => (
              <SortableWorkerRow
                key={w.id}
                agent={w}
                disabled={disabled}
                activity={activityByAgent.get(w.id) ?? null}
              />
            ))}
            {group.workers.length === 0 && <EmptyDropHint />}
          </div>
        </SortableContext>
      }
    />
  );
}

function SortableCardHeader({
  orchestrator,
  disabled,
  activity,
}: {
  orchestrator: AgentRow;
  disabled: boolean;
  activity: ActiveAgentRow | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: orchestrator.id,
    disabled,
    data: { type: 'header' },
  });

  return (
    <div className="flex items-end gap-3">
      <div
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        {...attributes}
        {...listeners}
        title="Drag to reorder team"
        className={`flex min-w-0 flex-1 cursor-grab items-end gap-3 touch-none active:cursor-grabbing ${isDragging ? 'opacity-50' : ''}`}
      >
        <OrchestratorHeaderContent orchestrator={orchestrator} />
      </div>
      <ActivityBadge agent={orchestrator} activity={activity} />
      <div className="flex shrink-0 items-center gap-2 pb-0.5">
        <RowActions agent={orchestrator} />
      </div>
    </div>
  );
}

function SortableWorkerRow({
  agent,
  disabled,
  activity,
}: {
  agent: AgentRow;
  disabled: boolean;
  activity: ActiveAgentRow | null;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: agent.id,
    disabled,
    data: { type: 'worker' },
  });

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex w-full items-center gap-[10px] rounded-[10px] border border-rule-2 bg-hover p-[10px] ${isDragging ? 'opacity-50' : ''}`}
    >
      <span
        {...attributes}
        {...listeners}
        aria-label="Drag row"
        title="Drag to reorder or move to another team"
        className="shrink-0 cursor-grab touch-none select-none text-ink-4 transition-colors hover:text-ink-3 active:cursor-grabbing"
      >
        <DotsSixVertical size={13} />
      </span>
      <WorkerRowContent agent={agent} activity={activity} />
    </div>
  );
}

// ─── Static (SSR-safe, non-draggable) card ────────────────────────────────────

function StaticAgentCard({
  group,
  activityByAgent,
  onAddWorker,
}: {
  group: AgentGroup;
  activityByAgent: Map<string, ActiveAgentRow>;
  onAddWorker: (orchestratorId: string) => void;
}) {
  const orchestrator = group.orchestrator;
  return (
    <CardShell
      group={group}
      onAddWorker={onAddWorker}
      header={
        orchestrator && (
          <div className="flex items-end gap-3">
            <div className="flex min-w-0 flex-1 items-end gap-3">
              <OrchestratorHeaderContent orchestrator={orchestrator} />
            </div>
            <ActivityBadge agent={orchestrator} activity={activityByAgent.get(orchestrator.id) ?? null} />
            <div className="flex shrink-0 items-center gap-2 pb-0.5">
              <RowActions agent={orchestrator} />
            </div>
          </div>
        )
      }
      workersZone={
        <div className="flex w-full flex-col gap-2">
          {group.workers.map((w) => (
            <div
              key={w.id}
              className="group flex w-full items-center gap-[10px] rounded-[10px] border border-rule-2 bg-hover p-[10px]"
            >
              <span className="shrink-0 text-ink-4" aria-hidden>
                <DotsSixVertical size={13} />
              </span>
              <WorkerRowContent agent={w} activity={activityByAgent.get(w.id) ?? null} />
            </div>
          ))}
          {group.workers.length === 0 && <EmptyDropHint />}
        </div>
      }
    />
  );
}

function EmptyDropHint() {
  return (
    <div className="rounded-[10px] border border-dashed border-rule-2 px-3 py-4 text-center text-legacy-11 text-ink-4">
      Drag a worker here
    </div>
  );
}

// ─── Shared, non-hook content pieces (used by both card variants) ────────────

function OrchestratorHeaderContent({ orchestrator }: { orchestrator: AgentRow }) {
  return (
    <>
      <DsAgentAvatar name={orchestrator.name} imageUrl={orchestrator.avatarUrl} size="lg" />
      <div className="min-w-0 flex-1">
        <p className="text-legacy-10 font-normal uppercase tracking-[0.12em] text-ink-3">Orchestrator</p>
        <p className="truncate text-sm text-ink">{orchestrator.name}</p>
        <p className="truncate text-legacy-11-5 leading-[17px]! text-ink-3">{orchestrator.personality}</p>
      </div>
    </>
  );
}

function WorkerRowContent({
  agent,
  activity,
}: {
  agent: AgentRow;
  activity: ActiveAgentRow | null;
}) {
  return (
    <>
      <DsAgentAvatar name={agent.name} imageUrl={agent.avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-legacy-12-5 text-ink">{agent.name}</p>
        {agent.model && <p className="truncate text-legacy-11 text-ink-3">{agent.model}</p>}
      </div>
      <ActivityBadge agent={agent} activity={activity} />
      <div className="flex shrink-0 items-center gap-2">
        <RowActions agent={agent} />
      </div>
    </>
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
      className="ml-1 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-rule bg-hover px-2 py-0.5 text-legacy-11 text-ink-2 transition-colors hover:bg-hover"
    >
      <span className="relative inline-flex h-2 w-2 shrink-0">
        {dot.pulse && (
          <span
            className={`absolute inset-0 inline-flex h-full w-full rounded-full opacity-60 animate-ping ${dot.color}`}
          />
        )}
        <span className={`relative inline-flex h-2 w-2 rounded-full ${dot.color}`} />
      </span>
      <span className="font-mono tabular-nums">{activity.total}</span>
      <span className="text-legacy-10 text-ink-3">active</span>
    </Link>
  );
}

function RowActions({ agent }: { agent: AgentRow }) {
  return (
    <>
      <RowActionButton
        square
        href={`/agents/${agent.id}/edit?tab=channels`}
        icon={<ChatsCircle size={16} />}
        title="Channels"
      />
      <RowActionButton
        square
        href={`/agents/${agent.id}/edit`}
        icon={<PencilSimple size={16} />}
        title="Edit"
      />
    </>
  );
}
