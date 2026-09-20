// NewConversationScreen.test.tsx — l'écran d'une conversation qui n'a pas
// encore commencé (#248, cadre Figma `398:3917`).
//
// Ce qui se prouve : la planche est bien là (l'en-tête du fil, l'accueil
// centré, la saisie de 760 px, la barre d'état), il n'y a AUCUNE ligne de fil,
// et l'écran ne date pas une conversation qui n'existe pas. Le cas sans ROOT
// est le seul où la saisie disparaît — un champ qui échouerait à l'envoi
// mentirait (invariant #4).

import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NewConversationScreen from '../NewConversationScreen.tsx';

// La saisie et la barre d'état appellent `useRouter` / `useState` : un rendu
// statique n'a pas de routeur monté. Ce qui est en jeu ici est ce que l'écran
// MONTRE, jamais la navigation.
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

const alfred = { id: 'a-1', name: 'Alfred', avatarUrl: null };

describe('NewConversationScreen @cap:parler-a-un-agent/ecran', () => {
  it('accueille la personne par son prénom, au-dessus de la saisie', () => {
    const html = renderToStaticMarkup(
      <NewConversationScreen accountName="Quentin Beau" root={alfred} />,
    );
    expect(html).toContain('Hey Quentin, what are we building today?');
    // La saisie de la planche : une zone de texte, son indication, 760 px.
    expect(html).toContain('What are we doing today?');
    expect(html).toContain('<textarea');
    expect(html).toContain('max-w-[760px]');
    expect(html).toContain('Send');
  });

  it('sans nom connu, l’accueil ne fabrique personne', () => {
    const html = renderToStaticMarkup(<NewConversationScreen accountName={null} root={alfred} />);
    expect(html).toContain('Hey, what are we building today?');
    // Et surtout pas l'adresse du compte local transformée en prénom.
    expect(html).not.toContain('local');
  });

  it('porte l’en-tête du fil : l’agent, « Untitled », et d’où ça vient', () => {
    const html = renderToStaticMarkup(
      <NewConversationScreen accountName="Quentin" root={alfred} />,
    );
    expect(html).toContain('Alfred · Untitled');
    expect(html).toContain('from the dashboard');
    // Le fil n'a PAS commencé : l'en-tête ne le date pas (inv. #4).
    expect(html).not.toContain('started ');
  });

  it('rien ne s’est encore passé : aucun tour, aucune preuve, aucun coût', () => {
    const html = renderToStaticMarkup(
      <NewConversationScreen accountName="Quentin" root={alfred} />,
    );
    // La barre d'état dit ce qu'elle sait, c'est-à-dire rien.
    expect(html).toContain('no proof');
    expect(html).toContain('no usage recorded');
    // Pas de pile de visages : personne n'a travaillé ici.
    expect(html).not.toContain('agents</span>');
    // Et aucune carte de fil.
    expect(html).not.toContain('data-testid="pending-turn"');
  });

  it('l’accueil et la saisie sont CENTRÉS dans le vide, pas collés en bas', () => {
    const html = renderToStaticMarkup(
      <NewConversationScreen accountName="Quentin" root={alfred} />,
    );
    // La colonne du milieu : centrée en largeur, posée au tiers de la hauteur
    // (`pt-[30vh]`, 20/09), et c'est elle qui prend la place libre.
    expect(html).toMatch(/class="[^"]*flex-1[^"]*items-center[^"]*justify-start[^"]*pt-\[30vh\]/);
    // Display/28 de la planche pour l'accueil.
    expect(html).toContain('text-display-28');
  });

  it('un projet porté : le dossier reste à un clic, et la saisie est là', () => {
    const html = renderToStaticMarkup(
      <NewConversationScreen
        accountName="Quentin"
        root={alfred}
        project={{ id: 'p-1', name: 'Nodal' }}
      />,
    );
    expect(html).toContain('/spaces/p-1/files');
    expect(html).toContain('<textarea');
  });

  it('sans ROOT désigné : pas de saisie du tout, et le geste qui débloque', () => {
    const html = renderToStaticMarkup(<NewConversationScreen accountName="Quentin" root={null} />);
    expect(html).toContain('No ROOT agent yet.');
    expect(html).toContain('href="/agents"');
    // Un champ qui échouerait à l'envoi serait un mensonge.
    expect(html).not.toContain('<textarea');
    expect(html).not.toContain('What are we doing today?');
    // L'accueil, lui, reste : l'écran n'est pas vide de sens pour autant.
    expect(html).toContain('Hey Quentin, what are we building today?');
  });
});
