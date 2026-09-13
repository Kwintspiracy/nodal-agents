// CredentialWizardScopeDisclosure.test.tsx — issue #83.
//
// Ce qui se prouve : sur une installation NEUVE, la carte « Google Drive »
// n'ouvre pas le formulaire d'ajout, elle ouvre directement l'assistant
// d'identifiants (`needsWizard`, ConnectorsMarketplaceGrid). Jusqu'au
// 2026-09-14 cet assistant ne disait rien de la portée du jeton : le seul
// utilisateur à qui l'avertissement servait — celui qui n'a encore rien
// accordé — passait d'« Install » à l'écran de Google sans l'avoir lu.
//
// Le e2e `connector-scope-disclosure.spec.ts` le voit à l'écran ; ici on le
// voit dans le HTML, sans navigateur, pour que la mesure nocturne ne soit pas
// le premier endroit où ça se sait.
//
// Rendu dans jsdom (l'assistant est une Modal en portail : un rendu serveur
// statique ne produirait rien) et on lit le texte réel, pas des compteurs.

import { describe, it, expect, afterEach } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import CredentialWizard from '../CredentialWizard.tsx';

const DRIVE_DISCLOSURE =
  'Grants access to your ENTIRE Google Drive — every file, read and write — not only the files agents create.';

let container: HTMLDivElement;
let root: Root;

async function render(node: React.ReactElement): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(node);
  });
}

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('CredentialWizard — portée du jeton avant le départ chez le fournisseur', () => {
  it('affiche la divulgation du connecteur sur le chemin « aucun identifiant ⇒ assistant »', async () => {
    await render(
      <CredentialWizard
        initialType="google-oauth"
        returnToConnectorSlug="google-drive"
        scopeDisclosure={DRIVE_DISCLOSURE}
        onClose={() => {}}
      />,
    );

    const text = document.body.textContent ?? '';
    expect(text).toContain('What this connector can reach');
    expect(text).toContain('ENTIRE Google Drive');
    // Elle est lisible AVANT le bouton qui part chez Google, pas après.
    expect(text.indexOf('What this connector can reach')).toBeLessThan(
      text.indexOf('Continue with Google'),
    );
  });

  it("ne dit rien quand la portée du connecteur n'excède pas son nom", async () => {
    // Gmail ne demande que readonly + send : une bannière ici serait du bruit,
    // et le bruit est ce qui apprend à sauter la bannière qui compte.
    await render(
      <CredentialWizard
        initialType="google-oauth"
        returnToConnectorSlug="gmail"
        onClose={() => {}}
      />,
    );

    expect(document.body.textContent ?? '').not.toContain('What this connector can reach');
  });

  it("ne dit rien quand l'assistant est ouvert hors de tout connecteur", async () => {
    // Depuis la page Credentials, aucun connecteur n'est en jeu : il n'y a pas
    // de portée à annoncer, et l'étape 1 est un simple choix de fournisseur.
    await render(<CredentialWizard onClose={() => {}} />);

    expect(document.body.textContent ?? '').not.toContain('What this connector can reach');
  });
});
