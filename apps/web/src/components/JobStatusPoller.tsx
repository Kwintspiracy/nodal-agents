'use client';

import { useEffect, useState } from 'react';
import { getJobStatusAction } from '@/lib/actions.ts';
import StatusBadge from './StatusBadge.tsx';

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL = 3000;

type JobStatus = {
  status: string;
  result: string | null;
  error: string | null;
};

export default function JobStatusPoller({
  jobId,
  initialStatus,
}: {
  jobId: string;
  initialStatus: string;
}) {
  const [state, setState] = useState<JobStatus>({
    status: initialStatus,
    result: null,
    error: null,
  });

  useEffect(() => {
    if (TERMINAL.has(state.status)) return;

    const tick = async () => {
      const res = await getJobStatusAction(jobId);
      if (res.ok) setState(res.data);
    };

    const id = setInterval(() => {
      void tick();
    }, POLL_INTERVAL);
    return () => clearInterval(id);
  }, [jobId, state.status]);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <StatusBadge status={state.status} />
        {!TERMINAL.has(state.status) && (
          <span className="text-xs text-ink-4 animate-pulse">Polling…</span>
        )}
      </div>

      {state.result && (
        <div>
          <p className="text-xs text-ink-3 font-semibold uppercase tracking-wider mb-1">
            Result
          </p>
          <pre className="text-sm text-ink-2 whitespace-pre-wrap bg-paper rounded-lg p-4 border border-rule-2 max-h-80 overflow-auto">
            {state.result}
          </pre>
        </div>
      )}

      {state.error && (
        <div>
          <p className="text-xs text-err font-semibold uppercase tracking-wider mb-1">Error</p>
          <pre className="text-sm text-err whitespace-pre-wrap bg-warn-bg rounded-lg p-4 border border-err/30">
            {state.error}
          </pre>
        </div>
      )}
    </div>
  );
}
