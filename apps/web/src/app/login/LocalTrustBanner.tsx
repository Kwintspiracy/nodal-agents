'use client';

import { useRouter } from 'next/navigation';
import PrimaryButton from '@/components/ui/PrimaryButton';

/**
 * Shown when AUTH_MODE=local-trust — no real auth, just a friendly entry point.
 */
export default function LocalTrustBanner() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="inline-flex items-center gap-1.5 mb-6">
            <span className="text-ok font-mono text-sm">$</span>
            <span className="text-sm font-mono font-bold text-ink tracking-tight">
              nodal-agents
            </span>
          </div>
          <h1 className="text-2xl font-bold text-ink tracking-tight">Local mode active</h1>
          <p className="text-sm text-ink-3 mt-1">No authentication required in local-trust mode.</p>
        </div>
        <div className="rounded-2xl border border-rule-2 bg-paper/60 p-6 space-y-4 text-center">
          <p className="text-xs text-ink-3">
            You are running Nodal-Agents in <code className="text-ok">local-trust</code> mode. Pick{' '}
            <code className="text-ok">LAN</code> at <code>nodal-agents init</code> to enable email +
            password authentication.
          </p>
          <PrimaryButton variant="agent" className="w-full" onClick={() => router.push('/')}>
            Enter dashboard
          </PrimaryButton>
        </div>
      </div>
    </div>
  );
}
