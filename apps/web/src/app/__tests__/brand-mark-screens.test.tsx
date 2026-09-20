// brand-mark-screens.test.tsx — LA MARQUE SUR LES ÉCRANS QUE LE RAIL NE COUVRE
// PAS (#308, Reviewer C, passe 1).
//
// La première écriture de cette PR ne prouvait que deux endroits sur six : le
// rail et la barre mobile (`components/__tests__/Sidebar.test.tsx`). Les quatre
// autres — la page de connexion, le bandeau de confiance locale, les deux
// marques de l'accueil, et l'icône de l'onglet — pouvaient revenir au losange,
// à l'invite de terminal ou à rien sans qu'un seul test rougisse. C'est le
// constat mineur n°3 de la revue, et il était juste.
//
// Chaque cas monte le VRAI composant et lit le DOM rendu ; l'onglet, lui, se lit
// dans l'objet `metadata` que Next consomme, qui est le résultat réel de ce
// côté-là.
//
// ⚠️ LE CHEMIN DU FICHIER EST ÉCRIT EN TOUTES LETTRES. Comparé à `LOGO_SRC`,
// le test se comparerait à lui-même : changer le fichier dans `BrandMark`
// changerait les deux côtés de l'assertion, et la mutation resterait verte.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { createElement, type ReactElement, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/** Le dessin du produit, tel qu'il est servi. Écrit ici, pas importé. */
const FICHIER = '/logo-128.png';

// `next/font` ne tourne qu'a travers le compilateur de Next : importe tel quel
// dans un test, `Inter(...)` n'est pas une fonction. Le faux rend ce que le
// layout lui demande - une variable de police - et rien d'autre.
vi.mock('next/font/google', () => ({
  Inter: () => ({ variable: 'font-inter-test' }),
  JetBrains_Mono: () => ({ variable: 'font-jetbrains-test' }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  usePathname: () => '/login',
  useSearchParams: () => new URLSearchParams(''),
}));
vi.mock('next/link', () => ({
  default: ({ children, href, ...rest }: { children: ReactNode; href: string }) =>
    createElement('a', { href, ...rest }, children),
}));
// Les écrans montés appellent chacun leurs actions serveur au clic. Aucun cas
// ne clique : les faux sont là pour que le module se charge, pas pour répondre.
vi.mock('@/lib/actions.ts', () => ({
  claimOwnerAccountAction: vi.fn(),
  createLlmKeyAction: vi.fn(),
  updateLlmKeyAction: vi.fn(),
  listLlmKeysAction: vi.fn(async () => ({ ok: true, data: [] })),
  testLlmKeyAction: vi.fn(),
  createAgentAction: vi.fn(),
  listSkillsAction: vi.fn(async () => ({ ok: true, data: [] })),
  assignSkillAction: vi.fn(),
  codeTaskDoctorAction: vi.fn(),
  createConversationAction: vi.fn(),
  sendChatMessageAction: vi.fn(),
  createMemoryAction: vi.fn(),
  setWorkspaceTimezoneAction: vi.fn(),
  setRootAgentAction: vi.fn(),
}));

import AuthLoginForm from '../login/AuthLoginForm.tsx';
import LocalTrustBanner from '../login/LocalTrustBanner.tsx';
import OnboardingFlow from '../onboarding/OnboardingFlow.tsx';
import { metadata } from '../layout.tsx';
import { LOGO_SRC } from '@/components/ui/BrandMark';

let container: HTMLDivElement;
let root: Root;

async function render(node: ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

/** La source d'une image, telle qu'elle est après la réécriture de next/image. */
function sourceDeLaMarque(): string {
  const image = container.querySelector('img[alt=""]');
  if (image === null) throw new Error('aucune marque sur cet écran');
  return decodeURIComponent(image.getAttribute('src') ?? '');
}

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = '';
});

describe("la marque sur l'écran de connexion", () => {
  it('remplace l’invite de terminal par le logo et le nom', async () => {
    await render(<AuthLoginForm setup="ready" openSignup={false} />);
    expect(sourceDeLaMarque()).toContain(FICHIER);
    expect(container.textContent).toContain('Nodal-Agents');
    // L'INVITE EST PARTIE. « $ nodal-agents » disait « un outil en ligne de
    // commande » sur la première page qu'une personne voit du produit.
    expect(container.textContent).not.toContain('$');
    expect(container.textContent).not.toContain('nodal-agents');
  });

  it('porte la même marque sur le bandeau de confiance locale', async () => {
    await render(<LocalTrustBanner />);
    expect(sourceDeLaMarque()).toContain(FICHIER);
    // Le mot « nodal-agents » en minuscules reste dans le paragraphe qui parle
    // de la commande `nodal-agents init` : c'est une COMMANDE, pas une marque.
    // Ce qui est vérifié ici, c'est qu'il n'est plus le titre de la page.
    const titre = container.querySelector('h1');
    expect(titre?.textContent).toBe('Local mode active');
  });
});

describe("la marque sur l'accueil du premier lancement", () => {
  it('remplace le losange de la carte de bienvenue', async () => {
    await render(<OnboardingFlow />);
    expect(sourceDeLaMarque()).toContain(FICHIER);
    expect(container.textContent).toContain('Welcome to Nodal-Agents');
    // LE LOSANGE EST PARTI de la carte de bienvenue. Le second, celui du voile
    // de fin, n'est dessiné que pendant `finishing` : ce cas ne l'atteint pas,
    // et le dire vaut mieux que laisser croire qu'il le couvre.
    expect(container.textContent).not.toContain('◆');
  });
});

describe("la marque dans l'onglet du navigateur", () => {
  it('donne au navigateur le même fichier que les écrans', () => {
    // Le produit n'avait AUCUNE icône : l'onglet portait la page blanche par
    // défaut, et un onglet sans dessin ne se retrouve pas dans une rangée de
    // vingt.
    expect(metadata.icons).toEqual({ icon: FICHIER });
    expect(metadata.title).toBe('Nodal-Agents');
    // Et la constante partagée désigne bien ce fichier-là.
    expect(LOGO_SRC).toBe(FICHIER);
  });
});
