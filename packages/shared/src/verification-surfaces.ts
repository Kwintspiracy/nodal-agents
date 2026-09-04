// verification-surfaces.ts — quelles façons de travailler sont sous
// vérification (D8, plan « Vérifier & Corriger »).
//
// L'utilisateur décide : par espace, une case par SURFACE — les quatre lignes
// de la matrice des écrivains du plan. Cochée = les travaux venant de cette
// surface posent une intention de mutation et sont prouvés. Décochée = aucune
// intention, et le run le DIT (« surface hors vérification »), jamais en
// silence.
//
// DIVERGENCE VOULUE avec parseRootGrants (root-agent.ts) : là-bas une
// capacité NEUVE absente d'un objet stocké vaut `false` — un pouvoir de plus
// ne se donne jamais rétroactivement. Ici c'est l'INVERSE : une surface absente
// vaut `true` (D8 : « défaut : toutes activées »). Une surface ajoutée demain
// entre sous vérification sans geste, parce que vérifier n'est pas un pouvoir
// donné à l'agent, c'est une garde posée sur lui. Sans ce paragraphe, le
// prochain lecteur « corrigerait » le défaut et la phase d'observation de PR①
// ne mesurerait plus rien.
//
// Le module est bundlé côté client (réglages de l'espace) : aucun import `node:`.

import { z } from 'zod';

/**
 * Les quatre surfaces, dans l'ordre de la matrice du plan. Scinder `shell` en
 * `runCommand` / `runSkillScript` demain est UNE ligne dans
 * VERIFICATION_SURFACE_TOOLS, rien d'autre ne bouge.
 */
export const VERIFICATION_SURFACE_KEYS = ['codeTask', 'cliRuntime', 'fileOps', 'shell'] as const;
export type VerificationSurfaceKey = (typeof VERIFICATION_SURFACE_KEYS)[number];

export const VerificationSurfacesSchema = z.object({
  codeTask: z.boolean(),
  cliRuntime: z.boolean(),
  fileOps: z.boolean(),
  shell: z.boolean(),
});
export type VerificationSurfaces = z.infer<typeof VerificationSurfacesSchema>;

/** D8 : toutes activées par défaut. */
export const DEFAULT_VERIFICATION_SURFACES: Readonly<VerificationSurfaces> = Object.freeze({
  codeTask: true,
  cliRuntime: true,
  fileOps: true,
  shell: true,
});

/**
 * La table de correspondance outil → surface. Source UNIQUE : le seam
 * d'exécution des outils et le runtime CLI la lisent tous deux, une seconde
 * liste finirait par diverger de celle-ci (c'est arrivé au frein d'urgence).
 * `cliRuntime` n'a pas d'outil : la surface est le runtime lui-même.
 */
export const VERIFICATION_SURFACE_TOOLS: Readonly<
  Record<VerificationSurfaceKey, readonly string[]>
> = Object.freeze({
  codeTask: ['code_task'],
  cliRuntime: [],
  fileOps: ['file_write', 'file_edit'],
  shell: ['run_command', 'run_skill_script'],
});

/** La surface d'un outil mutant, ou null pour un outil qui n'en a pas. */
export function surfaceForTool(toolName: string): VerificationSurfaceKey | null {
  for (const key of VERIFICATION_SURFACE_KEYS) {
    if (VERIFICATION_SURFACE_TOOLS[key].includes(toolName)) return key;
  }
  return null;
}

/**
 * Lit la valeur jsonb stockée. Ne lève JAMAIS : zod d'abord, puis repli champ
 * par champ — un champ absent ou malformé vaut son défaut (`true`), les autres
 * gardent leur valeur. `'{}'`, le défaut de la colonne, rend donc « tout coché »
 * sans qu'aucun backfill n'ait eu à deviner.
 */
export function parseVerificationSurfaces(raw: unknown): VerificationSurfaces {
  const strict = VerificationSurfacesSchema.safeParse(raw);
  if (strict.success) return strict.data;
  const src =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const pick = (key: VerificationSurfaceKey): boolean =>
    typeof src[key] === 'boolean' ? (src[key] as boolean) : DEFAULT_VERIFICATION_SURFACES[key];
  return {
    codeTask: pick('codeTask'),
    cliRuntime: pick('cliRuntime'),
    fileOps: pick('fileOps'),
    shell: pick('shell'),
  };
}
