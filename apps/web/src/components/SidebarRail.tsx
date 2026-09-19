'use client';

// SidebarRail — la colonne de 72 px qui porte les trois destinations (#230).
//
// Décision du propriétaire du 19/09/2026 (planche « Sidebar propositions · 4a »,
// Figma GWXBALe90DMFR3XYGccofJ, frames 458:4 / 458:88 / 458:181) : le logo en
// haut, Talk / Build / Run au milieu, Settings / Help / le compte en bas.
//
// Son fond est le jeton `--c-rail`, UN CRAN plus foncé que celui du panneau :
// c'est ce qui fait deux colonnes plutôt qu'une colonne avec une marge. Le
// trait `rule-2` à droite les sépare, comme partout ailleurs dans le produit.
//
// Les deux entrées du bas qui ne sont pas des destinations — Help et le compte
// — ouvrent une carte (`RailPopover`) au lieu de naviguer. Le rail ne peut pas
// porter en pleine largeur le bloc de compte (courriel + Sign out) ni les trois
// liens « À propos » de la 0.8.11, et les supprimer aurait retiré des fonctions
// du produit, ce que l'issue interdit en toutes lettres.

import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  ArrowSquareOut,
  BookOpen,
  DiscordLogo,
  GearSix,
  Question,
  SealCheck,
  User,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';
import RailCell, { RailAvatarButton } from './ui/RailCell';
import RailPopover from './ui/RailPopover';
import { DESTINATIONS, type DestinationKey } from './sidebar-nav.ts';

/** Quelle carte du bas du rail est ouverte. Une seule à la fois. */
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
      {/* La flèche dit qu'on QUITTE l'application, et elle ferme la ligne —
          exactement comme dans la barre de la 0.8.11. */}
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
  settingsActive,
  userMenu,
}: {
  /** La destination que la route allume — `null` quand aucune ne l'est. */
  activeKey: DestinationKey | null;
  /** La route est-elle sous `/settings` ? */
  settingsActive: boolean;
  /** Le bloc de compte rendu par le serveur — courriel et Sign out. */
  userMenu?: ReactNode;
}) {
  // Deux cartes ouvertes en même temps se recouvriraient au bas d'un rail de
  // 72 px : l'état en retient UNE.
  const [carte, setCarte] = useState<Carte>(null);
  const basculer = (quelle: Exclude<Carte, null>) =>
    setCarte((ouverte) => (ouverte === quelle ? null : quelle));
  const fermer = () => setCarte(null);

  return (
    <nav
      aria-label="Sections"
      data-testid="sidebar-rail"
      className="flex h-full w-[var(--rail-w)] shrink-0 flex-col items-center gap-1 border-r border-rule-2 bg-rail pt-3.5 pb-3"
    >
      {/* Le logo seul : « Nodal-Agents » ne tient pas dans 72 px, et le nom
          reste écrit en toutes lettres au bas du panneau, sur la ligne de
          version. */}
      <Link
        href="/"
        title="Nodal-Agents"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-ink font-mono text-legacy-12 font-semibold tracking-[0.04em] text-canvas"
      >
        N
      </Link>
      <div className="h-2 shrink-0" />

      {DESTINATIONS.map((d) => (
        <RailCell
          key={d.key}
          href={d.href}
          label={d.label}
          icon={d.icon}
          active={d.key === activeKey}
          testId={`rail-${d.key}`}
        />
      ))}

      <div className="flex-1" />

      <RailCell
        href="/settings"
        label="Settings"
        icon={GearSix}
        active={settingsActive}
        testId="rail-settings"
      />

      {/* « Help » ouvre les trois endroits qui parlent DU PRODUIT, et qui sont
          tous dehors. La planche n'en montre qu'un, Documentation ; les deux
          autres — le serveur Discord et le portail qualité public — vivaient
          dans le groupe « About Nodal-Agents » de la 0.8.11. */}
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
            <HelpLink
              href="https://kwintspiracy.github.io/nodal-agents/"
              label="Documentation"
              icon={BookOpen}
            />
            <HelpLink href="https://discord.gg/7UZsvZPgU" label="Join Discord" icon={DiscordLogo} />
            <HelpLink
              href="https://kwintspiracy.github.io/nodal-agents/qa/"
              label="Quality board"
              icon={SealCheck}
            />
          </RailPopover>
        )}
      </div>

      {/* Le compte. L'avatar ne porte AUCUNE initiale : le rail ne sait pas qui
          est connecté — une installation locale n'a parfois personne — et en
          inventer une afficherait un fait que rien ne vérifie (invariant #4).
          Le nom vrai est dans la carte, écrit par le serveur. */}
      {userMenu !== undefined && (
        <div className="relative mt-1 shrink-0">
          <RailAvatarButton onClick={() => basculer('account')} expanded={carte === 'account'}>
            <User weight="fill" className="h-3.5 w-3.5" />
          </RailAvatarButton>
          {carte === 'account' && (
            <RailPopover label="Account" onClose={fermer}>
              <div data-testid="user-menu">{userMenu}</div>
            </RailPopover>
          )}
        </div>
      )}
    </nav>
  );
}
