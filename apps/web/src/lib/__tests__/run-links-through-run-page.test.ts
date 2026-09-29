// run-links-through-run-page.test.ts — aucune adresse de run écrite à la main (#501).
//
// Cinq écrans écrivaient `/jobs/${id}` à la main, et chacun envoyait la barre
// latérale sur Scheduled, quel que soit le run. L'adresse d'un run se décide
// dans `lib/run-page.ts` et nulle part ailleurs : ce test lit les sources et
// refuse toute adresse de page de run bâtie hors de ce module.
//
// Ce qui n'est pas une adresse de page reste permis : `revalidatePath` (une
// clé de cache), et `/api/jobs/…` (le runner).
//
// Mutation vérifiée : `href={`/jobs/${item.jobId}`}` remis dans
// NotificationsBell → ce test rougit en nommant le fichier.
//
// Revue Nodal de #621 : la garde ignorait `/scheduled/${…}`, et « Open run »
// d'un fil Work (ConversationFeedView, DeliveryBlock) l'écrivait à la main :
// le bug #501 par un chemin qui contournait run-page.ts. Elle couvre donc
// TOUTES les portes d'une page de run, et aussi la BASE d'une adresse posée à
// part pour y coller un identifiant (`${basePath}/${id}`), la forme que prenait
// la liste des runs d'une automatisation.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const SRC = path.resolve(import.meta.dirname, '../..');
const MODULE = path.join('lib', 'run-page.ts');

/**
 * Une adresse de page de run bâtie à la main, par l'une de ses portes :
 * `/jobs/${…}`, `/scheduled/${…}`, `/chat/runs/${…}`, `/runs/${…}`.
 */
const ADRESSE_DE_RUN = /[`'"]\/(?:jobs|scheduled|chat\/runs|runs)\/\$\{/;

/**
 * La BASE d'une adresse de run, en chaîne, à laquelle un écran collerait un
 * identifiant : `'/scheduled'`, `'/jobs/'`. La table des sections du rail
 * (`sidebar-nav.ts`) nomme ces préfixes pour les RECONNAÎTRE, jamais pour en
 * bâtir : elle est la seule exception.
 */
const BASE_DE_RUN = /[`'"]\/(?:jobs|scheduled|chat\/runs|runs)\/?[`'"]/;
const TABLE_DU_RAIL = path.join('components', 'sidebar-nav.ts');

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === '__tests__' || name === 'node_modules') continue;
      out.push(...sources(full));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full);
    }
  }
  return out;
}

describe('les adresses de run passent par lib/run-page.ts (#501) @cap:suivre-execution/ecran', () => {
  it('aucun écran ne bâtit l’adresse d’une page de run lui-même', () => {
    const fautes: string[] = [];
    for (const file of sources(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel === MODULE) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          // Un commentaire NOMME une route, il n'en bâtit pas.
          if (/^\s*(?:\/\/|\*|\/\*|\{\/\*)/.test(line)) return;
          if (line.includes('revalidatePath(')) return;
          const base = rel !== TABLE_DU_RAIL && BASE_DE_RUN.test(line);
          if (!ADRESSE_DE_RUN.test(line) && !base) return;
          fautes.push(`${rel}:${i + 1}: ${line.trim()}`);
        });
    }
    expect(fautes).toEqual([]);
  });
});
