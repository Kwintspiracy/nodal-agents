'use client';

import { useRouter } from 'next/navigation';
import PrimaryButton from '@/components/ui/PrimaryButton';
import { ProductLogo, PRODUCT_NAME } from '@/components/ui/BrandMark';

/**
 * Shown when AUTH_MODE=local-trust — no real auth, just a friendly entry point.
 */
export default function LocalTrustBanner() {
  const router = useRouter();
  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          {/* LA MARQUE DU PRODUIT (#308), et plus une invite de terminal.
              Le `$ nodal-agents` disait « un outil en ligne de commande » sur
              la premiere page qu'une personne voit du produit ; le site et le
              rail montrent le colley sur le N, et c'est la meme porte. */}
          <div className="mb-6 inline-flex items-center gap-2">
            <ProductLogo size={28} priority />
            <span className="text-medium-15 tracking-[-0.005em] text-ink">{PRODUCT_NAME}</span>
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
