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
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-xs font-semibold text-neutral-400 uppercase tracking-wider">
          Agents at work
        </h2>
        <span className="text-[10px] text-neutral-600">
          {stale ? (
            'reconnect…'
          ) : (
            <span className="animate-pulse">live · {POLL_INTERVAL_MS / 1000}s</span>
          )}
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="bg-neutral-900 border border-neutral-800/60 rounded-xl px-5 py-6 text-sm text-neutral-500 text-center">
          All agents idle — no jobs in flight.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
      className="bg-neutral-900 border border-neutral-800/60 hover:border-neutral-700 rounded-xl px-4 py-3 transition-colors block"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          {row.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={row.avatarUrl}
              alt=""
              width={36}
              height={36}
              className="w-9 h-9 rounded-full object-cover border border-neutral-800 shrink-0"
            />
          ) : (
            <div className="w-9 h-9 rounded-full bg-neutral-800 text-neutral-400 text-xs font-semibold flex items-center justify-center shrink-0">
              {row.agentName.charAt(0).toUpperCase()}
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-white truncate">{row.agentName}</p>
            <p className="text-[11px] text-neutral-500 font-mono truncate">{row.agentSlug}</p>
          </div>
        </div>
        <span className="shrink-0 text-2xl font-bold text-white tabular-nums">{row.total}</span>
      </div>
      <div className="mt-2 flex items-center gap-3 text-[11px]">
        {row.processing > 0 && (
          <span className="text-blue-400">
            <span className="font-mono tabular-nums">{row.processing}</span> running
          </span>
        )}
        {row.awaiting > 0 && (
          <span className="text-amber-400">
            <span className="font-mono tabular-nums">{row.awaiting}</span> awaiting
          </span>
        )}
        {row.pending > 0 && (
          <span className="text-neutral-400">
            <span className="font-mono tabular-nums">{row.pending}</span> pending
          </span>
        )}
      </div>
    </Link>
  );
}
