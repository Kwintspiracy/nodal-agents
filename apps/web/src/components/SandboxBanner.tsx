/**
 * SandboxBanner — le bandeau PERMANENT du tableau de bord (#876, décision D2).
 *
 * Il parle tant que le bac à sable de cet espace est coupé, indisponible sur
 * cette machine, ou que son état n'a pas pu être lu ; il se tait seulement
 * quand le runner dit qu'il confine. Il ne se ferme pas : sa raison d'être est
 * qu'on ne puisse pas l'oublier. Le lien mène à la section Sandbox.
 *
 * Composant serveur, rendu dans la coquille du tableau de bord sous un
 * `<Suspense>` : un runner lent ne retient pas la page. Couper ou rallumer
 * l'interrupteur revalide la coquille (`setSandboxEnabledAction`).
 */

import Link from 'next/link';
import Banner from '@/components/ui/Banner';
import { getSandboxAction } from '@/lib/sandbox-actions.ts';
import { SANDBOX_SETTINGS_HREF, sandboxBannerWords } from '@/lib/sandbox-copy.ts';

export default async function SandboxBanner() {
  const result = await getSandboxAction();
  const words = sandboxBannerWords(result.ok ? result.data : null);
  if (words === null) return null;
  return (
    <div className="shrink-0 px-4 pt-3 lg:px-6" data-testid="sandbox-banner">
      <Banner
        variant="warn"
        role="status"
        action={
          <Link
            href={SANDBOX_SETTINGS_HREF}
            className="whitespace-nowrap text-medium-13 text-ink underline underline-offset-2"
          >
            Sandbox settings
          </Link>
        }
      >
        {words}
      </Banner>
    </div>
  );
}
