// approval-rules-one-door.arch.test.ts — une seule porte d'écriture pour les
// règles d'approbation (issue #401).
//
// Pourquoi ce fichier existe : l'onglet Connectors écrivait une règle
// `auto_approve` sur un motif MCP sans savoir ce qu'elle remplaçait. Il passait
// pourtant déjà par l'action gardée ; le trou était à l'écran, pas dans la
// couche d'accès. Corriger l'onglet ne dit rien du onzième écran qui viendra.
//
// Cette garde dit la chose que la revue ne peut pas tenir seule : dans
// `apps/web`, une ligne de `approval_rules` ne s'écrit QUE depuis
// `src/lib/actions.ts`. Un composant qui irait à la table directement — ou une
// seconde couche d'actions qui la contournerait — rougit ici.
//
// Ce qu'elle ne voit pas, et il vaut mieux l'écrire que promettre une barrière
// étanche : elle lit du texte, pas un arbre syntaxique. Un appel assemblé à
// l'exécution lui échappe, et le garde d'élargissement lui-même est prouvé
// ailleurs, sur de vraies lignes en base
// (`src/lib/__tests__/approval-rule-folder-condition.test.ts`).

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(import.meta.dirname, '..');

/** La seule porte. Tout le reste passe par elle. */
const PORTE = join('lib', 'actions.ts');

function fichiersSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '__tests__' || entry === 'tests') continue;
      fichiersSources(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    out.push(full);
  }
  return out;
}

describe("les règles d'approbation n'ont qu'une porte d'écriture", () => {
  it('aucun fichier hors lib/actions.ts n’écrit dans la table', () => {
    // Assemblé à l'exécution : écrit en clair, le nom de la table ferait de ce
    // fichier son propre contre-exemple le jour où la garde se scannerait.
    const table = 'approval' + 'Rules';
    const ecritures = /\.\s*(insert|update|delete)\s*\(/;

    const coupables: string[] = [];
    for (const file of fichiersSources(SRC)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes(table)) continue;
      if (!ecritures.test(source)) continue;
      const rel = relative(SRC, file);
      if (rel === PORTE || rel === PORTE.split(sep).join('/')) continue;
      coupables.push(rel);
    }

    expect(coupables).toEqual([]);
  });
});
