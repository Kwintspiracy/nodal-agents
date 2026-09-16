'use client';

// RunRow — UNE ligne de la liste des runs, repliée puis dépliée (#134).
//
// Repliée, elle porte sept choses et pas une de plus : l'agent, d'où vient la
// demande, un titre court tiré de la tâche, le statut, la durée, le coût, le
// nombre d'appels. C'est la ligne qu'on lit cent fois par jour.
//
// Dépliée, elle montre les appels du run dans l'ordre du temps, outils et
// modèles entrelacés, avec les blocs du chat. Deux choix comptent ici :
//
//   — les appels ne sont demandés QU'AU DÉPLIAGE (`listRunCallsAction`, un run
//     à la fois). La page, elle, ne charge que des runs et leur compte ;
//   — un run qui tourne encore GRANDIT : tant qu'il est vivant et déplié, la
//     dernière page de ses appels est relue toutes les trois secondes et le
//     compteur de la ligne repliée suit. Même mécanisme que le fil de
//     conversation (`spaces/LiveRefresh.tsx` : un intervalle, une relecture,
//     pas un second chemin de données) — seule la portée change, parce que les
//     appels d'une ligne dépliée sont un état du navigateur qu'un
//     `router.refresh()` ne saurait pas remplir.

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CaretRight } from '@phosphor-icons/react';
import { listRunCallsAction, type ActivityRunRow, type RunCall } from '@/lib/actions.ts';
import { runIsLive } from '@/lib/activity-runs.ts';
import { truncate } from '@/lib/format-time';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import AgentAvatar from '@/components/ui/AgentAvatar';
import { Tr, Td } from '@/components/ui/Table';
import ToolBlock from '../spaces/ToolBlock.tsx';
import { formatMs, formatCost } from '../spaces/format.ts';
import ModelCallBlock from './ModelCallBlock.tsx';

/** Combien d'appels une page de dépliage porte, et ce que « show more » ajoute. */
export const CALLS_PAGE_SIZE = 50;

const REFRESH_MS = 3000;

export function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  return runIsLive(status) ? 'run' : 'idle';
}

export function statusLabel(status: string | null): string {
  const MAP: Record<string, string> = {
    pending: 'Pending',
    processing: 'Running',
    completed: 'Done',
    failed: 'Failed',
    awaiting_approval: 'Awaiting',
    awaiting_delegation: 'Awaiting',
    cancelled: 'Cancelled',
  };
  if (status === null) return 'Pending';
  return MAP[status] ?? status;
}

/**
 * La durée affichée. Un run qui tourne encore n'a pas de durée : le runner
 * n'écrit `total_duration_ms` qu'à la fin, et l'afficher rendrait « 0 ms » sur
 * un travail en cours depuis dix minutes.
 */
export function durationText(run: ActivityRunRow): string {
  if (run.durationMs === null || (run.durationMs === 0 && runIsLive(run.status))) return 'n/a';
  return formatMs(run.durationMs);
}

