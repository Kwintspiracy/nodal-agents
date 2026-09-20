'use client';

/**
 * SettingsSections — les réglages d'UNE page, chacun dans la page (20/09).
 *
 * Le propriétaire a retiré le panneau ancré de /settings : « reconstruis la
 * page comme elle était avant, le contenu entièrement dans la page, splitté
 * en respectant la sidebar ». Une page par entrée du menu Settings (Access,
 * Safety, Workspace, Install), et sur chacune ses réglages empilés, avec leur
 * formulaire EN PLACE — les formulaires existants, inchangés : hors d'un
 * panneau ancré, `SetCtaRow` rend ses propres Cancel et Save.
 *
 * Aucun état, aucun hook — mais `'use client'` quand même : les icônes
 * Phosphor tiennent un contexte React, ce qu'un composant serveur ne peut pas
 * charger (la stack l'a dit à la première ouverture). La page serveur lui donne
 * les lignes de SA catégorie et les formulaires déjà rendus.
 */

import type { ReactNode } from 'react';
import {
  Browser,
  Checks,
  Clock,
  EyeSlash,
  IdentificationCard,
  Key,
  LinkSimple,
  ListBullets,
  Pause,
  PlugsConnected,
  ShieldCheck,
  UsersThree,
  WifiHigh,
  type Icon,
} from '@phosphor-icons/react';
import { TagMini } from '@/components/ui/TagMini.tsx';
import type { SettingId, SettingRow } from './settings-rows.ts';

const ICONS: Record<SettingId, Icon> = {
  'sign-in': Key,
  network: WifiHigh,
  password: EyeSlash,
  'worker-secret': ShieldCheck,
  'auto-run-brake': Pause,
  verification: Checks,
  'root-agent': UsersThree,
  'mcp-server': PlugsConnected,
  timezone: Clock,
  'install-notes': ListBullets,
  workspaces: Browser,
  urls: LinkSimple,
  session: IdentificationCard,
};

export default function SettingsSections({
  rows,
  panels,
}: {
  /** Les lignes de la page, dans l'ordre de la planche. */
  rows: readonly SettingRow[];
  /** Le formulaire de chaque réglage — `null` quand sa lecture a échoué. */
  panels: Partial<Record<SettingId, ReactNode>>;
}) {
  return (
    <div className="flex flex-col gap-8" data-testid="settings-sections">
      {rows.map((row) => {
        const Glyph = ICONS[row.id];
        const panel = panels[row.id] ?? null;
        return (
          <section
            key={row.id}
            id={row.id}
            data-testid={`setting-section-${row.id}`}
            className="flex flex-col gap-4"
          >
            <header className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="flex h-4 w-4 shrink-0 items-center justify-center text-ink-3">
                  <Glyph size={16} />
                </span>
                <h2 className="text-title-16 text-ink">{row.name}</h2>
                {row.tag && <TagMini variant={row.tag.variant}>{row.tag.label}</TagMini>}
              </div>
              <p className="text-body-13 text-ink-3">{row.lede}</p>
            </header>
            {/* Une section vide est un cul-de-sac : quand la lecture du réglage
                a échoué, la page n'a aucun formulaire à mettre ici, et la
                section dit pourquoi au lieu de ne rien dire (invariant #4). */}
            {panel === null ? (
              <p className="text-body-13 text-warn" data-testid={`setting-unread-${row.id}`}>
                {row.value}. Reload the page, and check the runner is up.
              </p>
            ) : (
              <div className="rounded-lg border border-rule-2 bg-paper p-4">{panel}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}
