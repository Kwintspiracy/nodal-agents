// workflows/catalog.ts — le catalogue des scénarios, tel que le portail le lit.
//
// Le portail (apps/qa) ne lit pas le TypeScript du banc : il lit les lignes des
// essais (data/workflows.ndjson) et ce catalogue (data/workflow-catalog.json).
// Sans lui, un scénario jamais joué, ou une activité sans scénario, serait
// absent de la matrice au lieu d'y être DIT. Le fichier est écrit par
// `pnpm bench:workflows --catalog` ; catalog.test.ts refuse qu'il diverge du
// code.

import { productToolJudgedBy } from './judge-kit';
import { NEED_IDS } from './needs';
import { SCENARIOS } from './scenarios';
import { MEASURED_ON_EVERY_TRIAL } from './trial';
import { ACTIVITIES } from './types';

export interface CatalogScenario {
  readonly id: string;
  readonly version: number;
  readonly activity: string;
  /** Ce qu'on teste (jamais le sujet de la demande). */
  readonly title: string;
  readonly green: string;
  /** Le chemin attendu, en clair. */
  readonly path: string;
  readonly deliverable: string;
  /** Les outils du produit attendus et les fichiers qu'ils traitent ; null : aucun. */
  readonly productTools: { tools: string[]; files: string[] } | null;
  /** Le genre de sujet calibré que le scénario lit ; null : son sujet est dans sa demande. */
  readonly subject: string | null;
  readonly set: string;
  readonly needs: string[];
  readonly sends: string;
  /** La demande, ou son modèle quand le sujet est calibré (`{subject}`). */
  readonly instruction: string;
  readonly timeoutMs: number;
  /** Le juge du scénario, puis les règles de chemin qui s'y ajoutent (outils du produit). */
  readonly judgedBy: string[];
  readonly fixtures: Array<{ from: string; to: string }>;
  readonly outputs: string[];
  readonly unverified: Array<{ check: string; reason: string; ticket: string }>;
}

export interface Catalog {
  readonly activities: string[];
  readonly needs: string[];
  /** Ce que chaque essai mesure, quel que soit le scénario. */
  readonly measured: string[];
  readonly scenarios: CatalogScenario[];
}

export function buildCatalog(): Catalog {
  return {
    activities: [...ACTIVITIES],
    needs: [...NEED_IDS],
    measured: [...MEASURED_ON_EVERY_TRIAL],
    scenarios: SCENARIOS.map((s) => ({
      id: s.id,
      version: s.version,
      activity: s.activity,
      title: s.title,
      green: s.green,
      path: s.path,
      deliverable: s.deliverable,
      productTools: s.productTools
        ? { tools: [...s.productTools.tools], files: [...s.productTools.files] }
        : null,
      subject: s.subject ?? null,
      set: s.set,
      needs: [...(s.needs ?? [])],
      sends: s.sends,
      instruction: s.instruction,
      timeoutMs: s.timeoutMs,
      judgedBy: [...s.judgedBy, ...productToolJudgedBy(s)],
      fixtures: (s.fixtures ?? []).map((f) => ({ from: f.from, to: f.to })),
      outputs: [...(s.outputs ?? [])],
      unverified: (s.unverified ?? []).map((u) => ({
        check: u.check,
        reason: u.reason,
        ticket: u.ticket,
      })),
    })),
  };
}

/** Le texte exact du fichier : une forme stable, pour qu'un écart se lise dans une diff. */
export function catalogText(): string {
  return `${JSON.stringify(buildCatalog(), null, 2)}\n`;
}
