/**
 * settings-pages.ts — les PAGES de /settings, une par entrée du menu (20/09).
 *
 * La barre latérale dit Access, Safety, Workspace, Install (LLM Providers a sa
 * propre page). Chaque page porte les réglages de sa famille, dans l'ordre de
 * la planche. Les deux lignes « avancées » (URLs, session) vont avec le
 * workspace : elles décrivent l'installation, et une cinquième page pour deux
 * lignes en lecture seule n'aurait rien apporté.
 *
 * Un module sans directive : la page serveur et la barre client le lisent.
 */

import type { SettingId } from './settings-rows.ts';

export type SettingsPageKey = 'access' | 'safety' | 'workspace' | 'install';

export type SettingsPage = {
  key: SettingsPageKey;
  label: string;
  /** La phrase sous le titre. */
  lede: string;
  ids: readonly SettingId[];
};

export const SETTINGS_PAGES: readonly SettingsPage[] = [
  {
    key: 'access',
    label: 'Access',
    lede: 'Who can open this dashboard, and from where.',
    ids: ['sign-in', 'network', 'password', 'worker-secret'],
  },
  {
    key: 'safety',
    label: 'Safety',
    lede: 'What your agents may do on their own, and what stops them.',
    ids: ['auto-run-brake', 'verification', 'root-agent', 'mcp-server'],
  },
  {
    key: 'workspace',
    label: 'Workspace',
    lede: 'Where your agents work, and the facts of this installation.',
    ids: ['timezone', 'workspaces', 'urls', 'session'],
  },
  {
    key: 'install',
    label: 'Install',
    lede: 'Notes every agent reads about this machine.',
    ids: ['install-notes'],
  },
];

export const DEFAULT_SETTINGS_PAGE: SettingsPageKey = 'access';

/**
 * La page demandée par l'URL. `?page=` d'abord ; `?open=<réglage>` ensuite,
 * parce que les liens d'avant le 20/09 en portaient un et qu'un lien qui
 * cessait de mener quelque part serait une régression ; Access sinon.
 */
export function resolveSettingsPage(params: { page?: string; open?: string }): SettingsPage {
  const byKey = SETTINGS_PAGES.find((p) => p.key === params.page);
  if (byKey) return byKey;
  const byOpen = SETTINGS_PAGES.find((p) =>
    (p.ids as readonly string[]).includes(params.open ?? ''),
  );
  if (byOpen) return byOpen;
  return SETTINGS_PAGES.find((p) => p.key === DEFAULT_SETTINGS_PAGE)!;
}
