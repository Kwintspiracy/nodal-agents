// open-run-page.test.tsx — la porte `/runs/<id>` (#501).
//
// Elle lit la tête de la chaîne du run et redirige vers sa section. Quand la
// chaîne ne se lit pas (`lineage_broken`), la section est inconnue : la page le
// DIT, et garde un accès au run, par la page de run sous Work, la section que
// le rail montre déjà faute de mieux. Sans ce lien, `/scheduled/<id>` (qui
// redirige ici) perdait les runs que `/jobs/<id>` ouvrait encore (revue Nodal
// de #621, passe 2).
//
// Mutation vérifiée : le lien retiré de la page d'erreur → le cas
// `lineage_broken` rougit.

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const { redirect, notFound, resolveRunPageHrefAction } = vi.hoisted(() => ({
  redirect: vi.fn((href: string) => {
    throw new Error(`REDIRECT:${href}`);
  }),
  notFound: vi.fn(() => {
    throw new Error('NOT_FOUND');
  }),
  resolveRunPageHrefAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect, notFound }));
vi.mock('@/lib/conversation-actions.ts', () => ({ resolveRunPageHrefAction }));

import OpenRunPage from '../page.tsx';

const ID = '5f1c2a9e-0000-4000-8000-000000000001';
const page = () => OpenRunPage({ params: Promise.resolve({ id: ID }) });

describe('/runs/<id> @cap:suivre-execution/ecran', () => {
  it('la section se lit : la porte redirige vers elle', async () => {
    resolveRunPageHrefAction.mockResolvedValueOnce({ ok: true, data: `/jobs/${ID}` });
    await expect(page()).rejects.toThrow(`REDIRECT:/jobs/${ID}`);
  });

  it('la chaîne ne se lit pas : la page le dit, et ouvre quand même le run', async () => {
    resolveRunPageHrefAction.mockResolvedValueOnce({
      ok: false,
      code: 'lineage_broken',
      message: 'The run this one was delegated from could not be read',
    });
    const html = renderToStaticMarkup(await page());
    expect(html).toContain('The run this one was delegated from could not be read');
    expect(html).toContain(`href="/chat/runs/${ID}"`);
    expect(html).toContain('Open the run');
  });

  it('un run introuvable reste introuvable, sans lien', async () => {
    resolveRunPageHrefAction.mockResolvedValueOnce({
      ok: false,
      code: 'not_found',
      message: 'Run not found',
    });
    await expect(page()).rejects.toThrow('NOT_FOUND');
  });
});
