// faits.test.mjs — le portail vérifie, il ne répète pas.
//
// Le 12/09/2026 un agent a ouvert l'issue #68 « Publish 0.8.9 » DE MÉMOIRE,
// alors que 0.8.9 était sur npm depuis le 09/09. Le portail l'a affichée quatre
// jours comme un travail à faire, et personne n'avait de quoi le contredire.
// Quentin : « je ne peux ni avoir confiance en toi ni dans mon dashboard ».
//
// Deux mécanismes sortent de là, et ils sont prouvés ici :
//   1. l'état de la release est LU (npm + git), jamais raconté ;
//   2. une carte ouverte écrite par un agent doit porter ses faits vérifiés.

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  cartesDuTableau,
  fusionnerTableauGitHub,
  comparerSemver,
  ecartsDe,
  ecritParUnAgent,
  etatDeLaRelease,
  porteDesFaitsVerifies,
  publicationsDejaFaites,
  sansFaitsVerifies,
} from './lib.mjs';

// ─── 1. L'état de la release ──────────────────────────────────────────────────

describe('etatDeLaRelease', () => {
  const depot = { version: '0.8.10', dernierTag: 'v0.8.9', commitsDepuisLeTag: 14 };

  it('rend ce que npm a répondu, avec la date de publication', () => {
    const r = etatDeLaRelease({
      npm: { version: '0.8.9', time: { '0.8.9': '2026-09-09T12:00:00.000Z' } },
      depot,
      le: '2026-09-16T00:00:00.000Z',
    });
    expect(r.npmInjoignable).toBe(false);
    expect(r.surNpm).toBe('0.8.9');
    expect(r.publieeLe).toBe('2026-09-09T12:00:00.000Z');
    expect(r.versionDuDepot).toBe('0.8.10');
    expect(r.dernierTag).toBe('v0.8.9');
    expect(r.commitsDepuisLeTag).toBe(14);
    expect(r.verifieLe).toBe('2026-09-16T00:00:00.000Z');
  });

  it('npm injoignable : AUCUNE valeur, et la date du constat, jamais l’ancienne valeur', () => {
    const r = etatDeLaRelease({ npm: null, depot, le: '2026-09-16T00:00:00.000Z' });
    expect(r.npmInjoignable).toBe(true);
    expect(r.surNpm).toBe(null);
    expect(r.publieeLe).toBe(null);
    expect(r.verifieLe).toBe('2026-09-16T00:00:00.000Z');
    // Ce que le dépôt sait de lui-même reste vrai : git ne dépend pas de npm.
    expect(r.versionDuDepot).toBe('0.8.10');
  });

  it('une réponse npm sans date ne s’invente pas une date', () => {
    const r = etatDeLaRelease({ npm: { version: '0.8.9' }, depot, le: 'x' });
    expect(r.surNpm).toBe('0.8.9');
    expect(r.publieeLe).toBe(null);
  });

  it('le dépôt est en avance quand sa version n’est pas celle de npm', () => {
    expect(etatDeLaRelease({ npm: { version: '0.8.9' }, depot, le: 'x' }).depotEnAvance).toBe(true);
    expect(etatDeLaRelease({ npm: { version: '0.8.10' }, depot, le: 'x' }).depotEnAvance).toBe(
      false,
    );
  });

  it('npm injoignable ne rend PAS un verdict « en avance » : on ne sait pas', () => {
    expect(etatDeLaRelease({ npm: null, depot, le: 'x' }).depotEnAvance).toBe(null);
  });
});

