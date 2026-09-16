'use client';

// RunsList — la table des runs de la vue Activity (#134).
//
// Elle ne fait que deux choses : poser l'en-tête, et donner à chaque ligne de
// quoi se déplier. Le compte des appels vient déjà rempli du serveur ; les
// appels eux-mêmes, non — c'est la ligne qui va les chercher quand on l'ouvre.

import Table, { THead, Th } from '@/components/ui/Table';
import type { ActivityRunRow } from '@/lib/actions.ts';
import RunRow from './RunRow.tsx';

/** Chevron, agent, origine, tâche, statut, durée, coût, appels. */
const COLUMNS = 8;

export default function RunsList({
  runs,
  expandedRunId = null,
}: {
  runs: ActivityRunRow[];
  /** Le run que le lien profond désigne : il s'ouvre déplié. */
  expandedRunId?: string | null;
}) {
  return (
    <Table>
      <THead>
        <Th />
        <Th>Agent</Th>
        <Th className="hidden md:table-cell">From</Th>
        <Th>Task</Th>
        <Th>Status</Th>
        <Th className="hidden lg:table-cell">Duration</Th>
        <Th className="hidden lg:table-cell">Cost</Th>
        <Th align="right">Calls</Th>
      </THead>
      <tbody>
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            columns={COLUMNS}
            defaultExpanded={run.id === expandedRunId}
          />
        ))}
      </tbody>
    </Table>
  );
}
