// scan-server-uses-client-value.test.ts — ce que la garde attrape, et ce
// qu'elle laisse passer (#237).
//
// Pourquoi ce fichier, alors que `architecture.test.ts` fait déjà tourner la
// garde sur le vrai arbre : sur le vrai arbre, elle rend « aucune violation »,
// et ce zéro ne dit RIEN de ce qu'elle sait voir. Les cas ci-dessous lui
// donnent des arbres minuscules où le défaut est écrit exprès.
//
// Les angles morts sont testés aussi, et c'est le point : ils sont écrits dans
// l'en-tête du scanner, et une limite affirmée sans preuve devient fausse au
// premier changement sans que personne le voie. Ici, le jour où l'une d'elles
// se met à être couverte, le test rougit et on met le commentaire à jour.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { scanForServerUsesOfClientValues } from '../scan-server-uses-client-value.ts';

let racine: string;

beforeEach(() => {
  racine = mkdtempSync(join(tmpdir(), 'scan-rsc-'));
});

afterEach(() => {
  rmSync(racine, { recursive: true, force: true });
});

/** Écrit un fichier de l'arbre d'essai, dossiers compris. */
function poser(chemin: string, contenu: string): void {
  const p = join(racine, chemin);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, contenu, 'utf8');
}

function scanner(): string[] {
  return scanForServerUsesOfClientValues({ srcDir: racine }).map((v) => `${v.file} :: ${v.text}`);
}

const CLIENT = "'use client';\nexport function helper(x: string) {\n  return x;\n}\n";

describe('scanForServerUsesOfClientValues — ce qu’elle attrape', () => {
  it('une page serveur qui APPELLE une fonction d’un module client', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser(
      'app/thing/page.tsx',
      "import { helper } from './Client.tsx';\nexport default function P() {\n  return <p>{helper('a')}</p>;\n}\n",
    );
    const v = scanner();
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('helper()');
  });

  it('un module INTERMÉDIAIRE du graphe serveur, pas seulement la page', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser(
      'app/thing/util.ts',
      "import { helper } from './Client.tsx';\nexport const a = helper('a');\n",
    );
    poser(
      'app/thing/page.tsx',
      "import { a } from './util.ts';\nexport default () => <p>{a}</p>;\n",
    );
    expect(scanner().join('')).toContain('util.ts');
  });

  it('un nom relayé par un RÉ-EXPORT, un niveau', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser('app/thing/conduit.ts', "export { helper } from './Client.tsx';\n");
    poser(
      'app/thing/page.tsx',
      "import { helper } from './conduit.ts';\nexport default () => <p>{helper('a')}</p>;\n",
    );
    expect(scanner().join('')).toContain('ré-exporte');
  });

  it('RIEN quand le composant client est seulement RENDU', () => {
    poser(
      'app/thing/Client.tsx',
      "'use client';\nexport default function C() {\n  return null;\n}\n",
    );
    poser(
      'app/thing/page.tsx',
      "import C from './Client.tsx';\nexport default () => (\n  <div>\n    <C />\n  </div>\n);\n",
    );
    expect(scanner()).toEqual([]);
  });

  it('RIEN hors du graphe serveur : un module que seuls des clients atteignent', () => {
    poser('app/thing/Client.tsx', CLIENT);
    // Ce fichier n'a pas de directive, mais AUCUNE entrée serveur ne l'atteint.
    poser(
      'app/thing/voisin.ts',
      "import { helper } from './Client.tsx';\nexport const b = helper('b');\n",
    );
    poser('app/thing/page.tsx', 'export default () => <p>rien</p>;\n');
    expect(scanner()).toEqual([]);
  });

  it('RIEN pour un import de TYPE — il s’efface à la compilation', () => {
    poser('app/thing/Client.tsx', "'use client';\nexport type Helper = (x: string) => string;\n");
    poser(
      'app/thing/page.tsx',
      "import type { Helper } from './Client.tsx';\nconst f = null as unknown as Helper;\nexport default () => <p>{f('a')}</p>;\n",
    );
    expect(scanner()).toEqual([]);
  });
});

describe('scanForServerUsesOfClientValues — ses angles morts, tenus à jour', () => {
  it('ne suit pas une CHAÎNE de ré-exports', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser('app/thing/c1.ts', "export { helper } from './Client.tsx';\n");
    poser('app/thing/c2.ts', "export { helper } from './c1.ts';\n");
    poser(
      'app/thing/page.tsx',
      "import { helper } from './c2.ts';\nexport default () => <p>{helper('a')}</p>;\n",
    );
    expect(scanner(), 'angle mort documenté : conduit de conduit').toEqual([]);
  });

  it('ne voit pas un import DYNAMIQUE', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser(
      'app/thing/page.tsx',
      "export default async function P() {\n  const m = await import('./Client.tsx');\n  return <p>{m.helper('a')}</p>;\n}\n",
    );
    expect(scanner(), 'angle mort documenté : import() dynamique').toEqual([]);
  });

  it('n’entre pas par `loading.tsx`', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser(
      'app/thing/loading.tsx',
      "import { helper } from './Client.tsx';\nexport default () => <p>{helper('a')}</p>;\n",
    );
    expect(scanner(), 'angle mort documenté : entrées hors de SERVER_ENTRY').toEqual([]);
  });

  it('prend un appel écrit dans un COMMENTAIRE pour un vrai appel', () => {
    poser('app/thing/Client.tsx', CLIENT);
    poser(
      'app/thing/page.tsx',
      "import { helper } from './Client.tsx';\n// on ne fait PAS helper('a') ici\nexport default () => <p>rien</p>;\n",
    );
    expect(scanner(), 'angle mort documenté : faux rouge sur un commentaire').toHaveLength(1);
  });
});
