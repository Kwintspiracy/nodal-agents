// scripts/lib/bench-studio-absent.mjs — Bench Studio est-il absent d'une sortie de build ?
//
// Bench Studio (`pnpm bench:studio`) est l'outil LOCAL du propriétaire, jamais
// livré : ses pages et ses routes ne sont des routes qu'en mode studio
// (apps/web/next.config.ts). Cette vérification le PROUVE sur ce qui sort
// vraiment : `apps/web/.next` après un `next build` (CI, job build) et `pack/`
// assemblé par build-pack (CI pack-smoke, release:check). Une seule trace suffit
// à échouer : un chemin qui nomme le studio, ou un fichier qui contient un code
// d'erreur que seul le code du studio porte (un littéral qui survit à la
// minification, puisque la garde le compare à l'exécution).

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * Les morceaux de chemin qui n'appartiennent qu'au banc : le studio, et le
 * serveur d'impression du banc (packages/bench/src/printer, #794).
 */
export const STUDIO_PATH_MARKERS = ['bench-studio', '.next-studio', 'bench-printer'];
/**
 * Les littéraux qui n'existent que dans le code du studio : la garde de ses
 * routes (apps/web/src/lib/bench-studio/guard.ts) et sa lecture des fixtures
 * (packages/bench/src/studio/data.ts).
 */
export const STUDIO_CONTENT_MARKERS = [
  'studio_not_behind_filter',
  'studio_no_fixture',
  // Le format des enregistrements de l'imprimante du banc (printer/record.ts) :
  // ce serveur n'imprime rien et ne vit qu'avec le banc, jamais dans le produit.
  'bench_printer_record_v1',
];

/**
 * Les traces du studio sous `dir`, en chemins relatifs. Vide = absent.
 * Un lien symbolique n'est pas suivi : sa cible est ailleurs, elle est vérifiée
 * là où elle vit.
 */
export function findStudioTraces(dir) {
  const traces = [];
  const markers = STUDIO_CONTENT_MARKERS.map((m) => Buffer.from(m));
  const walk = (abs) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const p = join(abs, entry.name);
      const rel = relative(dir, p).split(sep).join('/');
      if (STUDIO_PATH_MARKERS.some((m) => entry.name.includes(m))) {
        traces.push(`${rel} (path)`);
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        // `.next/cache` n'est pas une sortie : il se régénère et n'est jamais servi.
        if (rel !== 'cache') walk(p);
        continue;
      }
      if (!entry.isFile()) continue;
      const content = readFileSync(p);
      const hit = markers.find((m) => content.includes(m));
      if (hit) traces.push(`${rel} (contains ${hit.toString()})`);
    }
  };
  walk(dir);
  return traces;
}
