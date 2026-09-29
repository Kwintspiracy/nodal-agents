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

/**
 * La CLI qui sert chaque valeur de `agents.runtime` autre que `nodal`. Le
 * registre du runner (`apps/runner/src/cli-runtime/provider.ts`) doit s'y
 * aligner, et un test l'y tient ; le bloc d'équipe la lit pour annoncer la
 * posture shell d'un coéquipier, sans importer le runner.
 */
export const RUNTIME_CLI: Readonly<Record<string, CodingCli>> = {
  'claude-code': 'claude',
  codex: 'codex',
};

/**
 * Pourquoi le frein arrête un tour qui aurait un shell : il est serré, ou son
 * état ne se lit pas. Un frein illisible n'est pas un frein desserré
 * (invariant #4) : il arrête le tour et le dit.
 */
export type BrakeStop = 'auto_run_paused' | 'auto_run_state_unreadable';

/** Ce qu'un tour peut faire d'un shell. */
export type CliShellPosture =
  /**
   * Le tour ne doit pas démarrer : la CLI ne sait pas se passer de son shell
   * et le frein d'urgence du workspace est serré (ou illisible).
   */
  | { readonly kind: 'refused'; readonly reason: BrakeStop }
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

/** Les outils shell de Claude qu'une posture autorise (vide = aucun). */
export function claudeShellTools(posture: CliShellPosture): readonly string[] {
  return posture.kind === 'shell' && posture.tools !== 'sandbox' ? posture.tools : [];
}

/**
 * Les drapeaux shell de l'argv de Claude, écrits une fois pour les deux argv
 * qui le lancent en `-p` : le tour d'agent (`claude-turn.ts`) et le
 * `code_task`. En `-p`, personne ne répond à une demande de permission :
 * chaque outil shell est soit autorisé d'avance, soit retiré de la palette, et
 * le modèle sait dès le départ ce qu'il a. `extraDisallowed` rejoint les
 * outils retirés.
 */
export function claudeShellFlags(
  shellTools: readonly string[],
  extraDisallowed: readonly string[] = [],
): string[] {
  const allowed = CLAUDE_SHELL_TOOLS.filter((t) => shellTools.includes(t));
  const disallowed = [
    ...CLAUDE_SHELL_TOOLS.filter((t) => !allowed.includes(t)),
    ...extraDisallowed,
  ];
  return [
    ...(allowed.length > 0 ? ['--allowedTools', allowed.join(',')] : []),
    ...(disallowed.length > 0 ? ['--disallowedTools', disallowed.join(',')] : []),
  ];
}
