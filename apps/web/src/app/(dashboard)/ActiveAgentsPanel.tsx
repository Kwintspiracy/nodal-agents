'use client';

// ActiveAgentsPanel — live "agents at work" view on /stats.
//
// Polls `getActiveJobsByAgentAction` every POLL_INTERVAL_MS and renders
// one card per agent that currently has at least one in-flight job. The
// initial data comes from the server render so the panel hydrates with
// real content rather than flashing "Loading…".
//
// Cleanup: the interval is torn down on unmount and re-created if the
// poll interval changes. We don't visibility-throttle here — at 5s
// background tabs cost basically nothing and reactivity matters more
// than a few extra DB roundtrips when the user is monitoring activity.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { getActiveJobsByAgentAction, type ActiveAgentRow } from '@/lib/actions.ts';
import AgentAvatar from '@/components/ui/AgentAvatar';
import LiveDot from '@/components/ui/LiveDot';

const POLL_INTERVAL_MS = 5000;

interface Props {
  initial: ActiveAgentRow[];
}

export default function ActiveAgentsPanel({ initial }: Props) {
  const [rows, setRows] = useState<ActiveAgentRow[]>(initial);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await getActiveJobsByAgentAction();
      if (cancelled) return;
      if (r.ok) {
        setRows(r.data);
        setStale(false);
      } else {
        // Don't blow away the last good snapshot — flag it stale so the
        // user knows the live number might be a few seconds old.
        setStale(true);
      }
    };
    const id = setInterval(() => void tick(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-mono-11 uppercase tracking-[0.16em] text-ink-4">
          Agents at work
        </h2>
        <span className="inline-flex items-center gap-1.5 text-mono-11 text-ink-4">
          {stale ? (
            'reconnect…'
          ) : (
            <>
              <LiveDot variant="lime" size="sm" />
              live · {POLL_INTERVAL_MS / 1000}s
            </>
          )}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-rule-2 bg-paper px-5 py-6 text-center text-sm text-ink-3">
          All agents idle — no jobs in flight.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {rows.map((a) => (
            <AgentCard key={a.agentId} row={a} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentCard({ row }: { row: ActiveAgentRow }) {
  return (
    <Link
      href={`/jobs?agentId=${row.agentId}`}
      className="block rounded-2xl border border-rule-2 bg-paper px-4 py-3 transition-colors hover:border-ink-4"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2.5">
          <AgentAvatar name={row.agentName} imageUrl={row.avatarUrl} size="lg" shape="round" />
          <div className="min-w-0">
            <p className="truncate text-title-15 leading-[1.2]! text-ink">
              {row.agentName}
            </p>
            <p className="truncate text-mono-12 text-ink-4">{row.agentSlug}</p>
          </div>
        </div>
        <span className="shrink-0 font-mono text-legacy-24 font-semibold leading-none! tracking-[-0.02em] text-ink tabular-nums">
          {row.total}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-body-12">
        {row.processing > 0 && (
          <span className="text-run">
            <span className="font-mono tabular-nums">{row.processing}</span> running
          </span>
        )}
        {row.awaiting > 0 && (
          <span className="text-warn">
            <span className="font-mono tabular-nums">{row.awaiting}</span> awaiting
          </span>
        )}
        {row.pending > 0 && (
          <span className="text-ink-3">
            <span className="font-mono tabular-nums">{row.pending}</span> pending
          </span>
        )}
      </div>
    </Link>
  );
}
