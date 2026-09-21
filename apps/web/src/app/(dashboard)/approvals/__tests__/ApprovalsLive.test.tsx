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
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

/** La SOURCE de la page, depuis la racine du paquet ou celle du dépôt. */
function lirePage(): string {
  const relatif = join('src', 'app', '(dashboard)', 'approvals', 'page.tsx');
  for (const racine of [process.cwd(), join(process.cwd(), 'apps', 'web')]) {
    const chemin = join(racine, relatif);
    if (existsSync(chemin)) return readFileSync(chemin, 'utf8');
  }
  throw new Error('page.tsx introuvable depuis ' + process.cwd());
}

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

async function monter(initial: PendingApproval[], servi?: string[]): Promise<void> {
  const cible = document.createElement('div');
  document.body.appendChild(cible);
  container = cible;
  const racine = createRoot(cible);
  root = racine;
  await act(async () => {
    racine.render(
      <ApprovalsProvider initial={initial}>
        <ApprovalsLive {...(servi === undefined ? {} : { servi })} />
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

  it('RELIT TOUT DE SUITE si le serveur a rendu un AUTRE ensemble', async () => {
    // La fenêtre entre le rendu serveur et le montage (Reviewer C) : la demande
    // est arrivée pendant ce trajet, le provider la connaît déjà, et la page
    // dessinée ne la porte pas. Sans `servi`, les deux côtés se seraient
    // accordés sur un ensemble que la page n'a jamais montré.
    //
    // Mutation vérifiée : `servi` ignoré dans `ApprovalsLive` (la référence
    // repart de la signature courante) → ce cas rougit.
    await monter([attente('deja-la'), attente('arrivee-entre-temps')], ['deja-la']);
    expect(routerRefresh).toHaveBeenCalled();
  });

  it('ne relit PAS quand le serveur a rendu le MÊME ensemble', async () => {
    await monter([attente('a1')], ['a1']);
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('la PAGE le monte vraiment, et lui donne ce qu’elle a rendu', async () => {
    // Le trou de harnais que Reviewer C a nommé : les cas ci-dessus montent le
    // composant eux-mêmes, si bien qu'un `ApprovalsLive` parfait mais jamais
    // branché les laissait tous verts — c'est-à-dire le défaut de départ.
    //
    // La page est un composant SERVEUR asynchrone qui lit la base : la monter
    // ici ne prouverait rien de plus que ce que ses doublures rendraient. Ce
    // qui se vérifie, et qui suffit, c'est qu'elle le rende.
    // Le chemin part du dossier de travail, pas d'`import.meta.url` : sous
    // vitest, ce dernier n'est pas une URL de fichier, et sous Windows son
    // `pathname` rend « /D:/… », que `readFileSync` n'ouvre pas. Les deux
    // racines possibles sont celle du paquet et celle du dépôt.
    const source = lirePage();
    expect(source).toContain('<ApprovalsLive');
    // Et qu'elle lui passe ce qu'elle a dessiné, sur la liste des attentes.
    expect(source).toContain('servi: result.data.map((a) => a.id)');
  });

  it('la signature ne dépend pas de l’ORDRE des lignes', async () => {
    // La lecture range par date ; deux lectures du même ensemble ne doivent pas
    // se lire comme un changement.
    expect(signatureDesAttentes(['b', 'a'])).toBe(signatureDesAttentes(['a', 'b']));
    expect(signatureDesAttentes(['a'])).not.toBe(signatureDesAttentes(['b']));
  });
});
