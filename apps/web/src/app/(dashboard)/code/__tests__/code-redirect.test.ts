// code-redirect.test.ts — `/code` MÈNE à Workspaces (#143).
//
// La liste Code a disparu : ses dossiers détectés, ses deux gestes et son
// panneau de preuve vivent maintenant sur Workspaces et sur la page du projet.
// La ROUTE, elle, reste — elle est dans des favoris et dans des liens déjà
// envoyés — et elle redirige plutôt que de rendre 404.
//
// Ce que ce test tient : la destination. Une redirection vers une route qui
// n'existe plus, ou vers `/code` elle-même, ferait une boucle qu'aucun écran ne
// signalerait.

import { describe, it, expect, vi } from 'vitest';

const redirect = vi.fn((url: string) => {
  // `next/navigation`'s redirect throws to unwind the render. On l'imite :
  // sans ça, la fonction de page continuerait après l'appel.
  throw new Error(`NEXT_REDIRECT:${url}`);
});

vi.mock('next/navigation', () => ({ redirect }));

describe('/code @cap:travailler-sur-des-fichiers/ecran', () => {
  it('redirige vers Workspaces, la seule page des projets', async () => {
    const { default: CodePage } = await import('../page.tsx');
    expect(() => CodePage()).toThrow('NEXT_REDIRECT:/spaces');
    expect(redirect).toHaveBeenCalledWith('/spaces');
  });
});
