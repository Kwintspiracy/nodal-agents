// project-roots.test.ts — la règle « chemin → projet », sur un corpus de
// chemins réels.
//
// Ce que ce fichier cherche à attraper : une divergence avec
// `projectRootFor` / `within` du runner (apps/runner/src/job/code-projects.ts),
// dont ce module est le portage. Les cas retenus sont ceux qui ont déjà cassé
// une des deux copies existantes — antislashs Windows, slash final, partage
// UNC, racine de disque — plus l'ORDRE, qui n'est pas cosmétique ici : c'est
// l'ordre de verrouillage du protocole transactionnel.

import { describe, it, expect } from 'vitest';
import { resolveProjectRoots, isDriveRoot, PROJECT_MARKERS } from '../project-roots';
import type { MutationTarget } from '../project-roots';

const noMarker = () => false;
const file = (path: string): MutationTarget => ({ kind: 'file', path });
const dir = (path: string): MutationTarget => ({ kind: 'dir', path });

const keys = (r: readonly { key: string }[]): string[] => r.map((p) => p.key);

describe('resolveProjectRoots — la règle de base', () => {
  it('un fichier profond appartient à l’ENFANT DIRECT du dossier attaché', () => {
    // Attacher `Dev` ne fait pas de `Dev` un projet : ses sous-dossiers en sont,
    // quelle que soit la profondeur du fichier édité.
    const out = resolveProjectRoots({
      targets: [file('C:/Dev/app/src/deep/nested/file.ts')],
      workspaceRoots: ['C:/Dev'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([{ key: 'c:/dev/app', path: 'C:/Dev/app' }]);
  });

  it('un dossier attaché QUI PORTE un manifeste est lui-même le projet', () => {
    // Sans cette exception, attacher directement un dépôt afficherait `apps`,
    // `packages` et `docs` comme trois projets.
    const out = resolveProjectRoots({
      targets: [file('C:/Dev/repo/packages/db/src/x.ts')],
      workspaceRoots: ['C:/Dev/repo'],
      hasMarker: (d) => d === 'C:/Dev/repo',
    });
    expect(out).toEqual([{ key: 'c:/dev/repo', path: 'C:/Dev/repo' }]);
  });

  it('un fichier POSÉ à la racine attachée sans manifeste rend la racine', () => {
    const out = resolveProjectRoots({
      targets: [file('/srv/space/notes.md')],
      workspaceRoots: ['/srv/space'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([{ key: '/srv/space', path: '/srv/space' }]);
  });

  it('une cible `dir` est prise telle quelle, une cible `file` perd son dernier segment', () => {
    // La même chaîne, deux verdicts — c'est exactement ce que `kind` sert à
    // trancher : `src` fichier vs `src` dossier.
    const asFile = resolveProjectRoots({
      targets: [file('/srv/space/app/src')],
      workspaceRoots: ['/srv/space/app'],
      hasMarker: noMarker,
    });
    const asDir = resolveProjectRoots({
      targets: [dir('/srv/space/app/src')],
      workspaceRoots: ['/srv/space/app'],
      hasMarker: noMarker,
    });
    expect(keys(asFile)).toEqual(['/srv/space/app']);
    expect(keys(asDir)).toEqual(['/srv/space/app/src']);
  });

  it('hors de tout dossier attaché : AUCUN projet', () => {
    // Se rabattre sur une racine au hasard salirait un projet que personne
    // n'a touché — et ferait tourner une preuve complète dessus.
    const out = resolveProjectRoots({
      targets: [file('D:/ailleurs/x.ts')],
      workspaceRoots: ['C:/Dev'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([]);
  });
});

describe('corpus de chemins — les formes qui ont déjà cassé une copie', () => {
  it('antislashs Windows et slash final rendent la MÊME clé', () => {
    const out = resolveProjectRoots({
      targets: [file('C:\\Dev\\app\\src\\x.ts'), file('C:/Dev/app/other.ts')],
      workspaceRoots: ['C:\\Dev\\'],
      hasMarker: noMarker,
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.key).toBe('c:/dev/app');
  });

  it('deux casses du même dossier Windows sont UN projet', () => {
    const out = resolveProjectRoots({
      targets: [file('C:/Dev/App/a.ts'), file('c:/dev/app/b.ts')],
      workspaceRoots: ['C:/Dev'],
      hasMarker: noMarker,
    });
    expect(keys(out)).toEqual(['c:/dev/app']);
  });

  it('deux casses du même dossier POSIX sont DEUX projets', () => {
    // Le repli sur toLowerCase() inconditionnel est faux hors Windows :
    // `/srv/App` et `/srv/app` sont deux dossiers différents.
    const out = resolveProjectRoots({
      targets: [file('/srv/space/App/a.ts'), file('/srv/space/app/b.ts')],
      workspaceRoots: ['/srv/space'],
      hasMarker: noMarker,
    });
    expect(keys(out)).toEqual(['/srv/space/App', '/srv/space/app']);
  });

  it('un partage UNC est traité comme un chemin Windows (casse repliée)', () => {
    const out = resolveProjectRoots({
      targets: [file('\\\\srv\\part\\App\\x.ts')],
      workspaceRoots: ['//srv/part'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([{ key: '//srv/part/app', path: '//srv/part/App' }]);
  });

  it('une racine de disque attachée est ÉCARTÉE, pas exploitée', () => {
    // Elle engloberait la machine entière, et le repli « enfant direct » en
    // tirerait des projets nommés `Users` ou `home`.
    for (const root of ['C:/', 'C:', '/', '']) {
      const out = resolveProjectRoots({
        targets: [file('C:/Users/kwint/x.ts')],
        workspaceRoots: [root],
        hasMarker: noMarker,
      });
      expect(out, `racine « ${root} » exploitée`).toEqual([]);
    }
  });

  it('une CIBLE qui est une racine de disque est écartée elle aussi', () => {
    const out = resolveProjectRoots({
      targets: [dir('C:/'), file('C:/x.ts')],
      workspaceRoots: ['C:/Dev'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([]);
  });
});

describe('l’ordre et la déduplication — c’est l’ordre de verrouillage', () => {
  it('les clés sortent TRIÉES CROISSANT, quel que soit l’ordre des cibles', () => {
    const out = resolveProjectRoots({
      targets: [file('/srv/w/zeta/x.ts'), file('/srv/w/alpha/y.ts'), file('/srv/w/mid/z.ts')],
      workspaceRoots: ['/srv/w'],
      hasMarker: noMarker,
    });
    expect(keys(out)).toEqual(['/srv/w/alpha', '/srv/w/mid', '/srv/w/zeta']);
  });

  it('quatre écritures dans le même projet ⇒ une seule entrée', () => {
    const out = resolveProjectRoots({
      targets: [
        file('/srv/w/app/a.ts'),
        file('/srv/w/app/b.ts'),
        dir('/srv/w/app/sub'),
        file('/srv/w/app/sub/c.ts'),
      ],
      workspaceRoots: ['/srv/w'],
      hasMarker: noMarker,
    });
    expect(out).toEqual([{ key: '/srv/w/app', path: '/srv/w/app' }]);
  });

  it('la racine la PLUS NICHÉE gagne quand deux dossiers s’emboîtent', () => {
    // L'agent tient `C:/dev` ET `C:/dev/app` : un fichier de `app` appartient
    // au projet le plus proche, pas au parent — sinon deux vues du même
    // fichier désigneraient deux projets.
    const out = resolveProjectRoots({
      targets: [file('C:/dev/app/src/x.ts')],
      workspaceRoots: ['C:/dev', 'C:/dev/app'],
      hasMarker: noMarker,
    });
    expect(keys(out)).toEqual(['c:/dev/app/src']);
  });
});

describe('les briques exportées', () => {
  it('isDriveRoot reconnaît les racines, et RIEN d’autre', () => {
    for (const p of ['', '/', 'C:', 'c:/', 'D:///']) {
      expect(isDriveRoot(p), `${p} devrait être une racine`).toBe(true);
    }
    for (const p of ['C:/Dev', '/srv', '//srv/part', 'C:/Dev/app']) {
      expect(isDriveRoot(p), `${p} ne devrait PAS être une racine`).toBe(false);
    }
  });

  it('la liste des marqueurs porte les manifestes de l’onglet Code', () => {
    // Une liste partagée, parce que `hasMarker` est injecté : deux appelants
    // avec deux listes ne verraient pas le même projet au même endroit.
    expect(PROJECT_MARKERS).toContain('.git');
    expect(PROJECT_MARKERS).toContain('package.json');
    expect(PROJECT_MARKERS).toContain('pyproject.toml');
    expect(PROJECT_MARKERS).toContain('Cargo.toml');
  });
});
