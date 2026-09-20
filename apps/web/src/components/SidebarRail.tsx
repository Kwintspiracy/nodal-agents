'use client';

// SidebarRail — la colonne de 72 px qui porte les destinations (#230, refondue
// en #258).
//
// Planche du propriétaire du 19/09/2026 au soir : Figma
// `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`, cinq cadres côte à côte. Le logo en
// haut, puis Work / Agents / Run / Approvals / Settings ; en bas, Logs, Help, le
// compte, et la version du produit.
//
// ⚠️ CE QUI A CHANGÉ DEPUIS #230 :
//
//   - APPROVALS ET SETTINGS OUVRENT UN PANNEAU. C'étaient deux cases qui
//     naviguaient vers une page en laissant le panneau montrer autre chose :
//     on se retrouvait dans les réglages avec le menu de Run sous les yeux.
//     Ce sont maintenant des destinations entières, et la case allumée et le
//     panneau montré redisent enfin la même chose.
//   - LOGS ARRIVE, et il NAVIGUE. Sa page est une liste ; il n'y a rien à
//     déplier dans une colonne de 300 px, et lui inventer un panneau aurait
//     fait un menu qui ne mène qu'à lui-même.
//   - HELP GARDE SA CARTE de trois liens (Docs, Discord, portail qualité). La
//     planche ne dessine que la CASE, jamais ce qu'elle ouvre : en faire un
//     raccourci vers la documentation seule aurait retiré deux adresses du
//     produit sans que la planche le demande (décision du propriétaire,
//     20/09/2026). Les trois vivent dans `RAIL_FOOT`, avec le reste du pied.
//   - LA VERSION DESCEND ICI, sous le compte. Elle fermait le panneau ; la
//     planche l'écrit au pied du rail, où elle est visible quelle que soit la
//     destination ouverte.
//
// Le fond du rail est le jeton `--c-rail`, UN CRAN plus foncé que celui du
// panneau : c'est ce qui fait deux colonnes plutôt qu'une colonne avec une
// marge, et c'est la SEULE chose qui les sépare.
//
// Le compte reste une carte lui aussi (`RailPopover`) : le rail ne peut pas
// porter en pleine largeur le bloc courriel + Sign out, et le supprimer
// retirerait une fonction du produit.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowSquareOut,
  ListMagnifyingGlass,
  Question,
  User,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import RailCell, { RailAvatarButton } from './ui/RailCell';
import RailPopover from './ui/RailPopover';
import VersionBadge from './VersionBadge';
import { DESTINATIONS, RAIL_FOOT, type DestinationKey } from './sidebar-nav.ts';

/** Quelle carte du bas du rail est ouverte. UNE seule à la fois. */
type Carte = 'help' | 'account' | null;

/** Une ligne de la carte « Help » : un lien qui QUITTE l'application. */
function HelpLink({
  href,
  label,
  icon: Icon,
}: {
  href: string;
  label: string;
  icon: PhosphorIcon;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-body-13 text-ink-2 hover:bg-hover"
    >
      <Icon size={14} className="h-3.5 w-3.5 shrink-0 text-ink-3" />
      <span className="flex-1 truncate">{label}</span>
      {/* La flèche dit qu'on QUITTE l'application, et elle ferme la ligne. */}
      <ArrowSquareOut
        size={12}
        weight="bold"
        data-testid="external-arrow"
        className="h-3 w-3 shrink-0 text-ink-4"
      />
    </a>
  );
}

