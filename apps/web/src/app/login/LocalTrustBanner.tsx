'use client';

import { useRouter } from 'next/navigation';

/**
 * Shown when AUTH_MODE=local-trust — no real auth, just a friendly entry point.
 */
export default function LocalTrustBanner() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-1.5 mb-6">
            <span className="text-emerald-500 font-mono text-sm">$</span>
            <span className="text-sm font-mono font-bold text-white tracking-tight">nodal-agents</span>
          </div>
          <h1 className="text-2xl font-bold text-white tracking-tight">Local mode active</h1>
          <p className="text-sm text-neutral-500 mt-1">
            No authentication required in local-trust mode.
          </p>
        </div>
        <div className="rounded-2xl border border-neutral-800/50 bg-neutral-900/50 p-6 space-y-4 text-center">
          <p className="text-xs text-neutral-400">
            You are running Nodal-Agents in <code className="text-emerald-400">local-trust</code> mode.
            Pick <code className="text-emerald-400">LAN</code> at <code>nodal-agents init</code> to
            enable email + password authentication.
          </p>
          <button
            type="button"
            onClick={() => router.push('/stats')}
            className="w-full rounded-lg bg-emerald-500 text-black py-2.5 text-sm font-semibold hover:bg-emerald-400 transition-colors"
          >
            Enter dashboard
          </button>
        </div>
      </div>
    </div>
  );
}
