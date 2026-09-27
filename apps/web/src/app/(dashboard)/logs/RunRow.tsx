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
//     dernière page de ses appels est relue (voir les garde-fous du suivi plus
//     bas) et le compteur de la ligne repliée suit. Même mécanisme que le fil de
//     conversation (`spaces/LiveRefresh.tsx` : un intervalle, une relecture,
//     pas un second chemin de données) — seule la portée change, parce que les
//     appels d'une ligne dépliée sont un état du navigateur qu'un
//     `router.refresh()` ne saurait pas remplir.

import { useCallback, useEffect, useRef, useState } from 'react';
import { listRunCallsAction, type ActivityRunRow, type RunCall } from '@/lib/actions.ts';
import { runIsLive } from '@/lib/activity-runs.ts';
import { truncate } from '@/lib/format-time';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import Banner from '@/components/ui/Banner';
import {
  Tr,
  Td,
  CellAgent,
  CellChevron,
  CellMono,
  CellText,
  TableDetailNote,
  TableDetailRow,
} from '@/components/ui/Table';
import RowActionButton from '@/components/ui/RowActionButton';
import ToolBlock from '../spaces/ToolBlock.tsx';
import { formatMs, formatCost } from '../spaces/format.ts';
import ModelCallBlock from './ModelCallBlock.tsx';

/** Combien d'appels une page de dépliage porte, et ce que « show more » ajoute. */
export const CALLS_PAGE_SIZE = 50;

/**
 * Le suivi d'une ligne dépliée, et ses trois garde-fous.
 *
 * Suivre un run vivant coûte une requête par tour. Sans limite, un run resté
 * bloqué en `processing` — ça arrive, c'est même ce que la page sert à voir —
 * ferait battre un onglet oublié toute la nuit : à trois secondes, presque
 * trente mille requêtes. Donc :
 *
 *   — l'onglet CACHÉ ne demande rien (personne ne lit) ;
 *   — le rythme s'espace : trois secondes pendant cinq minutes, le temps de
 *     regarder un run travailler, puis trente secondes ;
 *   — au bout d'une demi-heure le suivi S'ARRÊTE, et la ligne le DIT. Un
 *     suivi qui s'arrête en silence se lirait comme un run qui ne fait plus
 *     rien (invariant #4).
 */
const FOLLOW_FAST_MS = 3_000;
const FOLLOW_SLOW_MS = 30_000;
const FOLLOW_SLOWS_AFTER_MS = 5 * 60_000;
const FOLLOW_STOPS_AFTER_MS = 30 * 60_000;

/** Le délai avant la prochaine relecture, selon le temps déjà passé à suivre. */
export function followDelayMs(elapsedMs: number): number {
  return elapsedMs < FOLLOW_SLOWS_AFTER_MS ? FOLLOW_FAST_MS : FOLLOW_SLOW_MS;
}

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
  costDecimals,
  defaultExpanded = false,
}: {
  run: ActivityRunRow;
  /** Le nombre de colonnes de la table, pour la ligne dépliée. */
  columns: number;
  /** La précision de la colonne des coûts, la même pour toutes ses lignes. */
  costDecimals?: 2 | 4;
  /** Lien profond : la ligne s'ouvre déjà dépliée. */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [pages, setPages] = useState<RunCall[][]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Le plafond de suivi est atteint : la ligne ne demande plus rien, et le dit. */
  const [stoppedFollowing, setStoppedFollowing] = useState(false);
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
  //
  // Une chaîne de `setTimeout`, pas un `setInterval` : le délai change en
  // cours de route (voir followDelayMs), et un intervalle fixe ne sait pas
  // s'espacer.
  useEffect(() => {
    if (!expanded || !runIsLive(run.status) || stoppedFollowing) return;
    const startedAt = Date.now();
    let timer: ReturnType<typeof setTimeout>;
    const tick = (): void => {
      const elapsed = Date.now() - startedAt;
      if (elapsed >= FOLLOW_STOPS_AFTER_MS) {
        setStoppedFollowing(true);
        return;
      }
      // Onglet caché : on garde le rythme, on ne demande rien.
      if (typeof document === 'undefined' || document.visibilityState !== 'hidden') {
        void loadPage(Math.max(1, pageCount.current));
      }
      timer = setTimeout(tick, followDelayMs(Date.now() - startedAt));
    };
    timer = setTimeout(tick, followDelayMs(0));
    return () => clearTimeout(timer);
  }, [expanded, run.status, stoppedFollowing, loadPage]);

  const calls = pages.flat();
  const count = total ?? run.callCount;

  return (
    <>
      <Tr
        interactive
        expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        data-testid={`run-row-${run.id}`}
      >
        <Td className="w-8">
          <CellChevron expanded={expanded} />
        </Td>
        <Td data-testid="run-agent">
          <CellAgent name={run.agentName} imageUrl={run.agentAvatarUrl} />
        </Td>
        <Td className="hidden md:table-cell" data-testid="run-origin">
          <CellText meta={run.origin.detail ?? undefined}>{run.origin.label}</CellText>
        </Td>
        <Td className="max-w-[320px]" data-testid="run-task">
          <CellText title={run.task} clamp>
            {truncate(run.task, 72)}
          </CellText>
        </Td>
        <Td data-testid="run-status">
          <StatusPill variant={statusVariant(run.status)} label={statusLabel(run.status)} />
        </Td>
        <Td align="right" className="hidden lg:table-cell" data-testid="run-duration">
          <CellMono>{durationText(run)}</CellMono>
        </Td>
        <Td align="right" className="hidden lg:table-cell" data-testid="run-cost">
          <CellMono>{formatCost(run.costUsd, costDecimals)}</CellMono>
        </Td>
        <Td align="right" data-testid="run-calls">
          <CellMono>
            {count} {count === 1 ? 'call' : 'calls'}
          </CellMono>
        </Td>
      </Tr>

      {expanded && (
        <TableDetailRow
          colSpan={columns}
          label="Calls"
          action={<RowActionButton href={`/jobs/${run.id}`}>Open run</RowActionButton>}
          data-testid={`run-calls-${run.id}`}
        >
          {error !== null && (
            <Banner variant="warn" role="alert" className="mb-3">
              {error}
            </Banner>
          )}

          {error === null && calls.length === 0 && !loading && (
            <TableDetailNote>No call recorded for this run.</TableDetailNote>
          )}

          {loading && calls.length === 0 && <TableDetailNote>Loading calls…</TableDetailNote>}

          <div className="space-y-1.5">
            {calls.map((call) =>
              call.kind === 'tool' ? (
                <ToolBlock key={call.id} step={call.step} />
              ) : (
                <ModelCallBlock key={call.id} call={call} />
              ),
            )}
          </div>

          {stoppedFollowing && runIsLive(run.status) && (
            <div className="mt-3">
              <TableDetailNote data-testid="run-follow-stopped">
                Stopped following, reload to resume.
              </TableDetailNote>
            </div>
          )}

          {hasMore && (
            <div className="mt-3">
              <RowActionButton
                onClick={() => void loadPage(pageCount.current + 1)}
                disabled={loading}
              >
                Show {CALLS_PAGE_SIZE} more
              </RowActionButton>
            </div>
          )}
        </TableDetailRow>
      )}
    </>
  );
}
