// sandbox-settings.ts — le réglage du bac à sable d'UN espace (#876).
//
// Deux faits, et seulement deux, que l'utilisateur pose depuis Réglages →
// Safety → Sandbox :
//
//   - `enabled` : l'interrupteur de l'espace (`entities.sandbox_enabled`),
//     allumé par défaut. Coupé, les commandes de l'espace tournent sans
//     confinement, et chaque résultat le dit (`SANDBOX_DISABLED`) ;
//   - `folders` : SES gestes sur la liste des dossiers permis
//     (`entities.sandbox_folders`) — les dossiers qu'il a AJOUTÉS, et les
//     dossiers détectés qu'il a RETIRÉS. Jamais la liste calculée : un
//     magasin installé plus tard (Ollama, par exemple) apparaît tout seul,
//     parce que la détection est refaite à chaque ouverture de conteneur
//     (`composeAllowedFolders`, @nodal-agents/sandbox policy.ts).
//
// Un réglage illisible n'est jamais lu comme « allumé » ni comme « éteint »
// (invariant #4) : le parseur LÈVE `SANDBOX_SETTINGS_UNREADABLE`, et la
// commande qui en dépendait est refusée avec ce code.
//
// Le module est bundlé côté client (l'écran des réglages) : aucun import `node:`.

import { z } from 'zod';

/** Les gestes de l'utilisateur sur la liste des dossiers permis. */
export const SandboxFoldersSchema = z
  .object({
    /** Les dossiers ajoutés, chemins absolus, dans l'ordre de l'ajout. */
    added: z.array(z.string().min(1)),
    /** Les dossiers DÉTECTÉS que l'utilisateur a retirés, chemins absolus. */
    removed: z.array(z.string().min(1)),
  })
  .strict();
export type SandboxFolders = z.infer<typeof SandboxFoldersSchema>;

/** Le réglage d'un espace, tel que le moteur le relit à chaque lancement. */
export interface WorkspaceSandbox {
  readonly enabled: boolean;
  readonly folders: SandboxFolders;
}

/** Aucun geste : l'interrupteur allumé, la liste détectée telle quelle. */
export const DEFAULT_WORKSPACE_SANDBOX: WorkspaceSandbox = Object.freeze({
  enabled: true,
  folders: Object.freeze({ added: [], removed: [] }) as SandboxFolders,
});

/** Le code d'un réglage que la base rend sous une forme que rien ne sait lire. */
export const SANDBOX_SETTINGS_UNREADABLE = 'SANDBOX_SETTINGS_UNREADABLE';

/**
 * La colonne `sandbox_folders`, parsée. LÈVE `SANDBOX_SETTINGS_UNREADABLE`
 * avec ce qui ne va pas : une forme inconnue n'est jamais remplacée par une
 * liste vide, qui retirerait en silence les dossiers que l'utilisateur a
 * ajoutés.
 */
export function parseSandboxFolders(raw: unknown): SandboxFolders {
  const parsed = SandboxFoldersSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${SANDBOX_SETTINGS_UNREADABLE}: sandbox_folders ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}

// ─── Ce que le runner dit du bac à sable (GET /api/sandbox) ──────────────────
//
// Le runner est le SEUL à savoir l'état du bac à sable, ses limites et son
// périmètre sur cette machine : il le rend en codes et en chemins (invariant
// #2), le web le lit, le valide par ce schéma et en fait des phrases. Rien
// n'est recalculé côté web.

const SandboxStatusSchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('available'),
    backend: z.string(),
    /** Chaque limite commence par son code stable (`SANDBOX_…: …`). */
    limits: z.array(z.string()).optional(),
  }),
  z.object({
    state: z.literal('unavailable'),
    code: z.string(),
    /** La raison telle que le backend ou l'OS l'a donnée : une donnée, citée. */
    reason: z.string(),
  }),
]);

export const ALLOWED_FOLDER_SOURCES = [
  'tool-cache',
  'comfyui',
  'ollama',
  'huggingface',
  'docker',
  'user',
] as const;
export type AllowedFolderSourceKey = (typeof ALLOWED_FOLDER_SOURCES)[number];

/**
 * Où tournent les commandes d'un agent, selon son runtime — un fait du RUNNER
 * (`commandsPlacement`, apps/runner/src/cli-runtime/provider.ts) :
 *   - `sandbox` : par les outils de Nodal, donc dans ce bac à sable ;
 *   - `outside` : par le harnais d'une CLI de code, hors de ce bac à sable ;
 *   - `unknown` : un runtime que ce runner ne sert pas (une base plus récente).
 */
export const COMMANDS_PLACEMENTS = ['sandbox', 'outside', 'unknown'] as const;
export type CommandsPlacement = (typeof COMMANDS_PLACEMENTS)[number];

const SandboxAgentSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** La valeur de `agents.runtime` (`nodal`, `claude-code`, `codex`…). */
  runtime: z.string(),
  commands: z.enum(COMMANDS_PLACEMENTS),
});
export type SandboxAgent = z.infer<typeof SandboxAgentSchema>;

export const SandboxStateSchema = z.object({
  /** Le système du runner (`win32`, `darwin`, `linux`…). */
  platform: z.string(),
  status: SandboxStatusSchema,
  /** L'interrupteur de l'espace. */
  enabled: z.boolean(),
  /** Les dossiers permis, composés (détectés − retirés + ajoutés), chacun avec son état. */
  allowedFolders: z.array(
    z.object({
      path: z.string(),
      source: z.enum(ALLOWED_FOLDER_SOURCES),
      state: z.enum(['allowed', 'removed', 'missing', 'refused']),
    }),
  ),
  /**
   * Les dossiers des agents actifs, UN par dossier réel (le même dossier
   * attaché à deux agents n'apparaît qu'une fois, avec les deux), dans l'ordre
   * de leur premier agent. Le regroupement est fait par le runner, qui sait
   * comparer deux chemins sur ce système.
   */
  agentFolders: z.array(z.object({ path: z.string(), agents: z.array(SandboxAgentSchema) })),
  /** Les agents actifs sans dossier à eux : ils n'écrivent que dans le dossier partagé. */
  agentsWithoutFolder: z.array(SandboxAgentSchema),
  /** Le dossier partagé de l'espace, que tout agent écrit ; `null` s'il n'a pas pu être créé. */
  sharedFolder: z.string().nullable(),
  /**
   * Combien de dossiers DISTINCTS une commande confinée peut écrire : les
   * dossiers des agents, le partagé, et les dossiers permis à l'état `allowed`
   * — hors le dossier attaché à une demande et le temporaire de chaque run, qui
   * n'existent que pendant un run.
   */
  writableFolderCount: z.number().int().nonnegative(),
  /** Les dossiers de données de Nodal qu'une commande confinée ne lit pas. */
  readRefused: z.array(z.string()),
  /** Les ports de Nodal refusés par le proxy, ou le code qui dit qu'ils sont inconnus. */
  network: z.union([
    z.object({ deniedPorts: z.array(z.number().int()) }),
    z.object({ code: z.string(), reason: z.string() }),
  ]),
});
export type SandboxState = z.infer<typeof SandboxStateSchema>;