export default function SidebarRail({
  activeKey,
  approvalsCount,
  runsInProgress,
  workConversationsInProgress,
  logsActive,
  userMenu,
  initiale = null,
}: {
  /** La destination que la route allume — `null` quand aucune ne l'est. */
  activeKey: DestinationKey | null;
  /** Combien de demandes attendent la personne. 0 = aucune pastille. */
  approvalsCount: number;
  /**
   * COMBIEN DE RUNS TOURNENT, tous canaux confondus — ce que la case Logs
   * montre (#300). 0 = aucun point.
   *
   * Passé par la barre, qui le lit dans `ChatFoldersProvider`, plutôt que lu
   * ici : le rail reste une vue, et un test le monte avec l'instantané qu'il
   * veut sans câbler un provider.
   */
  runsInProgress: number;
  /**
   * COMBIEN DE CONVERSATIONS DE LA SECTION WORK tournent — ce que la case Work
   * montre (#303). 0 = aucun point.
   */
  workConversationsInProgress: number;
  /** La route est-elle sous `/logs` ? Logs navigue, il n'a pas de panneau. */
  logsActive: boolean;
  /** Le bloc de compte rendu par le serveur — courriel et Sign out. */
  userMenu?: ReactNode;
  /**
   * L'INITIALE de la personne connectée, lue par le serveur. `null` quand il
   * n'y a personne à nommer — mode local sans compte, jeton d'API — et le rond
   * porte alors une silhouette plutôt qu'une lettre inventée (invariant #4).
   */
  initiale?: string | null;
}) {
  // Deux cartes ouvertes en même temps se recouvriraient au bas d'un rail de
  // 72 px : l'état en retient UNE.
  const [carte, setCarte] = useState<Carte>(null);
  const basculer = (quelle: Exclude<Carte, null>) =>
    setCarte((ouverte) => (ouverte === quelle ? null : quelle));
  const fermer = () => setCarte(null);

  // Le HAUT et le BAS se lisent dans la table, jamais réécrits ici : une case
  // qui changerait de groupe ne se déplacerait que dans `sidebar-nav`.
  const haut = DESTINATIONS.filter((d) => d.foot !== true);
  const bas = DESTINATIONS.filter((d) => d.foot === true);

  return (
    <nav
      aria-label="Sections"
      data-testid="sidebar-rail"
      // 4 px de retrait latéral : les cases font alors 64 px dans un rail de
      // 72, c'est-à-dire pleine largeur au sens de la planche.
      className="flex h-full w-[var(--rail-w)] shrink-0 flex-col items-center gap-1 bg-rail px-1 pt-3.5 pb-3"
    >
      {/* Le logo seul : « Nodal-Agents » ne tient pas dans 72 px. */}
      <Link
        href="/"
        title="Nodal-Agents"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ink font-mono text-legacy-12 font-semibold tracking-[0.04em] text-canvas"
      >
        N
      </Link>
      <div className="h-2 shrink-0" />

      {haut.map((d) => (
        <RailCell
          key={d.key}
          href={d.href}
          label={d.label}
          icon={d.icon}
          active={d.key === activeKey}
          // La pastille n'est que sur Approvals : c'est la seule case qui
          // compte quelque chose, et c'est le seul nombre de la barre qu'une
          // personne puisse faire tomber à zéro en répondant.
          pill={d.key === 'approvals' ? approvalsCount : undefined}
          // Le point ne bat que sur Work, et il compte des CONVERSATIONS :
          // c'est ce que cette destination liste (#303). Les autres cases du
          // haut ne montrent rien qui tourne — Agents montre ce qu'on monte,
          // Run ce qu'on programme, Approvals ce qui attend une réponse.
          running={
            d.key === 'work'
              ? { count: workConversationsInProgress, noun: 'conversation' as const }
              : undefined
          }
          testId={`rail-${d.key}`}
        />
      ))}

      <div className="flex-1" />

      {/* Logs NAVIGUE — il n'ouvre aucun panneau, et sa case s'allume comme
          n'importe quelle autre quand on est sur sa page. */}
      <RailCell
        href={RAIL_FOOT.logs.href}
        label={RAIL_FOOT.logs.label}
        icon={ListMagnifyingGlass}
        active={logsActive}
        // Le point de Logs compte des RUNS, et tous les runs : on y va pour
        // voir ce que la machine fait, d'où que la demande vienne (#300).
        running={{ count: runsInProgress, noun: 'run' as const }}
        testId="rail-logs"
      />

      {bas.map((d) => (
        <RailCell
          key={d.key}
          href={d.href}
          label={d.label}
          icon={d.icon}
          active={d.key === activeKey}
          testId={`rail-${d.key}`}
        />
      ))}

      {/* Help ouvre les trois endroits qui parlent DU PRODUIT, et qui sont
          tous dehors. La planche ne dessine que la case ; ce qu'elle ouvre
          reste ce que la 0.8.11 proposait déjà. */}
      <div className="relative shrink-0">
        <RailCell
          label="Help"
          icon={Question}
          onClick={() => basculer('help')}
          expanded={carte === 'help'}
          active={carte === 'help'}
          testId="rail-help"
        />
        {carte === 'help' && (
          <RailPopover label="Help" onClose={fermer}>
            {RAIL_FOOT.help.map((lien) => (
              <HelpLink key={lien.href} href={lien.href} label={lien.label} icon={lien.icon} />
            ))}
          </RailPopover>
        )}
      </div>

      {/* Le compte. L'initiale vient du SERVEUR quand il connaît la personne ;
          le rail retombe sur la silhouette quand il n'y a personne à nommer —
          une installation locale n'a parfois pas de compte du tout, et
          inventer une lettre afficherait un fait que rien ne vérifie. */}
      {userMenu !== undefined && (
        <div className="relative mt-1 shrink-0">
          <RailAvatarButton onClick={() => basculer('account')} expanded={carte === 'account'}>
            {initiale === null ? (
              <User weight="fill" className="h-3.5 w-3.5" />
            ) : (
              <span
                className="font-mono text-legacy-11 font-bold text-ink"
                data-testid="rail-initial"
              >
                {initiale}
              </span>
            )}
          </RailAvatarButton>
          {carte === 'account' && (
            <RailPopover label="Account" onClose={fermer}>
              <div data-testid="user-menu">{userMenu}</div>
            </RailPopover>
          )}
        </div>
      )}

      {/* La version, sous le compte : la planche l'écrit là, et elle y est
          visible quelle que soit la destination ouverte. */}
      <VersionBadge variant="rail" />
    </nav>
  );
}
