'use client';

// SidebarRail — la colonne de 72 px qui porte les destinations (#230, refondue
// en #258).
//
// Planche du propriétaire du 19/09/2026 au soir : Figma
// `WPLtjoJjXJBEqDyCpLy9xc`, nœud `25:1062`, cinq cadres côte à côte. Le logo en
// haut, puis Work / Agents / Run / Approvals ; en bas, Logs, Settings, Help, le
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
//   - HELP OUVRE LA DOCUMENTATION, directement. Il ouvrait une carte de trois
//     liens en #230 ; la planche v2 en fait une case comme les autres, et
//     l'adresse est celle que l'application utilise déjà.
//   - LA VERSION DESCEND ICI, sous le compte. Elle fermait le panneau ; la
//     planche l'écrit au pied du rail, où elle est visible quelle que soit la
//     destination ouverte.
//
// Le fond du rail est le jeton `--c-rail`, UN CRAN plus foncé que celui du
// panneau : c'est ce qui fait deux colonnes plutôt qu'une colonne avec une
// marge, et c'est la SEULE chose qui les sépare.
//
// Le compte reste une carte (`RailPopover`) : le rail ne peut pas porter en
// pleine largeur le bloc courriel + Sign out, et le supprimer retirerait une
// fonction du produit.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ListMagnifyingGlass, Question, User } from '@phosphor-icons/react';
import RailCell, { RailAvatarButton } from './ui/RailCell';
import RailPopover from './ui/RailPopover';
import VersionBadge from './VersionBadge';
import { DESTINATIONS, RAIL_FOOT, type DestinationKey } from './sidebar-nav.ts';

export default function SidebarRail({
  activeKey,
  approvalsCount,
  logsActive,
  userMenu,
  initiale = null,
}: {
  /** La destination que la route allume — `null` quand aucune ne l'est. */
  activeKey: DestinationKey | null;
  /** Combien de demandes attendent la personne. 0 = aucune pastille. */
  approvalsCount: number;
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
  // La carte du compte. Une seule chose s'ouvre au bas du rail depuis que Help
  // navigue : elle tient donc dans un booléen.
  const [compte, setCompte] = useState(false);

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

      {/* Help QUITTE l'application : la documentation est dehors. C'est donc
          un lien en cible neuve, et pas un lien de routeur. */}
      <RailCell href={RAIL_FOOT.docs} external label="Help" icon={Question} testId="rail-help" />

      {/* Le compte. L'initiale vient du SERVEUR quand il connaît la personne ;
          le rail retombe sur la silhouette quand il n'y a personne à nommer —
          une installation locale n'a parfois pas de compte du tout, et
          inventer une lettre afficherait un fait que rien ne vérifie. */}
      {userMenu !== undefined && (
        <div className="relative mt-1 shrink-0">
          <RailAvatarButton onClick={() => setCompte((o) => !o)} expanded={compte}>
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
          {compte && (
            <RailPopover label="Account" onClose={() => setCompte(false)}>
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
