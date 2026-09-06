'use client';

// ScheduledSection — les automatisations, repliées : une ligne par
// automatisation (nom, agent, nombre de runs, dernier run, échecs), ses runs
// dessous quand on l'ouvre. Comme la section « scheduled » de Claude Code : ce
// qui tourne tout seul ne doit pas noyer ce qu'on a demandé soi-même.
//
// P9 : c'est le CORPS de la page /scheduled, plus une section en bas de
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
 * (`/spaces/<id>`). Le parent n'a pas d'autre façon de dessiner ses runs.
 */
export function ScheduleRunList({ runs }: { runs: ScheduleGroup['runs'] }) {
  return (
    <ul className="border-t border-rule-2 bg-canvas/40 py-1">
      {runs.map((r) => (
        <li key={r.id}>
          <Link
            href={`/spaces/${r.id}`}
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

export default function ScheduledSection({ groups }: { groups: ScheduleGroup[] }) {
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
              {isOpen && <ScheduleRunList runs={g.runs} />}
            </div>
          );
        })}
      </div>
    </section>
  );
}
