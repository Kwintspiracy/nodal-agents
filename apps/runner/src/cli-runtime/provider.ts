// cli-runtime/provider.ts — LE point où la valeur `agents.runtime` devient une
// CLI, et le seul.
//
// Le chemin job et le chemin chat posaient chacun leur propre garde
// (`runtime !== 'claude-code'`). Deux copies de la même règle, dans deux
// fichiers : au moment d'ouvrir Codex (27/08), la première question a été
// « combien d'endroits faut-il changer, et est-ce que je les vois tous ? ».
// C'est la question qu'on ne veut plus jamais se poser.
//
// Un seul tableau, donc. Ajouter une CLI, c'est ajouter une ligne ici et son
// module de tour — pas relire deux fichiers en espérant n'en oublier aucun.

import { runClaudeTurn, ClaudeCliNotFoundError } from './claude-turn.ts';
import type { ClaudeTurnOptions, ClaudeTurnResult } from './claude-turn.ts';
import {
  runCodexTurn,
  CodexCliNotFoundError,
  CodexRestrictionsUnsupportedError,
} from './codex-turn.ts';

/** Le contrat commun d'un tour, quel que soit le CLI derrière. */
export type CliTurnOptions = ClaudeTurnOptions;
export type CliTurnResult = ClaudeTurnResult;

/** Le nom du fournisseur tel que `cli_runs` et `cli_sessions` l'enregistrent. */
export type CliProvider = 'claude' | 'codex';

interface RuntimeBinding {
  provider: CliProvider;
  run: (opts: CliTurnOptions) => Promise<CliTurnResult>;
  /** Ce que `tools_used` porte sur le job terminé. */
  toolLabel: string;
}

const RUNTIMES: Readonly<Record<string, RuntimeBinding>> = {
  'claude-code': { provider: 'claude', run: runClaudeTurn, toolLabel: 'cli:claude-code' },
  codex: { provider: 'codex', run: runCodexTurn, toolLabel: 'cli:codex' },
};

/**
 * La CLI d'un runtime, ou `null` quand ce runtime n'est pas servi ici.
 *
 * `null` couvre `'nodal'` (qui n'a rien à faire sur ce chemin) comme une valeur
 * inconnue arrivée d'une base plus récente. L'appelant échoue fort dans les deux
 * cas, en nommant la valeur reçue (invariant #4).
 */
export function resolveRuntime(runtime: string): RuntimeBinding | null {
  return RUNTIMES[runtime] ?? null;
}

/**
 * Vrai pour une erreur de CONFIGURATION qui empêche de lancer le tour : le
 * binaire absent, ou une restriction que ce harnais ne sait pas appliquer.
 *
 * Ces cas-là deviennent un job échoué avec un message actionnable, jamais une
 * exception non rattrapée — et jamais, surtout, un tour lancé quand même.
 */
export function isCliSetupError(err: unknown): err is Error {
  return (
    err instanceof ClaudeCliNotFoundError ||
    err instanceof CodexCliNotFoundError ||
    err instanceof CodexRestrictionsUnsupportedError
  );
}
