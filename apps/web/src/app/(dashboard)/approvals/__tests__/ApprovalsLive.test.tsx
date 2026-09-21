// ApprovalsLive.test.tsx — la page des approbations suit le provider de la
// barre, et ne se relit que lorsque les attentes CHANGENT.
//
// Le défaut que ce fichier ferme (Quentin, 22/09/2026) : le rail disait
// « Approvals 1 » et la page « 0 pending approvals ». La page est rendue par le
// serveur et ne se rafraîchissait qu'à la navigation.
//
// Ce que ces cas éprouvent : le composant monté par la page, DANS le provider
// que la barre lit, avec la lecture du provider sous la main. Le seul effet
// observable d'un rafraîchissement de route est l'appel au routeur — rien n'en
// sort côté DOM, la page étant rendue ailleurs.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: routerRefresh, push: () => {} }),
}));
vi.mock('@/lib/actions', () => ({ listApprovalsAction: vi.fn() }));

import { ApprovalsProvider, type PendingApproval } from '@/components/ApprovalsProvider';
import { listApprovalsAction } from '@/lib/actions';
import ApprovalsLive, { signatureDesAttentes } from '../ApprovalsLive.tsx';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

/** Une attente, réduite à ce que le provider en garde. */
function attente(id: string): PendingApproval {
  return {
    id,
    jobId: `job-${id}`,
    toolName: 'send_message',
    agentName: 'Reviewer C',
    toolInput: {},
    requestedAt: null,
    jobChannel: 'dashboard',
    conversationChannel: 'dashboard',
  };
}

/** Ce que la LECTURE du provider rendra au prochain tour. */
function laLectureRend(ids: string[]): void {
  // Le provider ne garde que les champs de `PendingApproval` ; la ligne
  // complète du serveur en porte d'autres, dont ces cas n'ont que faire.
  vi.mocked(listApprovalsAction).mockResolvedValue({
    ok: true,
    data: ids.map(attente),
  } as unknown as Awaited<ReturnType<typeof listApprovalsAction>>);
}

async function monter(initial: PendingApproval[]): Promise<void> {
  const cible = document.createElement('div');
  document.body.appendChild(cible);
  container = cible;
  const racine = createRoot(cible);
  root = racine;
  await act(async () => {
    racine.render(
      <ApprovalsProvider initial={initial}>
        <ApprovalsLive />
      </ApprovalsProvider>,
    );
  });
}

/** Jouer UN tour de cadence de la barre. */
async function unTourDeCadence(): Promise<void> {
  await act(async () => {
    vi.advanceTimersByTime(15_000);
  });
  // La lecture est asynchrone : le tour suivant de la file la laisse répondre.
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  laLectureRend([]);
});

afterEach(async () => {
  const racine = root;
  const cible = container;
  root = null;
  container = null;
  if (racine) {
    await act(async () => {
      racine.unmount();
    });
  }
  cible?.remove();
  vi.useRealTimers();
});

describe('la page des approbations suit la barre @cap:approuver-une-action/ecran', () => {
  it('NE RELIT PAS la page au montage : le serveur vient de la rendre', async () => {
    await monter([attente('a1')]);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('RELIT la page quand une demande ARRIVE pendant qu’on la regarde', async () => {
    // Le cas de Quentin, dans l'autre sens : la page affiche zéro, une demande
    // arrive, et la page doit la montrer sans recharger.
    //
    // Mutation vérifiée : l'appel à `router.refresh()` retiré de
    // `ApprovalsLive` → ce cas rougit.
    await monter([]);
    laLectureRend(['ac831e76']);
    await unTourDeCadence();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('RELIT la page quand une demande PART, répondue ailleurs', async () => {
    await monter([attente('ac831e76')]);
    laLectureRend([]);
    await unTourDeCadence();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('NE RELIT PAS quand les attentes sont les mêmes', async () => {
    // Relire toutes les quinze secondes pour redessiner les mêmes lignes ferait
    // clignoter la page sous les yeux de quelqu'un qui lit une demande.
    await monter([attente('a1')]);
    laLectureRend(['a1']);
    await unTourDeCadence();
    await unTourDeCadence();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('relit quand une demande en REMPLACE une autre, à compte égal', async () => {
    // Le compte ne suffit pas : une répondue et une arrivée dans le même tour
    // laissent le nombre à un, et la page garderait la PREMIÈRE sous les yeux.
    //
    // Mutation vérifiée : la signature réduite à `pending.length` → ce cas
    // rougit, les autres restent verts.
    await monter([attente('a1')]);
    laLectureRend(['a2']);
    await unTourDeCadence();
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('la signature ne dépend pas de l’ORDRE des lignes', async () => {
    // La lecture range par date ; deux lectures du même ensemble ne doivent pas
    // se lire comme un changement.
    expect(signatureDesAttentes(['b', 'a'])).toBe(signatureDesAttentes(['a', 'b']));
    expect(signatureDesAttentes(['a'])).not.toBe(signatureDesAttentes(['b']));
  });
});
