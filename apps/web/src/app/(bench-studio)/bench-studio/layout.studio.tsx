// Bench Studio — l'outil LOCAL du propriétaire pour le banc d'essai.
//
// Ce fichier n'est une route qu'en mode studio (apps/web/next.config.ts), et
// chaque page refuse de servir hors du filtre de `pnpm bench:studio`
// (lib/bench-studio/guard.ts) : hors de là, Bench Studio n'existe pas.
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import ThemedToaster from '@/components/ui/ThemedToaster';
import { assertStudioPage } from '@/lib/bench-studio/server';
import StudioNav from './_components/StudioNav';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Bench Studio' };

export default async function BenchStudioLayout({ children }: { children: ReactNode }) {
  await assertStudioPage();
  return (
    <div className="min-h-screen bg-canvas">
      <StudioNav />
      <main>{children}</main>
      <ThemedToaster />
    </div>
  );
}
