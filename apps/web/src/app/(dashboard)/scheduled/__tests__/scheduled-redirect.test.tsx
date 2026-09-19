// scheduled-redirect.test.tsx — la page Scheduled n'existe plus (#202).
//
// Elle est retirée, pas cachée : son entrée de menu est partie, et la route
// REDIRIGE vers la liste des automatisations. Ce qui se prouve ici est
// l'adresse d'arrivée et le caractère PERMANENT du déménagement — un `redirect`
// ordinaire dirait aux navigateurs et aux moteurs que la page pourrait revenir.
//
// Le double de `permanentRedirect` lève, comme le vrai : une page qui
// continuerait à rendre quelque chose après l'appel se verrait ici.

import { describe, it, expect, vi } from 'vitest';

// `vi.hoisted` : la fabrique de `vi.mock` est remontée en tête de fichier et ne
// peut lire aucune variable déclarée après elle.
const { permanentRedirect, redirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((href: string) => {
    throw new Error(`PERMANENT_REDIRECT:${href}`);
  }),
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
}));

vi.mock('next/navigation', () => ({ permanentRedirect, redirect }));

import ScheduledPage from '../page.tsx';

describe('/scheduled @cap:planifier-une-tache/ecran', () => {
  it('redirige vers la liste des automatisations, de façon permanente', () => {
    expect(() => ScheduledPage()).toThrow('PERMANENT_REDIRECT:/automations');
    expect(permanentRedirect).toHaveBeenCalledWith('/automations');
    // Et PAS un redirect ordinaire : le déménagement est définitif.
    expect(redirect).not.toHaveBeenCalled();
  });
});
