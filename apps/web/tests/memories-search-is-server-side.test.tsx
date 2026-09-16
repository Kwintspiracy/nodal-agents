// @vitest-environment jsdom
/**
 * La recherche de la page Mémoire va bien AU SERVEUR — preuve de moteur.
 *
 * Pourquoi ce fichier existe (revue de la PR #113, constat majeur) : le
 * parcours `memory-kept.spec.ts` tapait « clarinet », un mot littéralement
 * présent dans le fait, et affirmait aussitôt. Or `MemoriesClient` filtre
 * INSTANTANÉMENT la page déjà chargée par sous-chaîne, et n'appelle
 * `searchMemoriesAction` qu'après 300 ms. Les deux assertions passaient donc
 * sur le filtre client : casser la recherche serveur laissait le parcours
 * VERT. Un test qui reste vert quand la chose qu'il prouve est débranchée ne
 * prouve rien.
 *
 * Ce que ce test épingle, et que le filtre client ne peut PAS produire : une
 * forme fléchie — « clarinets » — absente du fait, que seul le FTS `english`
 * de Postgres ramène par racinisation (prouvé côté base dans
 * `packages/memory/src/tests/search.test.ts`). Si l'action serveur échoue, la
 * ligne n'apparaît jamais.
 *
 * C'est aussi ce que le parcours e2e vérifie désormais, à l'écran.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const searchMemoriesAction = vi.fn();
const toastError = vi.fn();

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), message: vi.fn() },
}));

vi.mock('@/lib/actions', () => ({
  searchMemoriesAction: (...args: unknown[]) => searchMemoriesAction(...args),
  archiveMemoryAction: vi.fn(),
  unarchiveMemoryAction: vi.fn(),
  deleteMemoryAction: vi.fn(),
  updateMemoryImportanceAction: vi.fn(),
  unpinMemoryImportanceAction: vi.fn(),
  createMemoryAction: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));

const { default: MemoriesClient } =
  await import('../src/app/(dashboard)/memories/MemoriesClient.tsx');

/** Le fait cherché porte « clarinet » au SINGULIER — jamais « clarinets ». */
const FAIT = 'Quentin plays the clarinet on Sunday mornings.';
const AUTRE = 'Quentin bakes sourdough on Saturdays.';
/** La forme tapée dans la boîte. Aucune sous-chaîne des deux faits. */
const RECHERCHE = 'clarinets';

const ligne = (id: string, fact: string) => ({
  id,
  entity_id: 'e1',
  agent_id: null,
  agentName: null,
  agentSlug: null,
  fact,
  category: 'context',
  importance: 3,
  importance_locked: false,
  archived: false,
  skill_tags: [],
  source: 'manual',
  access_count: 0,
  last_accessed_at: null,
  created_at: new Date('2026-09-01T10:00:00Z').toISOString(),
  updated_at: new Date('2026-09-01T10:00:00Z').toISOString(),
});

const ITEMS = [ligne('m1', FAIT), ligne('m2', AUTRE)];

let conteneur: HTMLDivElement;
let racine: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  searchMemoriesAction.mockReset();
  toastError.mockReset();
  conteneur = document.createElement('div');
  document.body.appendChild(conteneur);
  racine = createRoot(conteneur);
});

afterEach(async () => {
  await act(async () => racine.unmount());
  conteneur.remove();
});

/** Rend la page, tape la recherche, laisse passer le débounce ET l'aller-retour. */
async function chercher(quoi: string): Promise<void> {
  await act(async () => {
    racine.render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- la ligne de test est une MemoryListRow au sens structurel ; la typer exigerait d'importer le type depuis le module mocké.
      <MemoriesClient initialItems={ITEMS as any} agents={[]} totalCount={ITEMS.length} />,
    );
  });

  // PAR LE PLACEHOLDER, et pas `input[type=search]` : `PageShell` rend aussi la
  // barre de recherche globale de l'application, qui vient EN PREMIER dans le
  // document. La viser tapait à côté sans rien casser — le test restait muet.
  const champ = conteneur.querySelector(
    'input[placeholder="Search memories…"]',
  ) as HTMLInputElement;
  expect(champ).toBeTruthy();

  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(champ, quoi);
    champ.dispatchEvent(new Event('input', { bubbles: true }));
  });

  // 300 ms de débounce, puis la promesse de l'action. Des temps RÉELS : le
  // point du test est que le résultat vient d'ailleurs que du rendu courant.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
}

describe('la recherche de la page Mémoire interroge le SERVEUR @cap:se-souvenir/moteur', () => {
  it('une forme fléchie absente du texte n’est trouvée que par la recherche serveur', async () => {
    searchMemoriesAction.mockResolvedValue({ ok: true, data: [ligne('m1', FAIT)] });

    await chercher(RECHERCHE);

    expect(searchMemoriesAction).toHaveBeenCalledWith(RECHERCHE);
    // La ligne est là — et le filtre client ne pouvait pas la produire :
    // « clarinets » n'est une sous-chaîne d'aucun des deux faits.
    expect(conteneur.textContent).toContain(FAIT);
    expect(conteneur.textContent).not.toContain(AUTRE);
  });

  it('recherche serveur CASSÉE ⇒ la ligne n’apparaît jamais (la mutation)', async () => {
    searchMemoriesAction.mockResolvedValue({
      ok: false,
      code: 'db_error',
      message: 'Failed to search memories',
    });

    await chercher(RECHERCHE);

    expect(toastError).toHaveBeenCalled();
    // Le filtre client, seul, ne trouve rien : c'est exactement ce que le
    // parcours e2e voit désormais, et pourquoi il devient rouge.
    expect(conteneur.textContent).not.toContain(FAIT);
    expect(conteneur.textContent).toContain('No memories match these filters.');
  });

  it('le filtre client seul ne connaît pas la forme fléchie', async () => {
    // Même page, même mot, mais l'action ne répond jamais : tant qu'elle n'a
    // pas répondu, l'écran n'a QUE le filtre par sous-chaîne — et il est vide.
    searchMemoriesAction.mockImplementation(() => new Promise(() => {}));

    await chercher(RECHERCHE);

    expect(conteneur.textContent).not.toContain(FAIT);
    expect(conteneur.textContent).not.toContain(AUTRE);
  });
});
