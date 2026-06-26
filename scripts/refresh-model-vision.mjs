// scripts/refresh-model-vision.mjs
//
// Refresh the vision-capable model list from the providers themselves, so the
// VISION_MODEL_IDS set in packages/shared/src/model-catalog.ts never has to be
// guessed. Sources of truth:
//   - OpenRouter   https://openrouter.ai/api/v1/models  → architecture.input_modalities
//   - models.dev   https://models.dev/api.json          → modalities.input
// A model is "vision" when its input modalities include "image".
//
// Usage:
//   node scripts/refresh-model-vision.mjs
//
// It reads the model ids already in MODEL_CATALOG (by scanning the source file),
// reports each one's vision status from the live data, and prints a ready-to-paste
// VISION_MODEL_IDS block. No network creds needed (both endpoints are public).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const catalogPath = join(here, '..', 'packages', 'shared', 'src', 'model-catalog.ts');

// Pull every `modelId: '...'` out of the catalog source — that's the set of
// models we ship in the picker and therefore want capabilities for.
const src = readFileSync(catalogPath, 'utf8');
const catalogIds = [...src.matchAll(/modelId:\s*'([^']+)'/g)].map((m) => m[1]);

const hasImage = (mods) => Array.isArray(mods) && mods.map(String).includes('image');

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nodal-agents-model-refresh' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

// OpenRouter: id → input_modalities
const orVision = new Map();
try {
  const or = await fetchJson('https://openrouter.ai/api/v1/models');
  for (const m of or.data ?? []) orVision.set(m.id, m.architecture?.input_modalities ?? []);
  console.log(`OpenRouter: ${orVision.size} models`);
} catch (e) {
  console.warn('OpenRouter fetch failed:', e.message);
}

// models.dev: provider → models → model → modalities.input. Index by the bare
// model id AND by `<provider>/<id>` so native + namespaced forms both resolve.
const mdVision = new Map();
try {
  const md = await fetchJson('https://models.dev/api.json');
  for (const [provider, p] of Object.entries(md)) {
    for (const [id, model] of Object.entries(p.models ?? {})) {
      const mods = model.modalities?.input ?? [];
      mdVision.set(id, mods);
      mdVision.set(`${provider}/${id}`, mods);
    }
  }
  console.log(`models.dev: ${mdVision.size} entries`);
} catch (e) {
  console.warn('models.dev fetch failed:', e.message);
}

const vision = [];
const unknown = [];
for (const id of catalogIds) {
  const mods = orVision.get(id) ?? mdVision.get(id);
  if (mods === undefined) {
    unknown.push(id);
    continue;
  }
  if (hasImage(mods)) vision.push(id);
}

console.log('\n── Vision-capable (paste into VISION_MODEL_IDS) ──');
console.log(vision.map((id) => `  '${id}',`).join('\n'));
if (unknown.length) {
  console.log('\n── Not found in either source (verify by hand) ──');
  console.log(unknown.map((id) => `  ${id}`).join('\n'));
}
