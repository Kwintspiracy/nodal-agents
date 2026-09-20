// SettingsSections.test.tsx — les réglages EN PLACE dans la page (20/09), une
// page par entrée du menu. Trois choses que le retrait du panneau pouvait
// casser : une page ne montre que SES réglages ; chaque section porte son nom,
// sa valeur et son formulaire ; un réglage dont la lecture a échoué dit
// pourquoi au lieu de s'afficher vide.

import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsSections from '../SettingsSections.tsx';
import { resolveSettingsPage, SETTINGS_PAGES } from '../settings-pages.ts';
import type { SettingRow } from '../settings-rows.ts';

const ROWS: SettingRow[] = [
  {
    id: 'sign-in',
    group: 'access',
    name: 'Sign-in',
    lede: 'Who can open the dashboard.',
    value: 'No password',
    tag: { variant: 'warn', label: 'NO AUTH' },
  },
  {
    id: 'network',
    group: 'access',
    name: 'Network access',
    lede: 'Local only, or the LAN.',
    value: 'Unread',
  },
  {
    id: 'timezone',
    group: 'workspace',
    name: 'Timezone',
    lede: 'The zone your agents live in.',
    value: 'Europe/Paris',
  },
];

describe('SettingsSections @cap:installer-et-demarrer/ecran', () => {
  it('rend une section par réglage, avec son nom, sa pastille et son formulaire', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSections, {
        rows: ROWS.filter((r) => r.group === 'access'),
        panels: {
          'sign-in': createElement('form', { id: 'f-sign-in' }, 'sign-in form'),
          network: createElement('form', { id: 'f-network' }, 'network form'),
        },
      }),
    );
    expect(html).toContain('data-testid="setting-section-sign-in"');
    expect(html).toContain('data-testid="setting-section-network"');
    expect(html).not.toContain('setting-section-timezone');
    expect(html).toContain('Sign-in');
    expect(html).toContain('NO AUTH');
    expect(html).toContain('Who can open the dashboard.');
    // Le formulaire est DANS la page, dans sa section, pas dans un panneau.
    expect(html.indexOf('setting-section-sign-in')).toBeLessThan(html.indexOf('f-sign-in'));
    expect(html.indexOf('f-sign-in')).toBeLessThan(html.indexOf('setting-section-network'));
  });

  it('un réglage sans formulaire dit pourquoi, au lieu de s’afficher vide', () => {
    const html = renderToStaticMarkup(
      createElement(SettingsSections, {
        rows: ROWS.filter((r) => r.id === 'network'),
        panels: {},
      }),
    );
    expect(html).toContain('data-testid="setting-unread-network"');
    expect(html).toContain('Unread. Reload the page, and check the runner is up.');
  });
});

describe('les pages de /settings @cap:installer-et-demarrer/ecran', () => {
  it('chaque réglage vit sur UNE page, et chaque page est une entrée du menu', () => {
    const vus = SETTINGS_PAGES.flatMap((p) => [...p.ids]);
    expect(new Set(vus).size).toBe(vus.length);
    expect(SETTINGS_PAGES.map((p) => p.label)).toEqual([
      'Access',
      'Safety',
      'Workspace',
      'Install',
    ]);
  });

  it('`?page=` choisit la page, `?open=<réglage>` y mène aussi, et sinon Access', () => {
    expect(resolveSettingsPage({ page: 'safety' }).key).toBe('safety');
    // Un lien d'avant le 20/09 : le réglage dit sa page.
    expect(resolveSettingsPage({ open: 'timezone' }).key).toBe('workspace');
    expect(resolveSettingsPage({ open: 'install-notes' }).key).toBe('install');
    expect(resolveSettingsPage({ page: 'nope', open: 'nope' }).key).toBe('access');
    expect(resolveSettingsPage({}).key).toBe('access');
  });
});
