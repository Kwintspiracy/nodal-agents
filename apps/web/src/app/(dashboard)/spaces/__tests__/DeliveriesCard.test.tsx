// DeliveriesCard.test.tsx — la file d'envoi montre CE QUI A ÉTÉ ENVOYÉ.
//
// Elle annonçait « Deliveries · 1 · telegram » sans jamais montrer le message
// ni offrir de l'ouvrir (Quentin, 18/09) : un envoi dont le contenu reste
// invisible. Chaque ligne se déplie maintenant sur le texte parti, et sur la
// raison quand il n'est pas parti.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import DeliveriesCard, { type DeliveryView } from '../DeliveriesCard.tsx';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));

const MESSAGE = 'Digest posted. Fourteen issues were opened this week.';

const delivery = (over: Partial<DeliveryView> = {}): DeliveryView => ({
  channel: 'telegram',
  chatId: '4242',
  outcome: 'confirmed',
  attempts: 1,
  payload: MESSAGE,
  reason: null,
  createdAt: new Date('2026-09-18T09:00:00Z'),
  updatedAt: new Date('2026-09-18T09:00:05Z'),
  ...over,
});

let container: HTMLDivElement;
let root: Root;

async function render(deliveries: DeliveryView[]): Promise<void> {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<DeliveriesCard deliveries={deliveries} />);
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('DeliveriesCard @cap:parler-par-canal-externe/ecran', () => {
  it('une ligne par envoi : son canal, son destinataire, son sort', async () => {
    await render([delivery()]);
    const texte = container.textContent ?? '';
    expect(texte).toContain('Deliveries · 1');
    expect(texte).toContain('telegram');
    expect(texte).toContain('to 4242');
    expect(texte).toContain('sent');
    // Une SECTION comme les autres : un titre mono en capitales, pas un
    // bandeau à elle.
    const titre = container.querySelector('h2');
    expect(titre?.className).toContain('uppercase');
  });

  it('le message n’est PAS dans la page avant qu’on ouvre la ligne', async () => {
    await render([delivery()]);
    expect(container.textContent).not.toContain(MESSAGE);

    await act(async () => {
      (container.querySelector('button[aria-expanded]') as HTMLElement).click();
    });
    expect(container.textContent).toContain(MESSAGE);
  });

  it('un envoi refusé dit sa raison, telle que le runner l’a écrite', async () => {
    await render([delivery({ outcome: 'rejected', attempts: 3, reason: 'allowlist_refused' })]);
    expect(container.textContent).toContain('rejected');
    expect(container.textContent).toContain('3 attempts');
    expect(container.textContent).not.toContain('allowlist_refused');

    await act(async () => {
      (container.querySelector('button[aria-expanded]') as HTMLElement).click();
    });
    expect(container.textContent).toContain('allowlist_refused');
  });

  it('un envoi dont le texte est inconnu garde sa ligne, sans bouton', async () => {
    // Un chevron qui n'ouvre rien se lit comme une panne.
    await render([delivery({ payload: '', reason: null })]);
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.textContent).toContain('telegram');
  });
});
