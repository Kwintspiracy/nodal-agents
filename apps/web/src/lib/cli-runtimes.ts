// lib/cli-runtimes.ts — LA liste des harnais CLI qu'un agent peut porter, côté
// interface.
//
// Elle existait en trois exemplaires indépendants : le `<select>` du composeur,
// le libellé de la liste d'agents, et une chaîne de mise en garde écrite au nom
// de Claude Code. Ajouter Codex (27/08) demandait de retrouver les trois. Le
// troisième — la mise en garde — aurait très bien pu être oublié : rien n'aurait
// planté, un agent Codex aurait simplement affiché le nom d'un autre harnais.
//
// La règle d'or ici : cette liste doit dire la MÊME chose que le Zod de
// `setAgentRuntimeAction` et que `resolveRuntime` côté runner. Une valeur
// proposée ici mais absente du runner donnerait un agent qui échoue à chaque
// tour, ce qui est pire que de ne pas la proposer.

/** Les runtimes servis par une CLI de code — 'nodal' n'en est pas un. */
export const CLI_RUNTIMES = ['claude-code', 'codex'] as const;
export type CliRuntimeValue = (typeof CLI_RUNTIMES)[number];

export function isCliRuntimeValue(v: string): v is CliRuntimeValue {
  return (CLI_RUNTIMES as readonly string[]).includes(v);
}

/** Le nom du harnais, tel qu'on le dit à l'utilisateur. */
export const CLI_RUNTIME_LABELS: Readonly<Record<CliRuntimeValue, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
};

/** Ce que l'option du menu annonce. */
export const CLI_RUNTIME_OPTION_LABELS: Readonly<Record<CliRuntimeValue, string>> = {
  'claude-code': 'Claude Code — your subscription',
  codex: 'Codex — your subscription',
};

/** Le libellé du moteur dans la liste des agents. */
export function cliRuntimeEngineLabel(runtime: string): string | null {
  return isCliRuntimeValue(runtime) ? `${CLI_RUNTIME_LABELS[runtime]} (subscription)` : null;
}

/**
 * La mise en garde permanente de la carte runtime, réutilisée mot pour mot dans
 * la confirmation de bascule. Elle dit ce que Nodal cesse de faire — c'est la
 * phrase la plus importante de cet écran, et elle doit nommer LE harnais choisi.
 */
export function cliRuntimeDisclaimer(runtime: CliRuntimeValue): string {
  const label = CLI_RUNTIME_LABELS[runtime];
  return (
    `This agent is driven by the ${label} harness on this machine. Nodal relays its ` +
    `messages and enforces the perimeter (workspace, budget, approvals) but does not drive ` +
    `its loop. Runs use your subscription.`
  );
}

/**
 * Le fournisseur `code_task` derrière un runtime — c'est lui qui porte le modèle
 * et l'effort par défaut (`agents.cli_defaults`), et c'est sous ce nom que
 * `cli_runs` enregistre le tour. Même correspondance que `provider.ts` côté
 * runner ; les deux doivent rester d'accord.
 */
export const CLI_RUNTIME_PROVIDER: Readonly<Record<CliRuntimeValue, 'claude' | 'codex'>> = {
  'claude-code': 'claude',
  codex: 'codex',
};
