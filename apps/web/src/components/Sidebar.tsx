'use client';

// Sidebar — LA barre latérale : un RAIL et un PANNEAU (#230, 19/09/2026).
//
// Décision du propriétaire sur les propositions de barre latérale (planche
// Figma « Sidebar propositions · 4a 3b 3c », GWXBALe90DMFR3XYGccofJ) : la
// proposition 4a remplace la colonne unique de 300 px livrée en 0.8.11 (#206).
// Un rail de 72 px porte trois destinations — Talk, Build, Run — et un panneau
// de 226 px montre celle qui est active.
//
// Ce fichier ne porte plus que la COQUILLE : le rail est dans `SidebarRail`, le
// panneau dans `SidebarPanel`, et la table des destinations dans `sidebar-nav`.
// Ce qui reste ici est ce qu'aucun des deux ne peut savoir seul : quelle
// destination la route allume, et comment les deux colonnes se comportent sur
// un téléphone.
//
// ⚠️ LE CONTENU N'A PAS CHANGÉ. Ce sont les MÊMES entrées qu'en 0.8.11,
// réparties en trois panneaux — l'issue dit en toutes lettres que rien n'est
// ajouté ni retiré. Les deux endroits où la répartition a demandé un arbitrage
// (« Scheduled », les liens externes) sont commentés là où ils vivent :
// `sidebar-nav.ts` et `SidebarRail.tsx`.

import { useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { useLayer } from '@/lib/layers.ts';
import { List, X } from '@phosphor-icons/react';
import IconButton from './ui/IconButton';
import SidebarRail from './SidebarRail';
import SidebarPanel from './SidebarPanel';
import ThemeToggle from './ui/ThemeToggle';
import NotificationsBell from './NotificationsBell';
import { useApprovals } from './ApprovalsProvider';
import { destinationForPath, matchedDestination } from './sidebar-nav.ts';
import type { WorkspaceRow } from '@/lib/actions';

export default function Sidebar({
  workspaces,
  userMenu,
  initiale,
}: {
  workspaces?: WorkspaceRow[];
  userMenu?: ReactNode;
  /** L'initiale du compte, lue par le serveur. `null` = personne à nommer. */
  initiale?: string | null;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { pending } = useApprovals();

  // La destination se DÉDUIT de la route, et de rien d'autre : aucun état,
  // aucune mémoire. Deux onglets ouverts sur la même adresse montrent le même
  // panneau, et un lien partagé ouvre ce qu'il promet.
  //
  // La case ALLUMÉE du rail et le PANNEAU montré ne sont pas la même chose :
  // sur `/settings`, aucune des trois n'est la page courante, et le panneau
  // montre quand même quelque chose (Run, le repli). Les confondre faisait dire
  // à la case Run qu'on était sur sa page alors qu'on était dans les réglages.
  const active = matchedDestination(pathname);
  const destination = destinationForPath(pathname);
  const settingsActive = pathname === '/settings' || pathname.startsWith('/settings/');
  // Approvals n'est pas une destination : sa case s'allume sur sa page, et le
  // panneau montre alors le repli, comme sur `/settings`.
  const approvalsActive = pathname === '/approvals' || pathname.startsWith('/approvals/');

  // Close mobile menu on route change.
  useEffect(() => {
    queueMicrotask(() => setOpen(false));
  }, [pathname]);

  // While the full-screen mobile menu is open, lock body scroll and let Escape
  // dismiss it — standard dialog etiquette so the page behind doesn't move and
  // keyboard users can always back out. No-op on desktop (menu never "opens").
  // Échap va au calque ouvert le plus intérieur (`@/lib/layers.ts`).
  useLayer(open, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {/* Mobile header bar (lg and below) — the single mobile nav strip:
          hamburger (opens the full-screen menu) + brand on the left, the global
          actions (notifications, theme) on the right. The desktop <Topbar> is
          hidden on mobile so there is exactly ONE bar, not two stacked ones. */}
      <header className="fixed top-0 right-0 left-0 z-40 flex h-16 items-center gap-1 border-b border-rule-2 bg-sidebar px-2 lg:hidden">
        <IconButton
          ghost
          onClick={() => setOpen(true)}
          className="h-12 w-12 rounded-xl hover:bg-hover active:bg-hover"
          aria-label="Open menu"
          aria-controls="primary-nav"
          aria-expanded={open}
        >
          <List size={26} />
        </IconButton>
        <div className="flex min-w-0 items-center gap-2 pl-1 text-medium-15 tracking-[-0.005em] text-ink">
          <span className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md bg-ink font-mono text-label-11 text-canvas">
            N
          </span>
          <span className="truncate">Nodal-Agents</span>
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <NotificationsBell />
          <ThemeToggle />
        </div>
      </header>

      {/* One shell for both form factors:
            • Mobile (≤lg): a FULL-SCREEN menu. Le rail garde ses 72 px — c'est
              ce qui permet de changer de destination sans refermer le menu —
              et le panneau prend tout le reste de la largeur, au lieu des
              226 px du bureau.
            • Desktop (lg+): les deux colonnes fixes, toujours visibles, taillées
              dans `--sidebar-w` (app/globals.css) — la MÊME mesure que la zone
              de contenu garde en gouttière, et qui vaut désormais
              `--rail-w + --panel-w`.
          Un seul arbre pour les deux : le rail, le panneau et le bloc de compte
          ne sont rendus qu'une fois — pas de route en double, pas de
          `data-testid` en double. */}
      <aside
        id="primary-nav"
        aria-label="Main navigation"
        className={`fixed top-0 left-0 z-50 flex h-full h-[100dvh] w-full transition-transform duration-200 ease-out lg:z-40 lg:w-[var(--sidebar-w)] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarRail
          activeKey={active?.key ?? null}
          settingsActive={settingsActive}
          approvalsActive={approvalsActive}
          approvalsCount={pending.length}
          userMenu={userMenu}
          initiale={initiale ?? null}
        />

        <div className="flex min-w-0 flex-1 flex-col border-r border-rule-2 bg-sidebar">
          {/* Mobile : la croix qui referme le menu. Elle se pose au-dessus du
              panneau et disparaît sur le bureau, où le menu ne s'ouvre ni ne se
              ferme. */}
          <div className="flex justify-end px-2 pt-2 lg:hidden">
            <IconButton
              ghost
              onClick={() => setOpen(false)}
              className="h-10 w-10 rounded-xl hover:bg-hover active:bg-hover"
              aria-label="Close menu"
            >
              <X size={24} />
            </IconButton>
          </div>

          <SidebarPanel
            destination={destination}
            pathname={pathname}
            workspaces={workspaces ?? []}
          />
        </div>
      </aside>
    </>
  );
}
