// ProjectVerificationPanel.test.tsx — ce que l'écran DIT des commandes de preuve.
//
// Le sujet n'est pas cosmétique. Ce panneau demandait à l'utilisateur des
// commandes qu'il n'a aucune raison de connaître — « je sais pas quelle
// commande, je sais pas ce qu'il faut taper » (08/09/2026) — et personne ne les
// a jamais remplies : 0 preuve produite sur la base de référence depuis
// l'origine. C'est l'agent qui construit qui déclare, désormais ; l'écran doit
// le dire, et ne plus reprocher un champ vide.
//
// Rendu statique côté serveur : on lit le HTML.

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ProjectVerificationPanel from '../ProjectVerificationPanel.tsx';
import type { ProjectVerification } from '../ProjectVerificationPanel.tsx';

const COMMANDES = [{ command: 'node --check app.js', timeoutSeconds: 60 }];

function rendu(verification: ProjectVerification | null): string {
  return renderToStaticMarkup(
    <ProjectVerificationPanel
      projectPath="C:/Users/kwint/Documents/Dev/recipes-app"
      verification={verification}
      isOwner
      onPrefsReloaded={() => {}}
    />,
  );
}

describe('ProjectVerificationPanel — ce que l’écran dit', () => {
  it('rien de déclaré : l’écran n’ACCUSE pas, il explique qui déclarera', () => {
    const html = rendu({
      verifyCommands: null,
      verifyApprovedAt: null,
      verifyManifestHash: null,
      verifyStatus: 'not_configured',
      verifySource: null,
    });

    expect(html).toContain('Nothing declared yet');
    // UNE ligne depuis le 19/09, pas un paragraphe : dans un panneau de 400 px
    // on ne lisait pas les trois phrases, et elles repoussaient les commandes
    // hors de l'écran. Ce qu'elles disaient de plus vit en commentaire. Ce
    // qui RESTE est le fond : l'écran n'accuse pas, il nomme qui déclarera.
    expect(html).toContain('declares how to check its own work');
    // L'ancien libellé disait « Not configured » — un reproche adressé à qui
    // n'avait rien à configurer.
    expect(html).not.toContain('Not configured');
  });

  it('déclaré par l’agent : l’écran le DIT, et ne parle pas d’approbation', () => {
    const html = rendu({
      verifyCommands: COMMANDES,
      verifyApprovedAt: new Date('2026-09-08T13:50:00Z'),
      verifyManifestHash: 'h',
      verifyStatus: 'approved',
      verifySource: 'agent',
    });

    expect(html).toContain('Declared by the agent');
    expect(html).toContain('The agent that built this project declared these commands');
    // Le point qui compte : ne pas présenter comme le choix du propriétaire ce
    // qu'il n'a pas décidé. La preuve s'exécute pareil ; c'est le MOT qui
    // change.
    expect(html).not.toContain('>Approved ');
  });

  it('saisi par le propriétaire : le mot « Approved » reste le sien', () => {
    const html = rendu({
      verifyCommands: COMMANDES,
      verifyApprovedAt: new Date('2026-09-08T13:50:00Z'),
      verifyManifestHash: 'h',
      verifyStatus: 'approved',
      verifySource: 'owner',
    });

    expect(html).toContain('Approved');
    expect(html).not.toContain('Declared by the agent');
  });

  it('la commande déclarée est LISIBLE, pas seulement comptée', () => {
    const html = rendu({
      verifyCommands: COMMANDES,
      verifyApprovedAt: new Date('2026-09-08T13:50:00Z'),
      verifyManifestHash: 'h',
      verifyStatus: 'approved',
      verifySource: 'agent',
    });
    expect(html).toContain('node --check app.js');
  });
});

// ─── La COULEUR de la pastille d'état (#181) ────────────────────────────────

/** La pastille d'état seule, prise dans le rendu par son `data-testid`. */
function pastilleEtat(verification: ProjectVerification | null): HTMLElement {
  document.body.innerHTML = rendu(verification);
  const hote = document.querySelector('[data-testid="verify-status"]');
  const tag = hote?.firstElementChild;
  if (!(tag instanceof HTMLElement)) throw new Error('the status tag is not rendered');
  return tag;
}

describe('ProjectVerificationPanel — une couleur ne contredit pas son mot @cap:verifier-un-livrable/ecran', () => {
  // Les deux verdicts positifs portaient `tone="skill"`, la couleur de
  // l'entité Skill : un orange-rouge. « Approved » s'affichait donc dans la
  // teinte que le reste de l'écran garde pour ce qui alerte.
  const ACQUIS = {
    verifyCommands: COMMANDES,
    verifyApprovedAt: new Date('2026-09-08T13:50:00Z'),
    verifyManifestHash: 'h',
    verifyStatus: 'approved' as const,
  };

  it('« Approved » est VERT, et d’aucune couleur d’alerte', () => {
    const tag = pastilleEtat({ ...ACQUIS, verifySource: 'owner' });
    expect(tag.textContent).toContain('Approved');
    expect(tag.className).toContain('text-ok');
    expect(tag.className).toContain('bg-ok-bg');
    expect(tag.className).not.toContain('skill');
    expect(tag.className).not.toContain('text-err');
    expect(tag.className).not.toContain('text-warn');
  });

  it('« Declared by the agent » l’est aussi : c’est la PROVENANCE qui change, pas l’état', () => {
    const tag = pastilleEtat({ ...ACQUIS, verifySource: 'agent' });
    expect(tag.textContent).toContain('Declared by the agent');
    expect(tag.className).toContain('text-ok');
    expect(tag.className).not.toContain('skill');
  });

  it('ce qui n’est PAS acquis garde sa couleur : ambre en attente, neutre sans rien', () => {
    const attente = pastilleEtat({
      verifyCommands: COMMANDES,
      verifyApprovedAt: null,
      verifyManifestHash: 'h',
      verifyStatus: 'pending_approval',
      verifySource: 'agent',
    });
    expect(attente.textContent).toContain('Needs your approval');
    expect(attente.className).toContain('text-warn');
    expect(attente.className).not.toContain('text-ok');

    const rien = pastilleEtat({
      verifyCommands: null,
      verifyApprovedAt: null,
      verifyManifestHash: null,
      verifyStatus: 'not_configured',
      verifySource: null,
    });
    expect(rien.textContent).toContain('Nothing declared yet');
    expect(rien.className).toContain('text-ink-3');
    expect(rien.className).not.toContain('text-ok');
  });
});
