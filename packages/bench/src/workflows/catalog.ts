// workflows/catalog.ts — le catalogue des scénarios, tel que le portail le lit.
//
// Le portail (apps/qa) ne lit pas le TypeScript du banc : il lit les lignes des
// essais (data/workflows.ndjson) et ce catalogue (data/workflow-catalog.json).
// Sans lui, un scénario jamais joué, ou une activité sans scénario, serait
// absent de la matrice au lieu d'y être DIT. Le fichier est écrit par
// `pnpm bench:workflows --catalog` ; catalog.test.ts refuse qu'il diverge du
// code.

import { NEED_IDS } from './needs';
import { SCENARIOS } from './scenarios';
import { ACTIVITIES } from './types';

export interface CatalogScenario {
  readonly id: string;
  readonly version: number;
  readonly activity: string;
  readonly title: string;
  readonly green: string;
  readonly set: string;
  readonly needs: string[];
  readonly sends: string;
  readonly instruction: string;
}

export interface Catalog {
  readonly activities: string[];
  readonly needs: string[];
  readonly scenarios: CatalogScenario[];
}

export function buildCatalog(): Catalog {
  return {
    activities: [...ACTIVITIES],
    needs: [...NEED_IDS],
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      version: s.version,
      activity: s.activity,
      title: s.title,
      green: s.green,
      set: s.set,
      needs: [...(s.needs ?? [])],
      sends: s.sends,
      instruction: s.instruction,
    })),
  };
}

/** Le texte exact du fichier : une forme stable, pour qu'un écart se lise dans une diff. */
export function catalogText(): string {
  return `${JSON.stringify(buildCatalog(), null, 2)}\n`;
}
