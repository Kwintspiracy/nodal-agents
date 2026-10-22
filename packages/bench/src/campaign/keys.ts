// campaign/keys.ts — les clés d'une campagne, dans un fichier du banc hors du dépôt.
//
// Décision D4 = a (17/10) : le propriétaire remplit UNE fois un fichier du
// banc (OpenRouter, Tavily, Firecrawl, l'adresse de son ComfyUI), lu au
// lancement de chaque campagne. Le banc ne lit JAMAIS sa base ni son
// `~/.nodalai` : déchiffrer ses secrets n'est pas un chemin.
//
// Le fichier est refusé dans le dépôt (il finirait commité) et sous le
// dossier de Nodal par défaut (ce serait une donnée de l'instance du
// propriétaire). Une clé manquante pour ce que la configuration demande est
// nommée, avant que rien ne démarre (invariant #4).

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { defaultNodalHome } from '@nodal-agents/shared/nodal-home';
import { REPO } from '../workflows/paths';
import { neededKeys, type CampaignConfig } from './config';
import { benchUserDir } from './home';

/** Le fichier de clés par défaut. `--keys <fichier>` en désigne un autre. */
export function defaultKeysFile(userHome: string = homedir()): string {
  return join(benchUserDir(userHome), 'keys.json');
}

const KeysSchema = z
  .object({
    /** Une clé par fournisseur de modèles (`openrouter`…). */
    providers: z.record(z.string(), z.string().min(1)).default({}),
    /** Une clé par connecteur (`tavily`, `firecrawl`…). */
    connectors: z.record(z.string(), z.string().min(1)).default({}),
    /** Les services locaux que des scénarios demandent (`comfyui`), et leur adresse. */
    services: z.record(z.string(), z.string().url()).default({}),
  })
  .strict();
export type CampaignKeys = z.infer<typeof KeysSchema>;

/** `inside` est-il `dir` ou sous `dir` ? (casse ignorée sous Windows) */
export function isInside(inside: string, dir: string): boolean {
  const norm = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p);
  const rel = relative(norm(dir), norm(inside));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Lit le fichier de clés et vérifie qu'il porte tout ce que la configuration
 * demande. Refuse un fichier dans le dépôt ou sous le dossier de Nodal par
 * défaut, un fichier absent, illisible ou mal formé.
 */
export function readCampaignKeys(
  file: string,
  config: CampaignConfig,
  opts: { repo?: string; userHome?: string } = {},
): CampaignKeys {
  const path = resolve(file);
  if (isInside(path, opts.repo ?? REPO)) {
    throw new Error(
      `campaign_keys_in_repo: ${path} is inside the repository; keep the bench key file outside it (default ${defaultKeysFile(opts.userHome)})`,
    );
  }
  if (isInside(path, defaultNodalHome(opts.userHome))) {
    throw new Error(
      `campaign_keys_in_nodal_home: ${path} is under your own Nodal folder; the bench never reads it`,
    );
  }
  if (!existsSync(path)) {
    throw new Error(
      `campaign_keys_missing: ${path} does not exist. Write it once: ` +
        '{ "providers": { "openrouter": "…" }, "connectors": { "tavily": "…", "firecrawl": "…" }, "services": { "comfyui": "http://127.0.0.1:8188" } }',
    );
  }
  let keys: CampaignKeys;
  try {
    keys = KeysSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (e) {
    // Le message de zod ne reprend pas les valeurs : aucune clé n'est imprimée.
    throw new Error(
      `campaign_keys_invalid: ${path}: ${String(e instanceof Error ? e.message : e)}`,
    );
  }
  const need = neededKeys(config);
  const missing = [
    ...need.providers.filter((p) => !keys.providers[p]).map((p) => `providers.${p}`),
    ...need.connectors.filter((c) => !keys.connectors[c]).map((c) => `connectors.${c}`),
  ];
  if (missing.length > 0) {
    throw new Error(
      `campaign_keys_incomplete: ${path} has no ${missing.join(', ')}, and the configuration needs them`,
    );
  }
  return keys;
}
