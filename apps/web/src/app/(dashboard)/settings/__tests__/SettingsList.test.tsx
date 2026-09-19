// SettingsList.test.tsx — l'écran de /settings : une liste, un panneau ancré
// (S3 + P1, #231).
//
// Ce qui se prouve ici, et qu'aucun test de moteur ne peut prouver : les
// treize réglages sont À L'ÉCRAN avec leur valeur, cliquer une ligne ouvre SON
// formulaire (pas celui d'à côté), le filtre réduit vraiment la liste,
// « Advanced » est repliée d'entrée, et l'URL porte le réglage ouvert pour
// qu'un lien direct retombe dessus.
//
// Les valeurs affichées ne sont pas récrites à la main dans les assertions :
// elles viennent de `buildSettingRows`, la même fonction que la page, nourrie
// d'une source explicite. Une valeur qui changerait de forme casserait le test
// de moteur, pas celui-ci — chacun prouve sa moitié.
//
// Le PIED du panneau se prouve ici aussi (planche P1) : Cancel et Save vivent
// au bas du panneau, et le Save soumet le formulaire ouvert par l'attribut HTML
// `form`. L'assertion porte sur ce que la soumission REÇOIT — la valeur saisie
// — jamais sur un compte d'appels.
//
// Mutations vérifiées : le panneau branché sur la PREMIÈRE ligne au lieu de la
// ligne cliquée → « cliquer une ligne ouvre SON formulaire » rougit ;
// `advancedOpen` initialisé à `true` → « Advanced est repliée » rougit ; le
// filtre ignoré (toutes les lignes rendues) → « le filtre réduit la liste »
// rougit ; l'attribut `form` du bouton Save retiré → « Save soumet le
// formulaire » rougit ; `SetCtaRow` qui s'affiche quand même dans le panneau →
// « le formulaire ne porte plus ses propres boutons » rougit.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import SettingsList from '../SettingsList.tsx';
import SettingsPanel from '../SettingsPanel.tsx';
import { SettingsScreenProvider } from '../SettingsScreen.tsx';
import { buildSettingRows, type SettingId, type SettingRow } from '../settings-rows.ts';
import { dockedFormId } from '@/lib/docked-form-id.ts';
import { SetCtaRow } from '@/components/ui/SetCtaRow.tsx';
import TextInput from '@/components/ui/TextInput';

let container: HTMLDivElement;
let root: Root;

/** Une source réaliste : ce que la page aurait lu sur une install en LAN. */
const SOURCE: Parameters<typeof buildSettingRows>[0] = {
  authMode: 'local-auth',
  workerSecretConfigured: true,
  security: {
    runtimeMode: 'local-auth',
    configuredMode: 'local-auth',
    googleConfigured: false,
    googleAvailableInRuntime: false,
    configPathExists: true,
  },
  network: {
    configuredBind: 'lan',
    runtimeBind: 'lan',
    lanAddresses: ['192.168.50.197'],
    webPort: 3000,
    configPathExists: true,
  },
  autoRunPause: { autoRunPaused: false, isOwner: true },
  verification: {
    surfaces: { codeTask: true, cliRuntime: true, fileOps: true, shell: true },
    isOwner: true,
  },
  mcpServer: { enabled: true, isOwner: true },
  timezone: { timezone: 'Asia/Singapore', isExplicit: true },
  installNotes: '',
  workspaces: [{ id: 'w1', name: 'Local', slug: 'local', icon: null, role: 'owner', active: true }],
  agents: [],
  rootAgentId: null,
  rootAutonomy: 'destructive_gate',
};

const ROWS = buildSettingRows(SOURCE);

/** Un contenu reconnaissable par réglage, à la place des vrais formulaires. */
const PANELS: Partial<Record<SettingId, React.ReactNode>> = Object.fromEntries(
  ROWS.map((r) => [r.id, <p key={r.id} data-testid={`form-${r.id}`}>{`form ${r.id}`}</p>]),
);

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  window.history.replaceState(null, '', '/settings');
});

