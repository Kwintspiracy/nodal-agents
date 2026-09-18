'use client';

import { Fragment, Suspense, useEffect, useState, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import {
  House,
  Tray,
  CardsThree,
  CalendarCheck,
  Sparkle,
  UsersThree,
  BookOpenText,
  BookOpen,
  Lightbulb,
  Plug,
  PlugsConnected,
  Key,
  Brain,
  ClockCountdown,
  ShieldCheck,
  ListMagnifyingGlass,
  GearSix,
  List,
  X,
  ArrowSquareOut,
  DiscordLogo,
  SealCheck,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import IconButton from './ui/IconButton';
import BrandMark from './ui/BrandMark';
import SidebarSection from './ui/SidebarSection';
import SidebarCaret from './ui/SidebarCaret';
import SidebarLink from './ui/SidebarLink';
import LiveCard from './ui/LiveCard';
import VersionBadge from './VersionBadge';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import ThemeToggle from './ui/ThemeToggle';
import NotificationsBell from './NotificationsBell';
import { useApprovals } from './ApprovalsProvider';
import { useChatFolders } from './ChatFoldersProvider';
import ChatFolderGroup from './ChatFolderGroup';
import { chatWaitingTotal } from '@/lib/chat-folders.ts';
import type { WorkspaceRow } from '@/lib/actions';

type Item = {
  href: string;
  label: string;
  icon?: PhosphorIcon;
  dot?: 'agent' | 'skill' | 'conn';
  count?: number | string;
  /** External link — rendered as a plain <a> (new tab) with its own styling. */
  external?: boolean;
  /** Brand-specific external styling. 'discord' → the blurple button; a plain
   *  external link (e.g. Documentation) renders like a normal SidebarLink row. */
  brand?: 'discord';
};

type Group = { section?: string; items: Item[] };

/**
 * Nav structure — reconciles the design bundle's 4-section organization
 * with the routes that actually exist in `app/(dashboard)/`.
 *
 * Anything in the existing tool stays in the sidebar even if the design
 * bundle dropped it (Credentials, Billing) — per the design-system rule
 * "respect existing functionalities". The design's reorganization that
 * IS applied: 4 named sections (Overview/Build/Operate/Workspace) and
 * the coloured dot beside Agents/Skills/Connectors links.
 */
const NAV: Group[] = [
  {
    section: 'Overview',
    items: [
      { href: '/', label: 'Dashboard', icon: House },
      // Un BAC, pas une bulle (Quentin, 19/09/2026). « Channels » est le
      // dessus du casier : ce qui arrive, tous canaux confondus. La bulle
      // appartient au dossier « Nodal chats » juste en dessous, et les deux
      // portaient la même icône — la ligne parente et son premier enfant
      // étaient indiscernables.
      { href: '/chat', label: 'Channels', icon: Tray },
      // PAS d'entrée « Code » (Quentin, 19/09/2026). Les pages `/code` et
      // `/code/[id]` restent en place et restent atteignables — la page d'un
      // run y mène, le dossier MCP aussi. Ce qui disparaît est la DESTINATION
      // dans le rail : leur fusion dans Workspaces est l'issue #143, et
      // jusque-là le menu ne propose pas deux portes vers le même endroit.
      // « Workspaces », pas « Spaces » (Quentin, 18/09/2026). La ROUTE ne
      // bouge pas : `/spaces` est dans les favoris et dans les liens déjà
      // envoyés, et un libellé n'a jamais besoin de casser une URL.
      { href: '/spaces', label: 'Workspaces', icon: CardsThree },
      { href: '/scheduled', label: 'Scheduled', icon: CalendarCheck },
    ],
  },
  {
    section: 'Build',
    items: [
      { href: '/agents', label: 'Agents', icon: UsersThree, dot: 'agent' },
      { href: '/skills', label: 'Skills', icon: BookOpenText, dot: 'skill' },
      { href: '/learned-skills', label: 'Learned Skills', icon: Lightbulb },
      { href: '/connectors', label: 'API Connectors', icon: Plug, dot: 'conn' },
      { href: '/mcp', label: 'MCP Connectors', icon: PlugsConnected, dot: 'conn' },
      { href: '/credentials', label: 'Credentials', icon: Key },
      { href: '/memories', label: 'Memory', icon: Brain },
    ],
  },
  {
    // « Operate » = ce qu'on règle et ce qu'on surveille une fois l'équipe
    // montée. Le fournisseur de modèles OUVRE le groupe (Quentin,
    // 18/09/2026) : sans lui rien ne tourne, et c'est la première chose qu'on
    // vient y régler. Settings le FERME — il était seul dans un groupe de
    // liens externes, où rien ne le rattachait au produit.
    section: 'Operate',
    items: [
      { href: '/llm-providers', label: 'LLM Providers', icon: Sparkle },
      { href: '/automations', label: 'Automations & Webhooks', icon: ClockCountdown },
      { href: '/approvals', label: 'Approvals', icon: ShieldCheck },
      { href: '/logs', label: 'Logs', icon: ListMagnifyingGlass },
      { href: '/settings', label: 'Settings', icon: GearSix },
    ],
  },
  {
    // « About Nodal-Agents » : les trois endroits qui parlent DU PRODUIT, et
    // qui sont tous dehors. Le groupe s'appelait « Workspace », ce qui le
    // confondait avec l'espace de travail que le sélecteur du haut change.
    section: 'About Nodal-Agents',
    items: [
      {
        href: 'https://discord.gg/7UZsvZPgU',
        label: 'Join Discord',
        icon: DiscordLogo,
        external: true,
        brand: 'discord',
      },
      {
        href: 'https://kwintspiracy.github.io/nodal-agents/',
        label: 'Documentation',
        icon: BookOpen,
        external: true,
      },
      {
        // Le portail de suivi PUBLIC, publié par `.github/workflows/docs.yml`
        // sous `/qa/` du même site que la documentation. Rien de secret n'y
        // est : ce sont les capacités du produit et l'état de leurs preuves.
        href: 'https://kwintspiracy.github.io/nodal-agents/qa/',
        label: 'Quality board',
        icon: SealCheck,
        external: true,
      },
    ],
  },
];

/** Dashboard matches exactly; every other route is active on prefix match. */
function isItemActive(href: string, pathname: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(href + '/');
}

/**
 * Où se retient le repli du groupe Channels.
 *
 * Dans le navigateur de la personne, et nulle part ailleurs : c'est une
 * préférence d'affichage, elle n'a rien à faire en base et rien à dire à un
 * autre appareil. Même clé de réglage que le thème (`nodal.*`).
 */
const CHANNELS_OPEN_KEY = 'nodal.sidebar.channels';

/**
 * Le groupe Channels est-il déplié ? OUVERT par défaut — c'est l'état
 * d'aujourd'hui, et un menu qui se replie tout seul au premier chargement
 * ferait disparaître les dossiers sans que personne ne l'ait demandé.
 *
 * Toute lecture de `localStorage` peut jeter (navigation privée, données de
 * site bloquées) : elle se dégrade en « ouvert », jamais en écran vide.
 */
function readChannelsOpen(): boolean {
  try {
    return localStorage.getItem(CHANNELS_OPEN_KEY) !== 'closed';
  } catch {
    return true;
  }
}

export default function Sidebar({
  workspaces,
  userMenu,
}: {
  workspaces?: WorkspaceRow[];
  userMenu?: ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const { pending } = useApprovals();
  const pendingCount = pending.length;
  // Le compte du lien « Chat » : la somme, à la lettre, des pastilles des
  // dossiers rendus juste en dessous (#135). Il se calcule ici et non dans le
  // groupe parce que la ligne « Chat » appartient à la boucle de NAV — mais
  // avec la MÊME fonction, sur les mêmes entrées.
  const { channels, running, externalRuns } = useChatFolders();
  const chatWaiting = chatWaitingTotal({ channels, waiting: pending, running, externalRuns });

  // Le repli du groupe Channels. Le serveur rend l'état par défaut (ouvert) ;
  // le vrai se lit au montage, comme `ThemeToggle` lit le thème posé par le
  // script d'amorçage — sinon le premier rendu du client contredirait le HTML
  // reçu et React s'en plaindrait.
  const [channelsOpen, setChannelsOpen] = useState(true);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setChannelsOpen(readChannelsOpen());
  }, []);

  const toggleChannels = () => {
    const next = !channelsOpen;
    setChannelsOpen(next);
    try {
      localStorage.setItem(CHANNELS_OPEN_KEY, next ? 'open' : 'closed');
    } catch {
      // Stockage bloqué : le repli vaut pour cette page, et rien de plus.
    }
  };

  // Close mobile menu on route change.
  useEffect(() => {
    queueMicrotask(() => setOpen(false));
  }, [pathname]);

  // While the full-screen mobile menu is open, lock body scroll and let Escape
  // dismiss it — standard dialog etiquette so the page behind doesn't move and
  // keyboard users can always back out. No-op on desktop (menu never "opens").
  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener('keydown', onKey);
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
            • Mobile (≤lg): a FULL-SCREEN menu. A 220px drawer wastes a phone's
              width, so the menu owns the whole viewport with roomy, thumb-sized
              rows. Slides in from the left; `-translate-x-full` parks it off-screen.
            • Desktop (lg+): the classic fixed rail, always visible, cut from
              `--sidebar-w` (app/globals.css) — the SAME value the main pane
              keeps as its gutter. 244px until 2026-09-18, 300px since.
          Keeping a single tree means NAV and the user/sign-out block render once
          (no duplicate routes, no duplicate test ids). */}
      <aside
        id="primary-nav"
        aria-label="Main navigation"
        className={`fixed top-0 left-0 z-50 flex h-full h-[100dvh] w-full flex-col border-r border-rule-2 bg-sidebar pt-4 pb-3 transition-transform duration-200 ease-out lg:z-40 lg:w-[var(--sidebar-w)] lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        {/* Mobile: brand + close share one centred row, so the ✕ sits in the
            top-right corner perfectly level with the "Nodal-Agents" wordmark. */}
        <div className="flex items-center justify-between px-4 pb-1 lg:hidden">
          <div className="flex min-w-0 items-center gap-2 text-legacy-16 font-medium tracking-[-0.005em] text-ink">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-ink font-mono text-legacy-12 font-semibold text-canvas">
              N
            </span>
            <span className="truncate">Nodal-Agents</span>
          </div>
          <IconButton
            ghost
            onClick={() => setOpen(false)}
            className="-mr-2 h-10 w-10 rounded-xl hover:bg-hover active:bg-hover"
            aria-label="Close menu"
          >
            <X size={24} />
          </IconButton>
        </div>

        {/* Desktop: the standard brand block (close button collapses away). */}
        <div className="hidden lg:block">
          <BrandMark />
        </div>

        <WorkspaceSwitcher workspaces={workspaces ?? []} />

        <nav className="flex flex-1 flex-col overflow-y-auto py-1.5">
          {NAV.map((group, gi) => (
            // Le groupe se DÉSIGNE : l'ordre de ses entrées est une décision
            // produit (LLM Providers en tête d'« Operate », Settings en
            // queue), et un test qui le lit doit pouvoir nommer le groupe
            // plutôt que compter des lignes depuis le haut de la barre.
            <div key={gi} data-testid={group.section ? `nav-group-${group.section}` : undefined}>
              {group.section && <SidebarSection>{group.section}</SidebarSection>}
              {group.items.map((it) => (
                <Fragment key={it.href}>
                  {/* UNE seule forme de ligne pour tout le rail (19/09/2026).
                      Interne, externe ou marquée Discord, avec chevron ou
                      sans : c'est le même `SidebarLink`, donc le même
                      `SidebarRow` dessous — mêmes marges, même hauteur, même
                      rayon, même fond de survol, même fond actif. Ce qui
                      change d'une ligne à l'autre tient en trois props : la
                      teinte de marque, ce qui ferme la ligne à droite, et le
                      chevron.

                      « Channels » est la seule entrée à porter un chevron :
                      c'est la seule qui ouvre un groupe sous elle. Cliquer son
                      nom mène toujours à /chat ; le chevron, lui, ne navigue
                      pas — c'est un bouton, frère du lien DANS la ligne, si
                      bien que le survol éclaire la ligne entière, zone du
                      chevron comprise. */}
                  <SidebarLink
                    href={it.href}
                    label={it.label}
                    external={it.external === true}
                    // Discord garde son bleu — une COULEUR, pas une forme.
                    tint={
                      it.brand === 'discord'
                        ? 'bg-[#5865F2] text-white hover:brightness-110'
                        : undefined
                    }
                    icon={
                      it.icon ? (
                        <it.icon
                          size={20}
                          // Le logo de marque se remplit ; les icônes de
                          // l'interface restent au trait, comme partout.
                          {...(it.brand === 'discord' ? { weight: 'fill' as const } : {})}
                          className="h-5 w-5 lg:h-3.5 lg:w-3.5"
                        />
                      ) : undefined
                    }
                    // La flèche dit qu'on QUITTE l'application, et elle ferme
                    // la ligne — sur Documentation, sur le portail qualité et
                    // sur Discord, à l'identique.
                    trailing={
                      it.external === true ? (
                        <ArrowSquareOut
                          size={14}
                          weight="bold"
                          data-testid="external-arrow"
                          className={`h-3.5 w-3.5 shrink-0 lg:h-3 lg:w-3 ${
                            it.brand === 'discord' ? 'text-white/70' : 'text-ink-4'
                          }`}
                        />
                      ) : undefined
                    }
                    dot={it.dot}
                    count={
                      it.href === '/approvals'
                        ? undefined
                        : it.href === '/chat'
                          ? chatWaiting > 0
                            ? chatWaiting
                            : undefined
                          : it.count
                    }
                    pill={it.href === '/approvals' && pendingCount > 0 ? pendingCount : undefined}
                    isActive={it.external === true ? false : isItemActive(it.href, pathname)}
                    caret={
                      it.href === '/chat' ? (
                        <SidebarCaret
                          open={channelsOpen}
                          onToggle={toggleChannels}
                          label={it.label}
                          testId="channels-caret"
                        />
                      ) : undefined
                    }
                  />
                  {/* Les dossiers de Chat, JUSTE sous leur lien — dans le même
                      arbre, donc desktop et mobile à la fois. Sous <Suspense> :
                      le groupe lit `useSearchParams`, et sans frontière Next
                      fait attendre toute la barre.

                      Replié, ils ne sont pas rendus du tout : les laisser en
                      place avec `hidden` garderait leurs lignes dans l'ordre de
                      tabulation, sous un chevron qui dit qu'il n'y a rien. */}
                  {it.href === '/chat' && channelsOpen && (
                    <Suspense fallback={null}>
                      <ChatFolderGroup />
                    </Suspense>
                  )}
                </Fragment>
              ))}
            </div>
          ))}
        </nav>

        {/* Version + update nudge — sits right after the nav (Settings is the
            last item). Shows the running version; surfaces an update badge when
            npm has a newer one. */}
        <VersionBadge />

        {/* Live card slot — hidden until we wire real telemetry, but the
            primitive is in place for Phase 2 / 3 to switch on. */}
        <LiveCard runningAgents={undefined} />

        {userMenu && (
          <div className="mt-2 border-t border-rule-2 px-3 pt-3" data-testid="user-menu">
            {userMenu}
          </div>
        )}
      </aside>
    </>
  );
}
