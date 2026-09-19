'use client';

// RunLines — les runs d'une automatisation, et ce qu'elle a retenu d'eux.
//
// Les deux composants viennent de `scheduled/ScheduledSection.tsx`, retiré avec
// sa page (#202). Ils ont déménagé ici parce que c'est désormais le seul écran
// où l'on regarde une automatisation travailler : les laisser là-bas aurait
// gardé un fichier vivant pour une page qui n'existe plus.
//
// Ils sont typés sur `SpaceListRow` et non sur un groupe : il n'y a plus de
// regroupement à faire, la page ne montre qu'UNE automatisation.

import Link from 'next/link';
import type { SpaceListRow } from '@/lib/actions.ts';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { relativeTime } from '@/lib/format-time';
import { formatCost } from '@/app/(dashboard)/spaces/format.ts';

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}

/**
 * Les runs, une ligne chacun, menant à leur page de run.
 *
 * `basePath` est une CHAÎNE et non une fonction : un composant serveur ne peut
 * passer que des valeurs sérialisables à un composant client. Une routine mène
 * à `/scheduled/<id>`, un webhook à `/jobs/<id>` — deux portes, la même page.
 */
export function ScheduleRunList({
  runs,
  basePath = '/scheduled',
}: {
  runs: readonly SpaceListRow[];
  basePath?: string;
}) {
  return (
    <ul className="border-t border-rule-2 bg-canvas/40 py-1">
      {runs.map((r) => (
        <li key={r.id}>
          <Link
            href={`${basePath}/${r.id}`}
            className="flex items-center gap-3 px-4 py-1.5 text-body-12 text-ink-2 hover:bg-hover"
          >
            <span className="text-mono-11 text-ink-4">
              {r.createdAt ? relativeTime(r.createdAt) : ''}
            </span>
            <span className="min-w-0 flex-1 truncate">
              {r.status === 'completed' ? 'ran' : (r.status ?? '')}
            </span>
            <span className="text-mono-11 text-ink-4">
              {r.costUsd > 0 ? formatCost(r.costUsd) : ''}
            </span>
            <StatusPill variant={statusVariant(r.status)} />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** Une entrée d'état de routine, telle que la page la reçoit. */
export type RoutineStateEntry = { key: string; value: string; updatedAt: Date | string };

/**
 * Ce que la routine a retenu de ses runs précédents.
 *
 * Pourquoi c'est à l'écran : cet état décide s'il y aura du travail au prochain
 * run. Une routine qui a noté « v0.8.8 déjà annoncée » ne réannoncera pas. Tant
 * que cet état vivait dans la mémoire, personne ne pouvait le voir ici, et le
 * supprimer depuis la page Memories a fait publier une annonce deux fois
 * (08/09/2026).
 */
export function RoutineState({ entries }: { entries: readonly RoutineStateEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="border-t border-rule-2 bg-canvas/40 px-4 py-2" data-testid="routine-state">
      {entries.map((e) => (
        <div key={e.key} className="flex items-baseline gap-3 py-0.5">
          <dt className="text-mono-11 text-ink-4">{e.key}</dt>
          <dd className="min-w-0 flex-1 truncate text-body-12 text-ink-2" title={e.value}>
            {e.value}
          </dd>
          <span className="text-mono-11 text-ink-4">{relativeTime(e.updatedAt)}</span>
        </div>
      ))}
    </dl>
  );
}
