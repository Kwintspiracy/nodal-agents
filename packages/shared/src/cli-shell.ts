// cli-shell.ts — ce qu'un tour de CLI de code peut faire d'un shell (#494).
//
// LA règle, écrite une fois, pour toutes ses lectures :
//
//   1. l'argv d'un tour d'agent à runtime CLI (`apps/runner/src/cli-runtime`,
//      chemin job ET chemin chat) ;
//   2. l'argv d'un `code_task` (`packages/tools/src/builtin/code-task`) ;
//   3. le bloc d'équipe, qui dit au routeur qui sait lancer une commande ;
//   4. l'interrupteur « Shell commands » de la carte runtime, qui doit montrer
//      ce que le runner fera, pas ce qui est stocké.
//
// Pourquoi ici : l'écran et le runner la lisent tous les deux, et `shared` est
// le seul paquet que les deux importent. Une copie côté écran aurait dérivé à
// la première règle ajoutée.
//
// Run ef3185be (25/09) : un agent Claude Code a vu toutes ses commandes
// refusées (« requires approval »), parce que la CLI démarrait en `acceptEdits`
// sans rien d'autre et qu'en `-p` personne ne peut répondre à une demande de
// permission. L'équipe a proposé au propriétaire « j'approuverai » ou « active
// le Yolo », deux gestes qui n'atteignaient jamais la CLI.

/**
 * Les outils par lesquels Claude Code lance une commande : `Bash` partout,
 * `PowerShell` sous Windows. Nommés ensemble parce qu'en autoriser ou en
 * retirer un seul laisse la même porte ouverte sous l'autre nom. Les deux
 * noms vérifiés sur la CLI installée (2.1.283, 27/09) : autorisés, ils lancent
 * `node --version` ; retirés, le modèle ne les voit plus.
 */
export const CLAUDE_SHELL_TOOLS = ['Bash', 'PowerShell'] as const;

/**
 * Ce que le propriétaire a réglé pour les commandes d'un agent à runtime CLI
 * (`agents.cli_permissions.shell`) : `'auto'` = elles tournent sans demander ;
 * absent ou `'none'` = aucune.
 */
export type CliShellSetting = 'none' | 'auto';

/** La CLI qui sert le tour. La règle tient à ELLE, pas au nom du runtime. */
export type CodingCli = 'claude' | 'codex';

/** Ce qu'un tour peut faire d'un shell. */
export type CliShellPosture =
  /**
   * Le tour ne doit pas démarrer : la CLI ne sait pas se passer de son shell
   * et le frein d'urgence du workspace est serré.
   */
  | { readonly kind: 'refused'; readonly reason: 'auto_run_paused' }
  /** Le tour démarre sans aucun outil shell. */
  | { readonly kind: 'no_shell' }
  /**
   * Le tour lance des commandes sans demander. `tools` : les outils shell de
   * Claude à autoriser ; `'sandbox'` : Codex, que son bac à sable confine.
   */
  | { readonly kind: 'shell'; readonly tools: readonly string[] | 'sandbox' };

/**
 * La posture shell d'un tour, depuis les faits de l'agent.
 *
 * - `codex` ne sait pas retirer son shell (il se confine par un bac à sable du
 *   système, pas en retirant des outils) : il lance ses commandes dans les deux
 *   modes, et le frein d'urgence REFUSE donc le tour entier.
 * - `claude` peut perdre son shell et continuer : le frein le lui retire, le
 *   tour reste permis (une conversation, une relecture, une édition de
 *   fichier). Sinon il a un shell seulement en écriture, seulement si le
 *   propriétaire a réglé `shell: 'auto'`, et seulement les outils shell que
 *   `extraDisallowed` n'interdit pas : l'interdiction l'emporte toujours, et
 *   un réglage `auto` que la liste vide entièrement n'est pas un shell.
 *
 * `perms` à `null` (un `code_task`, qui n'a pas de réglage shell) : aucun shell
 * pour Claude. Une commande qui devrait attendre une approbation en `-p` ne
 * serait jamais approuvée ; mieux vaut que le modèle le sache d'entrée.
 */
export function cliShellPosture(
  cli: CodingCli,
  perms: {
    mode?: 'read' | 'write';
    shell?: CliShellSetting;
    extraDisallowed?: readonly string[];
  } | null,
  opts: { autoRunPaused: boolean },
): CliShellPosture {
  if (cli === 'codex') {
    return opts.autoRunPaused
      ? { kind: 'refused', reason: 'auto_run_paused' }
      : { kind: 'shell', tools: 'sandbox' };
  }
  if (opts.autoRunPaused) return { kind: 'no_shell' };
  if ((perms?.mode ?? 'read') !== 'write' || perms?.shell !== 'auto') return { kind: 'no_shell' };
  const banned = new Set(perms.extraDisallowed ?? []);
  const tools = CLAUDE_SHELL_TOOLS.filter((t) => !banned.has(t));
  return tools.length === 0 ? { kind: 'no_shell' } : { kind: 'shell', tools };
}
