// workflows/paths.ts — où le banc écrit, depuis le dépôt qui le lance.

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
/** Une ligne par essai, ajoutée, jamais réécrite. */
export const RESULTS_FILE = join(REPO, 'apps', 'qa', 'data', 'workflows.ndjson');
/** Le catalogue des scénarios que lisent le portail et Bench Studio. */
export const CATALOG_FILE = join(REPO, 'apps', 'qa', 'data', 'workflow-catalog.json');