export default function RunRow({
  run,
  columns,
  defaultExpanded = false,
}: {
  run: ActivityRunRow;
  /** Le nombre de colonnes de la table, pour la ligne dépliée. */
  columns: number;
  /** Lien profond : la ligne s'ouvre déjà dépliée. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pages, setPages] = useState<RunCall[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Le nombre de pages déjà chargées, lisible depuis l'intervalle sans le
  // relancer à chaque page ajoutée.
  const pageCount = useRef(0);

  const loadPage = useCallback(
    async (n: number) => {
      setLoading(true);
      const result = await listRunCallsAction({
        jobId: run.id,
        page: n,
        pageSize: CALLS_PAGE_SIZE,
      });
      setLoading(false);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      setError(null);
      setHasMore(result.data.hasMore);
      setTotal(result.data.total);
      setPages((prev) => {
        const next = prev.slice(0, n - 1);
        next[n - 1] = result.data.items;
        pageCount.current = next.length;
        return next;
      });
    },
    [run.id],
  );

  // Au dépliage, et seulement là.
  useEffect(() => {
    if (!expanded || pageCount.current > 0) return;
    void loadPage(1);
  }, [expanded, loadPage]);

  // Tant que le run tourne : la DERNIÈRE page relue, là où les nouveaux appels
  // se posent. Les pages précédentes sont closes, les relire ne dirait rien de
  // neuf et ferait sauter ce que le lecteur est en train de lire.
  useEffect(() => {
    if (!expanded || !runIsLive(run.status)) return;
    const id = setInterval(() => {
      void loadPage(Math.max(1, pageCount.current));
    }, REFRESH_MS);
    return () => clearInterval(id);
  }, [expanded, run.status, loadPage]);

  const calls = pages.flat();
  const count = total ?? run.callCount;

  return (
    <>
      <Tr
        interactive
        hover={!expanded}
        className={expanded ? 'bg-hover' : ''}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        data-testid={`run-row-${run.id}`}
      >
        <Td top className="w-8">
          <CaretRight
            size={12}
            className={`text-ink-4 transition-transform ${expanded ? 'rotate-90' : ''}`}
            aria-hidden
          />
        </Td>
        <Td top data-testid="run-agent">
          <div className="flex items-center gap-2.5">
            <AgentAvatar
              name={run.agentName ?? 'Unknown'}
              imageUrl={run.agentAvatarUrl}
              size="md"
              shape="round"
            />
            <span className="truncate text-medium-14 text-ink">{run.agentName ?? 'Unknown'}</span>
          </div>
        </Td>
        <Td top className="hidden md:table-cell" data-testid="run-origin">
          <span className="text-body-13 text-ink-2">{run.origin.label}</span>
          {run.origin.detail !== null && (
            <div className="truncate text-mono-11 text-ink-4">{run.origin.detail}</div>
          )}
        </Td>
        <Td top className="max-w-[320px]" data-testid="run-task">
          <span className="line-clamp-1 text-body-14 text-ink-2" title={run.task}>
            {truncate(run.task, 72)}
          </span>
        </Td>
        <Td top data-testid="run-status">
          <StatusPill variant={statusVariant(run.status)} label={statusLabel(run.status)} />
        </Td>
        <Td
          top
          className="hidden font-mono text-xs text-ink-3 lg:table-cell"
          data-testid="run-duration"
        >
          {durationText(run)}
        </Td>
        <Td
          top
          className="hidden font-mono text-xs text-ink-3 lg:table-cell"
          data-testid="run-cost"
        >
          {formatCost(run.costUsd)}
        </Td>
        <Td top align="right" className="font-mono text-xs text-ink-3" data-testid="run-calls">
          {count} {count === 1 ? 'call' : 'calls'}
        </Td>
      </Tr>

      {expanded && (
        <Tr hover={false} className="bg-canvas" data-testid={`run-calls-${run.id}`}>
          <Td colSpan={columns} className="py-4">
            <div className="mb-3 flex items-center justify-between">
              <span className="text-legacy-10 uppercase tracking-wider text-ink-3">Calls</span>
              <Link
                href={`/jobs/${run.id}`}
                className="text-medium-13 text-ink-3 transition-colors hover:text-ink"
                onClick={(e) => e.stopPropagation()}
              >
                Open run
              </Link>
            </div>

            {error !== null && (
              <div className="rounded-md border border-err/25 bg-paper px-3 py-2 text-mono-12 text-err">
                {error}
              </div>
            )}

            {error === null && calls.length === 0 && !loading && (
              <div className="text-body-13 text-ink-4">No call recorded for this run.</div>
            )}

            {loading && calls.length === 0 && (
              <div className="text-body-13 text-ink-4">Loading calls…</div>
            )}

            <div className="space-y-1.5">
              {calls.map((call) =>
                call.kind === 'tool' ? (
                  <ToolBlock key={call.id} step={call.step} />
                ) : (
                  <ModelCallBlock key={call.id} call={call} />
                ),
              )}
            </div>

            {hasMore && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void loadPage(pageCount.current + 1);
                }}
                disabled={loading}
                className="mt-3 rounded-md border border-rule-2 px-3 py-1.5 text-medium-13 text-ink-3 transition-colors hover:border-rule hover:text-ink disabled:opacity-50"
              >
                Show {CALLS_PAGE_SIZE} more
              </button>
            )}
          </Td>
        </Tr>
      )}
    </>
  );
}
