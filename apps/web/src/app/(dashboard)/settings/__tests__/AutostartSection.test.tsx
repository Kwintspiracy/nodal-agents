// AutostartSection.test.tsx — « Start Nodal when this machine starts » (#451).
//
// La ligne dit ce que le SYSTÈME a répondu (lu par le CLI), et ses états : off,
// à la connexion (avec la commande du linger sous Linux), au boot, impossible
// avec la raison. L'interrupteur envoie le geste et affiche l'état RELU après.
//
// Mutations vérifiées :
//   - la commande du linger retirée de l'écran → « à la connexion » rougit ;
//   - l'état relu ignoré (`setView` retiré) → « bascule » rougit ;
//   - le toast rendu au seul « ok » de l'action (l'ancien `toast.success`
//     inconditionnel) → « refus » rougit : un succès s'affichait au-dessus d'un
//     CLI qui n'avait rien inscrit.

import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AutostartView } from '@/lib/autostart-view.ts';

const setAutostartAction = vi.hoisted(() =>
  vi.fn(
    async (): Promise<{ ok: true; data: AutostartView }> => ({
      ok: true,
      data: { status: { state: 'at_login' }, error: null, isOwner: true },
    }),
  ),
);
vi.mock('@/lib/actions.ts', () => ({ setAutostartAction }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

const { default: AutostartSection } = await import('../AutostartSection.tsx');

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setAutostartAction.mockClear();
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(initial: AutostartView): Promise<string> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<AutostartSection initial={initial} />);
  });
  return container.textContent!.replace(/\s+/g, ' ');
}

function interrupteur(): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>('button[role="switch"]')!;
}

describe('Start Nodal when this machine starts @cap:installer-et-demarrer/ecran', () => {
  it('off : dit ce que ça coûte, et l’interrupteur est éteint', async () => {
    const texte = await render({ status: { state: 'off' }, error: null, isOwner: true });
    expect(texte).toContain('Off. After a restart, Nodal stays down until someone starts it.');
    expect(interrupteur().getAttribute('aria-checked')).toBe('false');
  });

  it('off parce que coupé dans les réglages du système : la raison, et l’interrupteur reste utilisable', async () => {
    const texte = await render({
      status: {
        state: 'off',
        reason: 'Windows has this startup entry turned off. Turn this on to enable it again.',
      },
      error: null,
      isOwner: true,
    });
    expect(texte).toContain(
      'Off. Windows has this startup entry turned off. Turn this on to enable it again.',
    );
    expect(texte).not.toContain('Nodal stays down until someone starts it');
    expect(interrupteur().getAttribute('aria-checked')).toBe('false');
    expect(interrupteur().disabled).toBe(false);
  });

  it('à la connexion (Linux sans linger) : la commande exacte qui le fait démarrer au boot', async () => {
    const texte = await render({
      status: { state: 'at_login', lingerCommand: 'sudo loginctl enable-linger pi' },
      error: null,
      isOwner: true,
    });
    expect(texte).toContain('On. Nodal starts when you log in to this machine.');
    expect(texte).toContain('sudo loginctl enable-linger pi');
    expect(interrupteur().getAttribute('aria-checked')).toBe('true');
  });

  it('au boot : dit qu’il démarre sans session ouverte', async () => {
    const texte = await render({ status: { state: 'at_boot' }, error: null, isOwner: true });
    expect(texte).toContain('On. Nodal starts when this machine boots, before anyone logs in.');
  });

  it('impossible ici : la raison, et un interrupteur inerte', async () => {
    const texte = await render({
      status: { state: 'unsupported', reason: 'This machine has no systemd user session.' },
      error: null,
      isOwner: true,
    });
    expect(texte).toContain('This machine has no systemd user session.');
    expect(interrupteur().disabled).toBe(true);
  });

  it('illisible : l’erreur est dite, jamais « off »', async () => {
    const texte = await render({ status: null, error: 'schtasks failed', isOwner: true });
    expect(texte).toContain('schtasks failed');
    expect(texte).not.toContain('Off.');
    expect(interrupteur().disabled).toBe(true);
  });

  it('bascule : envoie le geste, puis montre l’état RELU dans le système', async () => {
    await render({ status: { state: 'off' }, error: null, isOwner: true });
    await act(async () => {
      interrupteur().click();
    });
    expect(setAutostartAction).toHaveBeenCalledWith({ enabled: true });
    expect(container.textContent).toContain('On. Nodal starts when you log in to this machine.');
    expect(toast.success).toHaveBeenCalledWith('Nodal will start with this machine');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('refus : le CLI répond sans rien inscrire (install lancée par npx), aucun succès, la raison est dite', async () => {
    const reason =
      'This install runs through npx: there is no script to start at boot. Install nodal-agents globally first.';
    setAutostartAction.mockResolvedValueOnce({
      ok: true,
      data: { status: { state: 'unsupported', reason }, error: null, isOwner: true },
    });
    await render({ status: { state: 'off' }, error: null, isOwner: true });
    await act(async () => {
      interrupteur().click();
    });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(reason);
    expect(container.textContent).toContain(reason);
    expect(interrupteur().getAttribute('aria-checked')).toBe('false');
  });

  it('extinction refusée : l’entrée est toujours là, aucun succès', async () => {
    setAutostartAction.mockResolvedValueOnce({
      ok: true,
      data: { status: { state: 'at_login' }, error: null, isOwner: true },
    });
    await render({ status: { state: 'at_login' }, error: null, isOwner: true });
    await act(async () => {
      interrupteur().click();
    });
    expect(setAutostartAction).toHaveBeenCalledWith({ enabled: false });
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      'Nodal still starts with this machine: the startup entry could not be removed.',
    );
  });

  it('un invité ne peut pas le changer', async () => {
    const texte = await render({ status: { state: 'off' }, error: null, isOwner: false });
    expect(texte).toContain('Only the owner of this installation can change this setting.');
    expect(interrupteur().disabled).toBe(true);
  });

  it('n’emploie aucun tiret cadratin', async () => {
    expect(await render({ status: { state: 'off' }, error: null, isOwner: true })).not.toContain(
      '—',
    );
  });
});