describe('comparerSemver', () => {
  it('ordonne sur les trois nombres, pas sur le texte', () => {
    expect(comparerSemver('0.8.9', '0.8.10')).toBe(-1);
    expect(comparerSemver('0.8.10', '0.8.9')).toBe(1);
    expect(comparerSemver('0.8.9', '0.8.9')).toBe(0);
    expect(comparerSemver('0.9.0', '0.10.0')).toBe(-1);
  });

  it('une préversion vient avant sa version', () => {
    expect(comparerSemver('0.9.0-rc.1', '0.9.0')).toBe(-1);
    expect(comparerSemver('0.9.0', '0.9.0-rc.1')).toBe(1);
    expect(comparerSemver('1.0.0-rc.1', '1.0.0')).toBe(-1);
  });

  // Comparées comme des chaînes, `rc.10` passait AVANT `rc.2` : une carte
  // « Publish 1.0.0-rc.10 » face à un npm en rc.2 était accusée en gravité
  // haute de demander une version déjà publiée. semver 2.0 §11 : segment par
  // segment, en nombres quand les deux le sont.
  it('les préversions se comparent segment par segment, en nombres', () => {
    expect(comparerSemver('1.0.0-rc.10', '1.0.0-rc.2')).toBe(1);
    expect(comparerSemver('1.0.0-rc.2', '1.0.0-rc.10')).toBe(-1);
  });

  it('un segment de texte se compare en texte, et le numérique passe devant', () => {
    expect(comparerSemver('1.0.0-alpha', '1.0.0-beta')).toBe(-1);
    expect(comparerSemver('1.0.0-beta', '1.0.0-alpha')).toBe(1);
    expect(comparerSemver('1.0.0-1', '1.0.0-alpha')).toBe(-1);
  });

  it('un identifiant plus court qui préfixe l’autre vient avant', () => {
    expect(comparerSemver('1.0.0-rc', '1.0.0-rc.1')).toBe(-1);
    expect(comparerSemver('1.0.0-rc.1', '1.0.0-rc')).toBe(1);
    expect(comparerSemver('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0);
  });

  it('rend null sur ce qui n’est pas un semver, pas un ordre inventé', () => {
    expect(comparerSemver('latest', '0.8.9')).toBe(null);
  });
});

describe('publicationsDejaFaites', () => {
  const release = { surNpm: '0.8.9', npmInjoignable: false };
  const carte = (o) => ({ type: 'issue', numero: 68, etat: 'OPEN', url: 'u', ...o });

  it('nomme l’issue OUVERTE qui demande de publier une version DÉJÀ sur npm, le cas #68', () => {
    const r = publicationsDejaFaites([carte({ titre: 'Publish 0.8.9 to npm' })], release);
    expect(r).toEqual([
      { numero: 68, type: 'issue', titre: 'Publish 0.8.9 to npm', version: '0.8.9', url: 'u' },
    ]);
  });

  it('une version plus ANCIENNE que celle de npm est publiée elle aussi', () => {
    expect(publicationsDejaFaites([carte({ titre: 'Publish 0.8.7' })], release)).toHaveLength(1);
  });

  it('ne dit rien d’une publication encore à faire', () => {
    expect(publicationsDejaFaites([carte({ titre: 'Publish 0.8.10' })], release)).toEqual([]);
  });

  it('une préversion plus récente que celle de npm n’est pas accusée', () => {
    expect(
      publicationsDejaFaites([carte({ titre: 'Publish 1.0.0-rc.10' })], {
        surNpm: '1.0.0-rc.2',
        npmInjoignable: false,
      }),
    ).toEqual([]);
  });

  it('« release 0.8.9 » compte autant que « publish 0.8.9 »', () => {
    expect(publicationsDejaFaites([carte({ titre: 'Release v0.8.9' })], release)).toHaveLength(1);
  });

  it('une carte FERMÉE ne reproche rien : c’est justement ce qu’on veut voir arriver', () => {
    expect(
      publicationsDejaFaites([carte({ titre: 'Publish 0.8.9', etat: 'CLOSED' })], release),
    ).toEqual([]);
  });

  it('npm injoignable : aucune accusation, on ne sait pas ce qui est publié', () => {
    expect(
      publicationsDejaFaites([carte({ titre: 'Publish 0.8.9' })], {
        surNpm: null,
        npmInjoignable: true,
      }),
    ).toEqual([]);
  });

  it('un titre sans numéro de version ne se fait pas accuser au hasard', () => {
    expect(publicationsDejaFaites([carte({ titre: 'Publish the docs site' })], release)).toEqual(
      [],
    );
  });

  it('sans release et sans cartes, rien, pas une erreur', () => {
    expect(publicationsDejaFaites(null, null)).toEqual([]);
  });
});

// ─── 2. La provenance d'une carte ─────────────────────────────────────────────

describe('ecritParUnAgent', () => {
  it('reconnaît le pied que les agents posent', () => {
    expect(ecritParUnAgent('body\n\n🤖 Generated with [Claude Code](https://claude.com)')).toBe(
      true,
    );
    expect(ecritParUnAgent('body\nClaude-Session: https://claude.ai/code/session_x')).toBe(true);
  });

  it('un corps SANS ce pied n’est pas reconnu comme écrit par un agent', () => {
    expect(ecritParUnAgent('Le bouton ne marche pas sur /agents.')).toBe(false);
    expect(ecritParUnAgent('')).toBe(false);
    expect(ecritParUnAgent(null)).toBe(false);
  });
});

describe('porteDesFaitsVerifies', () => {
  it('une section « ## Verified » suffit, à n’importe quel niveau de titre', () => {
    expect(porteDesFaitsVerifies('## Verified\n\n`npm view` says 0.8.9')).toBe(true);
    expect(porteDesFaitsVerifies('### Verified facts\n\nx')).toBe(true);
  });

  it('le mot « verified » au fil du texte n’est PAS une section', () => {
    expect(porteDesFaitsVerifies('I verified this by hand, trust me.')).toBe(false);
    expect(porteDesFaitsVerifies('')).toBe(false);
  });

  // Un agent qui CITE le modèle de SKILL.md dans un bloc de code écrit bien la
  // ligne, sans rien avoir vérifié. Le bloc de code n'est pas une section.
  it('un titre « Verified » cité dans un bloc de code ne compte pas', () => {
    const cite = [
      'Here is the template I will follow:',
      '',
      '```markdown',
      '## Verified',
      '',
      '`pnpm test` → green',
      '```',
      '',
      'Doing it later.',
    ].join('\n');
    expect(porteDesFaitsVerifies(cite)).toBe(false);
  });

  it('un bloc en ~~~ ne compte pas davantage, ni un bloc laissé ouvert', () => {
    expect(porteDesFaitsVerifies(['~~~', '## Verified', '~~~'].join('\n'))).toBe(false);
    expect(porteDesFaitsVerifies(['```', '## Verified'].join('\n'))).toBe(false);
  });

  // Un bloc de code INDENTÉ (4 espaces, pas de clôture) n'a rien à retirer :
  // c'est la borne d'indentation du TITRE qui l'écarte, comme en markdown, où
  // une ligne décalée de quatre espaces est du code et non un titre.
  it('un titre décalé de quatre espaces est du code indenté, pas une section', () => {
    expect(
      porteDesFaitsVerifies(['Template:', '', '    ## Verified', '', '    `pnpm test`'].join('\n')),
    ).toBe(false);
    expect(porteDesFaitsVerifies(['Template:', '', '\t## Verified'].join('\n'))).toBe(false);
  });

  it('jusqu’à trois espaces, un titre reste un titre', () => {
    expect(porteDesFaitsVerifies('   ## Verified\n\n`pnpm test` → green')).toBe(true);
  });

  // CommonMark : une clôture jamais refermée court jusqu'à la fin du corps.
  // C'est aussi le choix prudent — un corps qu'on ne sait pas lire ne vaut pas
  // un feu vert, et l'agent voit la pastille tout de suite.
  it('une clôture jamais refermée avale la suite, y compris une vraie section', () => {
    expect(
      porteDesFaitsVerifies(['```sh', 'pnpm test', '', '## Verified', '', 'x'].join('\n')),
    ).toBe(false);
  });

  it('la même section, une fois le bloc refermé, est bien lue', () => {
    expect(
      porteDesFaitsVerifies(['```sh', 'pnpm test', '```', '', '## Verified', '', 'x'].join('\n')),
    ).toBe(true);
  });

  it('un marqueur suivi de texte ne referme rien', () => {
    expect(
      porteDesFaitsVerifies(['```', 'code', '``` and more', '', '## Verified'].join('\n')),
    ).toBe(false);
  });

  it('une clôture décalée de quatre espaces n’ouvre pas de bloc', () => {
    // À quatre espaces la ligne appartient déjà à un bloc indenté : elle
    // n'ouvre rien, et la vraie section qui suit reste lue.
    expect(porteDesFaitsVerifies(['    ```', '', '## Verified', '', 'x'].join('\n'))).toBe(true);
  });

  it('une vraie section reste lue, même suivie d’un bloc qui cite le mot', () => {
    const vrai = [
      '## Verified',
      '',
      '```',
      '$ pnpm test',
      '## Verified is just quoted here',
      '```',
    ].join('\n');
    expect(porteDesFaitsVerifies(vrai)).toBe(true);
  });

  it('une vraie section APRÈS un bloc de code est lue elle aussi', () => {
    const vrai = ['```', 'code', '```', '', '## Verified', '', '`npm view` → 0.8.9'].join('\n');
    expect(porteDesFaitsVerifies(vrai)).toBe(true);
  });
});

describe('sansFaitsVerifies', () => {
  const carte = (o) => ({ type: 'issue', numero: 1, etat: 'OPEN', titre: 't', url: 'u', ...o });

  it('nomme la carte ouverte d’un agent qui n’apporte aucun fait', () => {
    const r = sansFaitsVerifies([carte({ parUnAgent: true, faitsVerifies: false })]);
    expect(r.map((c) => c.numero)).toEqual([1]);
  });

  it('un agent qui a vérifié n’est pas signalé', () => {
    expect(sansFaitsVerifies([carte({ parUnAgent: true, faitsVerifies: true })])).toEqual([]);
  });

  it('une carte SANS le pied d’agent n’est pas signalée : c’est le seul critère', () => {
    expect(sansFaitsVerifies([carte({ parUnAgent: false, faitsVerifies: false })])).toEqual([]);
  });

  it('une carte FERMÉE ou MERGÉE n’est plus un sujet', () => {
    expect(
      sansFaitsVerifies([carte({ etat: 'CLOSED', parUnAgent: true, faitsVerifies: false })]),
    ).toEqual([]);
    expect(
      sansFaitsVerifies([carte({ etat: 'MERGED', parUnAgent: true, faitsVerifies: false })]),
    ).toEqual([]);
  });

  it('sans carte du tout, rien, pas une erreur', () => {
    expect(sansFaitsVerifies(null)).toEqual([]);
  });
});

describe('cartesDuTableau porte la provenance', () => {
  it('lit le corps une fois, et range les deux verdicts sur la carte', () => {
    const cartes = cartesDuTableau({
      issues: [
        {
          number: 68,
          title: 'Publish 0.8.9',
          state: 'OPEN',
          url: 'u',
          body: 'do it\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)',
        },
        { number: 70, title: 'Bouton cassé', state: 'OPEN', url: 'u', body: 'ça casse' },
      ],
      pr: [
        {
          number: 71,
          title: 'feat: x',
          state: 'OPEN',
          url: 'u',
          body: '## Verified\n\n`pnpm test` green\n\nClaude-Session: https://claude.ai/code/s',
        },
      ],
    });
    const par = (n) => cartes.find((c) => c.numero === n);
    expect(par(68).parUnAgent).toBe(true);
    expect(par(68).faitsVerifies).toBe(false);
    expect(par(70).parUnAgent).toBe(false);
    expect(par(71).parUnAgent).toBe(true);
    expect(par(71).faitsVerifies).toBe(true);
    // Le corps lui-même ne part PAS dans le snapshot : seuls les deux verdicts.
    expect(par(68).corps).toBeUndefined();
    expect(par(68).body).toBeUndefined();
  });

  it('une issue sans corps du tout n’est pas prise pour un agent', () => {
    const cartes = cartesDuTableau({
      issues: [{ number: 1, title: 't', state: 'OPEN', url: 'u' }],
      pr: [],
    });
    expect(cartes[0].parUnAgent).toBe(false);
    expect(cartes[0].faitsVerifies).toBe(false);
  });
});

// ─── 3. Les deux écarts que ce lot ajoute ─────────────────────────────────────

describe('ecartsDe, sur la release et la provenance', () => {
  const socle = (o) => ({ resume: {}, capacites: { registre: [] }, ...o });

  it('crie quand une carte ouverte demande de publier ce qui est déjà publié', () => {
    const e = ecartsDe(
      socle({
        release: { surNpm: '0.8.9', npmInjoignable: false },
        chantiers: {
          cartes: [{ type: 'issue', numero: 68, etat: 'OPEN', titre: 'Publish 0.8.9', url: 'u' }],
        },
      }),
    ).find((x) => /already on npm/i.test(x.titre));
    expect(e).toBeTruthy();
    expect(e.gravite).toBe('haute');
    expect(e.quoi).toEqual(['#68 Publish 0.8.9']);
  });

  it('crie quand une carte ouverte d’agent n’apporte aucun fait vérifié', () => {
    const e = ecartsDe(
      socle({
        chantiers: {
          cartes: [
            {
              type: 'issue',
              numero: 68,
              etat: 'OPEN',
              titre: 'Publish 0.8.9',
              url: 'u',
              parUnAgent: true,
              faitsVerifies: false,
            },
          ],
        },
      }),
    ).find((x) => /no verified facts/i.test(x.titre));
    expect(e).toBeTruthy();
    expect(e.gravite).toBe('haute');
    expect(e.quoi).toEqual(['#68 Publish 0.8.9']);
  });

  it('npm injoignable est DIT, et n’est pas un feu vert', () => {
    const e = ecartsDe(
      socle({ release: { surNpm: null, npmInjoignable: true, verifieLe: '2026-09-16T00:00:00Z' } }),
    ).find((x) => /npm was unreachable/i.test(x.titre));
    expect(e).toBeTruthy();
    expect(e.gravite).toBe('moyenne');
  });

  it('un tableau sain ne pose aucun de ces écarts', () => {
    const l = ecartsDe(
      socle({
        release: { surNpm: '0.8.9', npmInjoignable: false },
        chantiers: {
          cartes: [
            {
              type: 'issue',
              numero: 70,
              etat: 'OPEN',
              titre: 'Publish 0.8.10',
              url: 'u',
              parUnAgent: true,
              faitsVerifies: true,
            },
          ],
        },
      }),
    );
    expect(l.find((x) => /already on npm/i.test(x.titre))).toBeUndefined();
    expect(l.find((x) => /no verified facts/i.test(x.titre))).toBeUndefined();
    expect(l.find((x) => /npm was unreachable/i.test(x.titre))).toBeUndefined();
  });
});

// ─── 4. Le rafraîchissement horaire porte la release ──────────────────────────

describe('fusionnerTableauGitHub garde la release à jour', () => {
  const mesure = () => ({
    genereLe: '2026-09-15T03:17:00.000Z',
    tableauLe: '2026-09-15T03:17:00.000Z',
    release: { surNpm: '0.8.9', npmInjoignable: false },
    chantiers: { cartes: [] },
  });

  it('une publication faite à midi est vue à midi, pas la nuit suivante', () => {
    const r = fusionnerTableauGitHub(mesure(), {
      chantiers: { cartes: [] },
      release: { surNpm: '0.8.10', npmInjoignable: false },
      le: '2026-09-15T12:00:00.000Z',
    });
    expect(r.release.surNpm).toBe('0.8.10');
  });

  it('npm vient d’un autre service que GitHub : un GitHub muet ne fige pas la release', () => {
    const r = fusionnerTableauGitHub(mesure(), {
      chantiers: null,
      release: { surNpm: '0.8.10', npmInjoignable: false },
      le: '2026-09-15T12:00:00.000Z',
    });
    expect(r.release.surNpm).toBe('0.8.10');
    // Le tableau, lui, n'a pas bougé : sa date reste celle de la mesure.
    expect(r.tableauLe).toBe('2026-09-15T03:17:00.000Z');
  });

  it('sans release fraîche, celle de la mesure reste, elle n’est pas effacée', () => {
    const r = fusionnerTableauGitHub(mesure(), { chantiers: { cartes: [] }, le: 'x' });
    expect(r.release.surNpm).toBe('0.8.9');
  });
});

// ─── 5. Ce que le rendu montre ────────────────────────────────────────────────
//
// Un mécanisme que la page n'affiche pas ne sert personne. Le rendu est vérifié
// sur son SOURCE : `build.mjs` lit un snapshot committé, et le faire tourner ici
// écraserait les données du dépôt.

describe('le rendu du portail', () => {
  const build = readFileSync(new URL('./build.mjs', import.meta.url), 'utf8');

  it('pose le bloc Release sur la page du tableau, dans les deux cas', () => {
    expect(build).toContain('function cadreRelease()');
    // Y compris quand GitHub n'a pas répondu : npm ne dépend pas de GitHub.
    expect(build.match(/cadreRelease\(\)/g)?.length).toBeGreaterThanOrEqual(3);
    expect(build).toContain('npm unreachable at');
  });

  it('marque la carte d’un agent qui n’apporte aucun fait', () => {
    expect(build).toContain('no verified facts');
  });

  it('ne peint jamais une absence en vert : le bloc dit le trou', () => {
    expect(build).toContain('Release state not collected.');
  });
});
