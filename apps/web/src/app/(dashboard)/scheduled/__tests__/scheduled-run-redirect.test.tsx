// scheduled-run-redirect.test.tsx — `/scheduled/<id>` n'est plus une page (#501).
//
// Cette porte rendait la page de N'IMPORTE QUEL run, et le rail, qui lit sa
// section de l'adresse seule, l'aurait allumée sur Scheduled : « Open run »
// d'un fil Work y menait (revue Nodal de #621), le bug #501 par un chemin qui
// contournait run-page.ts. Aucun écran ne l'écrit plus ; elle reste pour les
// liens déjà envoyés et les favoris, et elle REDIRIGE vers `/runs/<id>`, qui
// range le run par la tête de sa chaîne. Elle ne dessine rien, et ne décide
// rien elle-même.
//
// Mutation vérifiée : la page rendue à nouveau (RunPage) au lieu de la
// redirection → ce test rougit.

import { describe, it, expect, vi } from 'vitest';

const { permanentRedirect, redirect } = vi.hoisted(() => ({
  permanentRedirect: vi.fn((href: string) => {
    throw new Error(`PERMANENT_REDIRECT:${href}`);
  }),
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
}));

vi.mock('next/navigation', () => ({ permanentRedirect, redirect, notFound: vi.fn() }));

import ScheduledRunPage from '../[id]/page.tsx';

describe('/scheduled/<id> @cap:suivre-execution/ecran', () => {
  it('redirige vers /runs/<id>, qui range le run dans SA section', async () => {
    await expect(ScheduledRunPage({ params: Promise.resolve({ id: 'job-7' }) })).rejects.toThrow(
      'REDIRECT:/runs/job-7',
    );
    expect(redirect).toHaveBeenCalledWith('/runs/job-7');
  });
});
