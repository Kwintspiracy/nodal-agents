'use client';

// SidebarRail — la colonne de 72 px qui porte les trois destinations (#230).
//
// Décisions du propriétaire du 19/09/2026 (Figma GWXBALe90DMFR3XYGccofJ,
// frames 487:5489 / 487:5579 / 487:5652) : le logo en haut, Work / Agent / Run
// puis Approvals au milieu, Settings / Help / le compte en bas.
//
// ⚠️ APPROVALS EST UNE CASE, PAS UNE DESTINATION. Elle vivait dans le panneau
// Run, sous MONITOR : ce qui attend une réponse ne se voyait donc qu'en allant
// dans Run. Sur le rail, sa pastille est visible d'où que l'on soit, et c'est
// tout l'intérêt — le nombre qu'elle porte est le seul de la barre qu'une
// personne puisse faire tomber à zéro en répondant.
//
// Son fond est le jeton `--c-rail`, UN CRAN plus foncé que celui du panneau :
// c'est ce qui fait deux colonnes plutôt qu'une colonne avec une marge, et
// c'est la SEULE chose qui les sépare. Il a porté un trait `rule-2` à droite
// jusqu'au 19/09/2026 ; les planches du propriétaire n'en dessinent pas, et
// l'écart de fond suffit — un trait par-dessus faisait deux séparations pour
// une frontière.
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
  ShieldCheck,
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
  approvalsActive,
  approvalsCount,
  userMenu,
  initiale = null,
}: {
  /** La destination que la route allume — `null` quand aucune ne l'est. */
  activeKey: DestinationKey | null;
  /** La route est-elle sous `/settings` ? */
  settingsActive: boolean;
  /** La route est-elle sous `/approvals` ? */
  approvalsActive: boolean;
  /** Combien de demandes attendent la personne. 0 = aucune pastille. */
  approvalsCount: number;
  /** Le bloc de compte rendu par le serveur — courriel et Sign out. */
  userMenu?: ReactNode;
  /**
   * L'INITIALE de la personne connectée, lue par le serveur. `null` quand il
   * n'y a personne à nommer — mode local sans compte, jeton d'API — et le rond
   * porte alors une silhouette plutôt qu'une lettre inventée.
   */
  initiale?: string | null;
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
      className="flex h-full w-[var(--rail-w)] shrink-0 flex-col items-center gap-1 bg-rail pt-3.5 pb-3"
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

      {/* Approvals ferme le haut du rail : c'est la seule case qui compte
          quelque chose, et elle se lit depuis n'importe quelle destination. */}
      <RailCell
        href="/approvals"
        label="Approvals"
        icon={ShieldCheck}
        active={approvalsActive}
        pill={approvalsCount}
        testId="rail-approvals"
      />

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

      {/* Le compte. L'initiale vient du SERVEUR quand il connaît la personne —
          la planche l'écrit (« Q ») — et le rail retombe sur la silhouette
          quand il n'y a personne à nommer : une installation locale n'a parfois
          pas de compte du tout, et inventer une lettre afficherait un fait que
          rien ne vérifie (invariant #4). */}
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
    </nav>
  );
}
