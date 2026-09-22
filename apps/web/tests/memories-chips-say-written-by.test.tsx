/**
 * memories-chips-say-written-by.test.tsx — issue #420.
 *
 * La rangée de pastilles d'agents de la page Mémoire filtre par AUTEUR (l'agent
 * qui a appelé `save_memory`) et rien d'autre : la mémoire est celle de
 * l'espace, chaque agent lit le même bassin, aucune action n'attribue un fait
 * à un agent. Sans mot pour le dire, une rangée de noms d'agents au-dessus
 * d'une liste de faits se lisait comme une répartition, et le propriétaire
 * concluait qu'on pouvait donner des faits à un agent.
 *
 * Ce que ce test prouve : l'écran DIT « Written by », la pastille par défaut
 * dit « Anyone », et une pastille ne porte que le nom d'un agent qui a écrit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), success: vi.fn(), message: vi.fn() },
}));

vi.mock('@/lib/actions', () => ({
  searchMemoriesAction: vi.fn(),
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

const ligne = (id: string, fact: string, agent: { id: string; name: string } | null) => ({
  id,
  entity_id: 'e1',
  agent_id: agent?.id ?? null,
  agentName: agent?.name ?? null,
  agentSlug: agent ? agent.name.toLowerCase() : null,
  fact,
  category: 'context',
  importance: 3,
  importance_locked: false,
  archived: false,
  skill_tags: [],
  source: agent ? 'agent' : 'manual',
  access_count: 0,
  last_accessed_at: null,
  created_at: new Date('2026-09-01T10:00:00Z').toISOString(),
  updated_at: new Date('2026-09-01T10:00:00Z').toISOString(),
});

const RESEARCHER = { id: 'a-researcher', name: 'Researcher' };
const ALFRED = { id: 'a-alfred', name: 'Alfred' };
const ITEMS = [
  ligne('m1', 'The client is called Dupont.', RESEARCHER),
  ligne('m2', 'Quentin prefers short replies.', null),
];

let conteneur: HTMLDivElement;
let racine: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  conteneur = document.createElement('div');
  document.body.appendChild(conteneur);
  racine = createRoot(conteneur);
});

afterEach(async () => {
  await act(async () => racine.unmount());
  conteneur.remove();
});

describe('la rangée d’agents de la page Mémoire dit qu’elle filtre par auteur (#420) @cap:se-souvenir/ecran', () => {
  it('l’écran dit « Written by », la pastille par défaut « Anyone », et seul l’agent qui a écrit a sa pastille', async () => {
    await act(async () => {
      racine.render(
        <MemoriesClient
          // eslint-disable-next-line @typescript-eslint/no-explicit-any -- la ligne de test est une MemoryListRow au sens structurel ; la typer exigerait d'importer le type depuis le module mocké.
          initialItems={ITEMS as any}
          agents={[RESEARCHER, ALFRED] as never}
          totalCount={ITEMS.length}
        />,
      );
    });

    const rangee = Array.from(conteneur.querySelectorAll('span')).find(
      (s) => s.textContent === 'Written by',
    );
    expect(rangee, 'le libellé « Written by » manque').toBeTruthy();

    const pastilles = Array.from(rangee!.parentElement!.querySelectorAll('button')).map(
      (b) => b.textContent ?? '',
    );
    // La première dit « Anyone » avec le total ; jamais « All agents », qui
    // laissait entendre que chaque agent avait sa part.
    expect(pastilles[0]).toContain('Anyone');
    expect(pastilles[0]).toContain(String(ITEMS.length));
    expect(pastilles.join(' ')).not.toContain('All agents');
    // Researcher a écrit un fait : sa pastille est là. Alfred n'a rien écrit :
    // pas de pastille, parce qu'une pastille dit « a écrit », pas « existe ».
    expect(pastilles.some((p) => p.includes('Researcher'))).toBe(true);
    expect(pastilles.some((p) => p.includes('Alfred'))).toBe(false);
  });
});
