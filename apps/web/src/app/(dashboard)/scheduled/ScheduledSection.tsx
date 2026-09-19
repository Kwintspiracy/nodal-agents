'use client';

// ScheduledSection — les automatisations, repliées : une ligne par
// automatisation (nom, agent, nombre de runs, dernier run, échecs), ses runs
// dessous quand on l'ouvre. Comme la section « scheduled » de Claude Code : ce
// qui tourne tout seul ne doit pas noyer ce qu'on a demandé soi-même.
//
// P9 : c'est le CORPS de la page /scheduled — il n'est PLUS rendu sous
// /spaces. D'où le titre « Scheduled » retiré (il fait doublon avec le titre
// de page) et la marge haute laissée à la page. Le compteur reste : il dit
// d'un coup d'œil combien d'automatisations tournent et combien de runs sont
// listés.

import { useState } from 'react';
import Link from 'next/link';
import AgentAvatar from '@/components/ui/AgentAvatar';
import DisclosureButton from '@/components/ui/DisclosureButton';
import StatusPill, { type StatusVariant } from '@/components/ui/StatusPill';
import { MonoMicroTag } from '@/components/ui/MonoMicroTag';
import { relativeTime } from '@/lib/format-time';
import type { ScheduleGroup } from '@/lib/spaces-list.ts';
import { formatCost } from '../spaces/format.ts';

function statusVariant(status: string | null): StatusVariant {
  if (status === 'completed') return 'done';
  if (status === 'failed' || status === 'cancelled') return 'warn';
  if (status === 'processing' || status === 'pending' || (status?.startsWith('awaiting') ?? false))
    return 'run';
  return 'idle';
}

/**
 * Les runs d'une automatisation, dépliés. Extrait du composant parent parce
 * qu'un groupe est REPLIÉ par défaut : sans ce point d'entrée, un rendu
 * statique ne peut rien affirmer sur la garde du plan « un run ouvre son fil »
 * (`/scheduled/<id>` depuis P8 : /spaces/<id> est la page d'un PROJET). Le
 * parent n'a pas d'autre façon de dessiner ses runs.
 */
export function ScheduleRunList({
  runs,
  basePath = '/scheduled',
}: {
  runs: ScheduleGroup['runs'];
  /**
   * Sous quelle route les lignes ouvrent leur run. Par défaut `/scheduled`, la
   * page d'un run d'automatisation. La page d'UNE automatisation (#202) passe
   * `/jobs` pour un webhook : les runs d'un webhook ne passent pas par
   * `/scheduled`, et y mener donnerait un lien mort.
   *
   * Une CHAÎNE et non une fonction : un composant serveur ne peut passer que
   * des valeurs sérialisables à un composant client.
   */
  basePath?: string;
}) {
  return (
    <ul className="border-t border-rule-2 bg-canvas/40 py-1">
      {runs.map((r) => (
        <li key={r.id}>
          <Link
            href={`${basePath}/${r.id}`}
            className="flex items-center gap-3 px-4 py-1.5 pl-[44px] text-body-12 text-ink-2 hover:bg-hover"
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
 * Affiché AU-DESSUS de ses runs, parce que c'est ce qui décide s'il y aura un
 * travail au prochain : une routine qui a noté « v0.8.8 déjà annoncée » ne
 * réannoncera pas. Tant que cet état vivait dans la mémoire, personne ne
 * pouvait le voir ici, et le supprimer depuis la page Memories a fait publier
 * une annonce deux fois (08/09/2026).
 */
export function RoutineState({ entries }: { entries: RoutineStateEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <dl className="border-t border-rule-2 bg-canvas/40 px-4 py-2 pl-[44px]">
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

export default function ScheduledSection({
  groups,
  routineState = {},
}: {
  groups: ScheduleGroup[];
  /** L'état de chaque routine, par `schedule_id`. Vide quand rien n'a été retenu. */
  routineState?: Record<string, RoutineStateEntry[]>;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (groups.length === 0) return null;
  const runs = groups.reduce((acc, g) => acc + g.runs.length, 0);
  return (
    <section>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="text-mono-11 text-ink-4">
          {groups.length} {groups.length === 1 ? 'automation' : 'automations'} · {runs}{' '}
          {runs === 1 ? 'run' : 'runs'}
        </span>
      </div>
      <div className="overflow-hidden rounded-xl border border-rule-2 bg-paper">
        {groups.map((g) => {
          const isOpen = open[g.key] === true;
          return (
            <div key={g.key} className="border-b border-rule-2 last:border-b-0">
              <DisclosureButton
                open={isOpen}
                onClick={() => setOpen((o) => ({ ...o, [g.key]: !isOpen }))}
                className="py-2.5"
              >
                <AgentAvatar
                  name={g.agentName}
                  imageUrl={g.agentAvatarUrl}
                  size="sm"
                  shape="square"
                />
                <span className="min-w-0 flex-1 truncate text-body-13 text-ink">{g.name}</span>
                <span className="hidden text-body-12 text-ink-3 md:inline">{g.agentName}</span>
                <span className="text-mono-11 text-ink-4">
                  {g.runs.length} {g.runs.length === 1 ? 'run' : 'runs'}
                </span>
                {g.failed > 0 && (
                  <MonoMicroTag tone="err">
                    {g.failed} {g.failed === 1 ? 'failed' : 'failed'}
                  </MonoMicroTag>
                )}
                <span className="hidden text-mono-11 text-ink-4 lg:inline">
                  {g.lastRun.createdAt ? relativeTime(g.lastRun.createdAt) : ''}
                </span>
                <StatusPill variant={statusVariant(g.lastRun.status)} />
              </DisclosureButton>
              {isOpen && (
                <RoutineState entries={(g.scheduleId && routineState[g.scheduleId]) || []} />
              )}
              {isOpen && <ScheduleRunList runs={g.runs} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
