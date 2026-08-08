// catalog-drift — the catalogue against what OpenRouter actually serves today.
//
// Online, and opt-in (`--online`). The reason it exists: our OpenRouter entries
// are a hand-curated subset of a list that changes weekly. Without a drift
// measurement the only way to learn an id is dead is a 404 in production, and
// the only way to learn a better model shipped is to read the news.
//
// Two directions are measured, and they are NOT the same thing:
//   - `dead_ids`   — we list a model upstream no longer serves. A bug.
//   - `newer_available` — upstream has a model newer than our newest, per
//                    family. Not a bug; a prompt to look.

import { MODEL_CATALOG } from '@nodal-agents/shared';
import type { Metric, Section } from '../types';

const ENDPOINT = 'https://openrouter.ai/api/v1/models';

interface UpstreamModel {
  id: string;
  created?: number;
  context_length?: number;
}

async function fetchUpstream(): Promise<UpstreamModel[]> {
  const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}`);
  const body = (await res.json()) as { data?: UpstreamModel[] };
  if (!Array.isArray(body.data) || body.data.length === 0) {
    throw new Error('Réponse OpenRouter vide ou inattendue');
  }
  return body.data;
}

export const catalogDriftSection: Section = {
  id: 'catalog-drift',
  label: 'Catalogue vs OpenRouter en direct',
  why: 'Un identifiant mort ne se découvre qu’en 404 de production ; un modèle plus récent ne se découvre pas du tout.',
  tests: [],

  async run(): Promise<Metric[]> {
    const upstream = await fetchUpstream();
    const byId = new Map(upstream.map((m) => [m.id, m]));

    const ours = (MODEL_CATALOG['openrouter'] ?? []).map((e) => e.modelId);
    const dead = ours.filter((id) => !byId.has(id));

    // Per family (the `vendor/` prefix we already list), is there something
    // newer upstream than the newest we carry?
    const families = new Set(ours.map((id) => id.split('/')[0]).filter(Boolean) as string[]);
    const newer: string[] = [];
    for (const family of [...families].sort()) {
      const mineNewest = Math.max(
        ...ours.filter((id) => id.startsWith(`${family}/`)).map((id) => byId.get(id)?.created ?? 0),
        0,
      );
      const candidates = upstream
        .filter((m) => m.id.startsWith(`${family}/`) && !m.id.includes(':'))
        .filter((m) => (m.created ?? 0) > mineNewest)
        .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
      const top = candidates[0];
      if (top) {
        const when = new Date((top.created ?? 0) * 1000).toISOString().slice(0, 10);
        newer.push(`${family}: ${top.id} (${when})`);
      }
    }

    return [
      {
        id: 'openrouter_models_listed',
        label: 'Modèles OpenRouter au catalogue',
        value: ours.length,
        unit: 'modèles',
        direction: 'higher-is-better',
      },
      {
        id: 'dead_ids',
        label: 'Identifiants absents en amont',
        value: dead.length,
        unit: 'modèles',
        direction: 'lower-is-better',
        detail: dead,
      },
      {
        id: 'families_with_newer_upstream',
        label: 'Familles ayant plus récent en amont',
        value: newer.length,
        unit: 'familles',
        // Informational: a rise is a nudge to look, not a failure. Marked
        // lower-is-better so it surfaces, never `exact` — upstream ships
        // constantly and an `exact` metric would cry regression every week.
        direction: 'lower-is-better',
        detail: newer,
      },
      {
        id: 'upstream_catalogue_size',
        label: 'Taille du catalogue amont',
        value: upstream.length,
        unit: 'modèles',
        direction: 'higher-is-better',
      },
    ];
  },
};
