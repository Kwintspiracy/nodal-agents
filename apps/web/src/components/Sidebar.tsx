'use client';

// Sidebar — LA barre latérale : un RAIL et un PANNEAU (#230, refondue en #258).
//
// Le propriétaire a redessiné la barre le 19/09/2026 au soir : Figma
// `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`, cinq planches côte à côte. Un rail
// de 72 px porte CINQ destinations — Work, Agents, Scheduled, Approvals,
// Settings — et un panneau de 300 px montre celle qui est active.
//
// Ce fichier ne porte que la COQUILLE : le rail est dans `SidebarRail`, le
// panneau dans `SidebarPanel`, et la table des destinations dans `sidebar-nav`.
// Ce qui reste ici est ce qu'aucun des deux ne peut savoir seul : quelle
// destination la route allume, et comment les deux colonnes se comportent sur
// un téléphone.
//
// ⚠️ APPROVALS ET SETTINGS NE SONT PLUS DES EXCEPTIONS. En #230 c'étaient deux
// cases qui naviguaient sans ouvrir de panneau, et ce fichier portait donc deux
// drapeaux à part pour les allumer. Elles sont maintenant des destinations
// entières : la case allumée et le panneau montré redisent la même chose, et
// les deux drapeaux ont disparu. Il n'en reste qu'un, pour Logs — la seule case
// du rail qui navigue sans rien ouvrir.

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
import { useChatFolders } from './ChatFoldersProvider';
import { ProductLogo, PRODUCT_NAME } from './ui/BrandMark';
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
  // CE QUI TOURNE, lu là où le menu le lit déjà (#300, #303). Aucune requête
  // de plus : `ChatFoldersProvider` sonde toutes les 15 s pour les dossiers, et
  // ces deux chiffres viennent de la même lecture. Un second appel donnerait
  // deux vérités sur le même fait, et elles se contrediraient entre deux tours.
  const { workConversationsInProgress } = useChatFolders();

  // La destination se DÉDUIT de la route, et de rien d'autre : aucun état,
  // aucune mémoire. Deux onglets ouverts sur la même adresse montrent le même
  // panneau, et un lien partagé ouvre ce qu'il promet.
  //
  // La case ALLUMÉE du rail et le PANNEAU montré restent deux choses : sur
  // `/logs`, aucune destination n'est la page courante, et le panneau montre
  // quand même quelque chose (Work, le repli). Les confondre faisait dire à
  // une case qu'on était sur sa page alors qu'on était ailleurs.
  const active = matchedDestination(pathname);
  const destination = destinationForPath(pathname);
  // Logs NAVIGUE et n'ouvre aucun panneau : sa case est la seule du rail que la
  // table des destinations ne peut pas allumer.
  const logsActive = pathname === '/logs' || pathname.startsWith('/logs/');

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
        {/* La MEME marque que le rail, en plus petit (#308) : la barre mobile
            remplace le rail sur un telephone, et deux dessins differents pour
            le meme produit se voient d'un ecran a l'autre. */}
        <div className="flex min-w-0 items-center gap-2 pl-1 text-medium-15 tracking-[-0.005em] text-ink">
          <ProductLogo size={22} />
          <span className="truncate">{PRODUCT_NAME}</span>
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
              300 px du bureau.
            • Desktop (lg+): les deux colonnes fixes, toujours visibles, taillées
              dans `--sidebar-w` (app/globals.css) — la MÊME mesure que la zone
              de contenu garde en gouttière, et qui vaut `--rail-w + --panel-w`.
          Un seul arbre pour les deux : le rail, le panneau et le bloc de compte
          ne sont rendus qu'une fois — pas de route en double, pas de
          `data-testid` en double. */}
      <aside
        id="primary-nav"
        aria-label="Main navigation"
        className={`fixed inset-y-0 left-0 z-50 flex w-full transition-transform duration-200 ease-out lg:z-40 lg:w-[var(--sidebar-w)] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <SidebarRail
          activeKey={active?.key ?? null}
          approvalsCount={pending.length}
          workConversationsInProgress={workConversationsInProgress}
          logsActive={logsActive}
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