async function click(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

async function type(value: string): Promise<void> {
  const input = container.querySelector<HTMLInputElement>('[data-testid="settings-filter"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function rowIds(): string[] {
  return [...container.querySelectorAll('[data-testid^="setting-row-"]')].map((el) =>
    el.getAttribute('data-testid')!.replace('setting-row-', ''),
  );
}

function row(id: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-testid="setting-row-${id}"]`);
  if (!el) throw new Error(`aucune ligne ${id} rendue`);
  return el;
}

function panel(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="settings-panel"]');
}

/**
 * L'écran complet, monté comme la page le monte : la liste et le panneau de
 * part et d'autre de la borne de largeur, autour de l'état qu'ils partagent.
 * Les deux vivent dans des fentes différentes du `PageShell` (#237), donc les
 * monter ensemble est la seule façon de prouver qu'ils se parlent.
 */
function list(
  props: {
    rows?: SettingRow[];
    panels?: Partial<Record<SettingId, React.ReactNode>>;
    initialOpen?: SettingId | null;
  } = {},
) {
  return (
    <SettingsScreenProvider rows={props.rows ?? ROWS} initialOpen={props.initialOpen ?? null}>
      <div className="flex">
        <SettingsList />
        <SettingsPanel panels={props.panels ?? PANELS} />
      </div>
    </SettingsScreenProvider>
  );
}

describe('SettingsList @cap:installer-et-demarrer/ecran', () => {
  it('rend les onze réglages courants avec leur valeur, et range les deux autres sous Advanced', async () => {
    await render(list());

    expect(rowIds()).toEqual([
      'sign-in',
      'network',
      'password',
      'worker-secret',
      'auto-run-brake',
      'verification',
      'root-agent',
      'mcp-server',
      'timezone',
      'install-notes',
      'workspaces',
    ]);

    // Chaque ligne porte SA valeur, celle que la page aurait lue.
    for (const r of ROWS.filter((r) => r.group !== 'advanced')) {
      expect(row(r.id).textContent, r.id).toContain(r.value);
      expect(row(r.id).textContent, r.id).toContain(r.name);
    }
    // Les valeurs réelles de cette install, pas des libellés génériques.
    expect(row('network').textContent).toContain('http://192.168.50.197:3000');
    expect(row('timezone').textContent).toContain('Asia/Singapore');
    expect(row('auto-run-brake').textContent).toContain('Released');

    // Les quatre familles, dans l'ordre de la planche.
    expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual([
      'Access',
      'Safety',
      'Workspace',
    ]);
  });

  it('la liste ne borne pas sa largeur : elle prend celle de la page', async () => {
    // Elle portait `max-w-3xl`, ce qui rendait /settings plus étroite que
    // toutes les autres pages sans raison. La borne, s'il en faut une, est
    // celle du PageShell, pas une borne de plus posée ici.
    await render(list());
    const colonne = container.querySelector<HTMLElement>('[data-testid="settings-list"]')!;
    expect(colonne).not.toBeNull();
    const bornes = [...colonne.classList].filter((c) => c.startsWith('max-w-'));
    expect(bornes, 'aucune borne de largeur sur la colonne de liste').toEqual([]);
  });

  it('Advanced est repliée par défaut, et s’ouvre sur ses deux lignes', async () => {
    await render(list());

    const toggle = container.querySelector<HTMLElement>(
      '[data-testid="settings-advanced-toggle"]',
    )!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('[data-testid="setting-row-urls"]')).toBeNull();
    expect(container.querySelector('[data-testid="setting-row-session"]')).toBeNull();
    // Le repli annonce combien il cache.
    expect(toggle.textContent).toContain('2');

    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(rowIds()).toContain('urls');
    expect(rowIds()).toContain('session');
  });

  it('cliquer une ligne ouvre SON réglage dans le panneau, et la ligne reste surlignée', async () => {
    await render(list());
    expect(panel()).toBeNull();

    await click(row('network'));
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('h2')?.textContent).toBe('Network access');
    expect(panel()!.querySelector('[data-testid="form-network"]')).not.toBeNull();
    expect(panel()!.querySelector('[data-testid="form-timezone"]')).toBeNull();
    expect(row('network').getAttribute('data-selected')).toBe('true');
    expect(row('timezone').getAttribute('data-selected')).toBe('false');

    // Une autre ligne remplace le contenu du panneau, elle n'en ouvre pas un second.
    await click(row('timezone'));
    expect(container.querySelectorAll('[data-testid="settings-panel"]')).toHaveLength(1);
    expect(panel()!.querySelector('h2')?.textContent).toBe('Timezone');
    expect(panel()!.querySelector('[data-testid="form-timezone"]')).not.toBeNull();
    expect(panel()!.querySelector('[data-testid="form-network"]')).toBeNull();
    expect(row('network').getAttribute('data-selected')).toBe('false');
  });

  it('le panneau porte le lede du réglage, au-dessus de son formulaire', async () => {
    await render(list());
    await click(row('mcp-server'));
    const lede = ROWS.find((r) => r.id === 'mcp-server')!.lede;
    expect(panel()!.textContent).toContain(lede);
  });

  it('la liste reste cliquable pendant que le panneau est ouvert', async () => {
    await render(list());
    await click(row('network'));
    // Aucun voile : le panneau pousse la page.
    expect(container.querySelector('[aria-hidden="true"].fixed')).toBeNull();
    await click(row('workspaces'));
    expect(panel()!.querySelector('[data-testid="form-workspaces"]')).not.toBeNull();
  });

  it('le filtre réduit la liste aux lignes dont le nom correspond', async () => {
    await render(list());
    expect(rowIds()).toHaveLength(11);

    await type('time');
    expect(rowIds()).toEqual(['timezone']);

    await type('zzz');
    expect(rowIds()).toHaveLength(0);
    expect(container.querySelector('[data-testid="settings-no-match"]')).not.toBeNull();

    await type('');
    expect(rowIds()).toHaveLength(11);
  });

  it('le filtre atteint aussi les lignes rangées sous Advanced', async () => {
    await render(list());
    expect(container.querySelector('[data-testid="setting-row-session"]')).toBeNull();

    await type('session');
    expect(rowIds()).toEqual(['session']);
  });

  it('l’URL porte le réglage ouvert, et le lâche à la fermeture', async () => {
    await render(list());
    expect(window.location.search).toBe('');

    await click(row('network'));
    expect(window.location.search).toBe('?open=network');

    const close = panel()!.querySelector('button[aria-label="Close"]')!;
    await click(close);
    expect(panel()).toBeNull();
    expect(window.location.search).toBe('');
  });

  it('un réglage sans formulaire — sa lecture a échoué — dit pourquoi au lieu de s’ouvrir vide', async () => {
    // La page ne met aucun formulaire dans `panels` quand l'action a échoué.
    const sansFormulaire = { ...PANELS, network: null };
    await render(list({ panels: sansFormulaire, initialOpen: 'network' }));
    const vide = panel()!.querySelector('[data-testid="settings-panel-unread"]');
    expect(vide).not.toBeNull();
    expect(vide!.textContent).toContain(ROWS.find((r) => r.id === 'network')!.value);
  });

  /**
   * Un formulaire de réglage, réduit à ce qui compte ici : un `<form>` qui
   * porte l'`id` du panneau, un champ, et le `SetCtaRow` partagé — le même
   * composant que les dix vrais formulaires.
   */
  function FauxFormulaire({ id, onSave }: { id: string; onSave: (valeur: string) => void }) {
    const [valeur, setValeur] = useState('Europe/Paris');
    return (
      <form
        id={id}
        onSubmit={(e) => {
          e.preventDefault();
          onSave(valeur);
        }}
      >
        <TextInput data-testid="champ" value={valeur} onChange={(e) => setValeur(e.target.value)} />
        <SetCtaRow onCancel={() => setValeur('Europe/Paris')} saveLabel="Save" />
      </form>
    );
  }

  it('le pied du panneau porte Cancel et Save, et Save soumet le formulaire ouvert', async () => {
    const onSave = vi.fn();
    await render(
      list({
        panels: {
          ...PANELS,
          timezone: <FauxFormulaire id={dockedFormId('timezone')} onSave={onSave} />,
        },
        initialOpen: 'timezone',
      }),
    );

    // Le formulaire ne porte plus ses propres boutons : ils sont dans le pied.
    const pied = panel()!.querySelector('[data-slot="footer"]')!;
    expect(pied).not.toBeNull();
    expect(panel()!.querySelectorAll('[data-testid="settings-panel-save"]')).toHaveLength(1);
    expect(pied.querySelector('[data-testid="settings-panel-save"]')).not.toBeNull();
    expect(pied.querySelector('[data-testid="settings-panel-cancel"]')).not.toBeNull();
    // Le corps du panneau n'a aucun bouton de soumission à lui.
    const corps = panel()!.querySelector('form')!;
    expect(corps.querySelector('button[type="submit"]')).toBeNull();

    // On saisit une valeur, puis on enregistre DEPUIS LE PIED.
    const champ = panel()!.querySelector<HTMLInputElement>('[data-testid="champ"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(champ, 'Asia/Singapore');
      champ.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const save = pied.querySelector<HTMLButtonElement>('[data-testid="settings-panel-save"]')!;
    expect(save.getAttribute('form')).toBe(dockedFormId('timezone'));
    await act(async () => {
      save.click();
    });

    // Ce que la soumission a REÇU, pas le nombre de fois qu'on l'a appelée.
    expect(onSave.mock.calls).toEqual([['Asia/Singapore']]);
  });

  it('pendant l’enregistrement, le pied le dit et refuse un second clic', async () => {
    // Le formulaire passe en attente à la soumission et n'en ressort pas —
    // c'est ce que fait un `useTransition` tant que l'action tourne. Le pied
    // n'a pas cet état : le `SetCtaRow` le lui ANNONCE (`DockedFormCta.tsx`),
    // donc ce cas prouve que le fil remonte jusqu'en bas du panneau.
    let soumissions = 0;
    function FormulaireQuiAttend({ id }: { id: string }) {
      const [pending, setPending] = useState(false);
      return (
        <form
          id={id}
          onSubmit={(e) => {
            e.preventDefault();
            soumissions += 1;
            setPending(true);
          }}
        >
          <SetCtaRow onCancel={() => {}} pending={pending} saveLabel="Save" />
        </form>
      );
    }

    await render(
      list({
        panels: { ...PANELS, timezone: <FormulaireQuiAttend id={dockedFormId('timezone')} /> },
        initialOpen: 'timezone',
      }),
    );

    const save = () =>
      panel()!.querySelector<HTMLButtonElement>('[data-testid="settings-panel-save"]')!;
    expect(save().disabled, 'au repos, il enregistre').toBe(false);
    expect(save().textContent).toBe('Save');

    await act(async () => {
      save().click();
    });

    expect(save().textContent, 'le pied dit ce qui se passe').toBe('Saving…');
    expect(save().disabled, 'et refuse un second envoi').toBe(true);

    // Un second clic ne soumet rien : c'est ce que le `disabled` achète.
    await act(async () => {
      save().click();
    });
    expect(soumissions, 'une seule soumission').toBe(1);
  });

  it('Cancel remet l’état du formulaire, puis ferme le panneau', async () => {
    await render(
      list({
        panels: {
          ...PANELS,
          timezone: <FauxFormulaire id={dockedFormId('timezone')} onSave={() => {}} />,
        },
        initialOpen: 'timezone',
      }),
    );
    const champ = panel()!.querySelector<HTMLInputElement>('[data-testid="champ"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(champ, 'Asia/Tokyo');
      champ.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(panel()!.querySelector<HTMLInputElement>('[data-testid="champ"]')!.value).toBe(
      'Asia/Tokyo',
    );

    await click(panel()!.querySelector('[data-testid="settings-panel-cancel"]')!);
    expect(panel()).toBeNull();

    // Rouvrir montre la valeur d'origine, pas la saisie abandonnée.
    await click(row('timezone'));
    expect(panel()!.querySelector<HTMLInputElement>('[data-testid="champ"]')!.value).toBe(
      'Europe/Paris',
    );
  });

  it('un réglage sans bouton d’enregistrement n’a pas de pied', async () => {
    // Un interrupteur immédiat : rien à soumettre, donc rien au bas du panneau.
    await render(list({ initialOpen: 'mcp-server' }));
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('[data-slot="footer"]')).toBeNull();
  });

  it('un lien direct ouvre le panneau au premier rendu', async () => {
    await render(list({ initialOpen: 'verification' }));
    expect(panel()).not.toBeNull();
    expect(panel()!.querySelector('h2')?.textContent).toBe('Verification surfaces');
    expect(panel()!.querySelector('[data-testid="form-verification"]')).not.toBeNull();
    expect(row('verification').getAttribute('data-selected')).toBe('true');
  });
});
