// @vitest-environment node
/**
 * PrimaryButton — l'état disabled doit se VOIR.
 *
 * Vécu (24/08, modale Add worker) : le bouton « Add » désactivé était
 * pixel-identique à un bouton actif — cliquer ne faisait rien, sans indice.
 * L'atome n'avait AUCUNE classe disabled. Ce test rend le vrai composant
 * (react-dom/server) et épingle : l'attribut disabled est posé ET les classes
 * qui le rendent visible (opacity) et inerte (pointer-events) sont présentes.
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import PrimaryButton from '../src/components/ui/PrimaryButton.tsx';

describe('PrimaryButton disabled', () => {
  it('un bouton désactivé porte l’attribut ET les classes qui le montrent', () => {
    const html = renderToStaticMarkup(
      <PrimaryButton variant="ink" disabled>
        Add
      </PrimaryButton>,
    );
    expect(html).toContain('disabled');
    expect(html).toContain('disabled:opacity-40');
    expect(html).toContain('disabled:pointer-events-none');
  });

  it('un bouton actif ne porte pas l’attribut disabled', () => {
    const html = renderToStaticMarkup(<PrimaryButton variant="ink">Add</PrimaryButton>);
    expect(html).not.toContain('disabled="');
  });
});
