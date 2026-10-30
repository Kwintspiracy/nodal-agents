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

import { conversationIdsAsHandles } from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import type { CommandsPlacement } from '@nodal-agents/shared';
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

/** Les valeurs de `agents.runtime` que ce runner sert par une CLI. */
export const SERVED_CLI_RUNTIMES: readonly string[] = Object.keys(RUNTIMES);

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
 * OÙ TOURNENT LES COMMANDES d'un agent de ce runtime (#876) — lu par l'écran du
 * bac à sable (GET /api/sandbox), décidé ICI, à côté du tableau qui dit
 * comment chaque runtime est servi :
 *   - `nodal` (la valeur par défaut de `agents.runtime`) : ses commandes sont
 *     les outils de Nodal (`run_command`, `run_skill_script`), donc le moteur
 *     shell, donc le bac à sable → `sandbox` ;
 *   - un runtime de ce tableau : la CLI de code lance ses commandes elle-même,
 *     dans son propre processus (`JobProcessScope.startOwned`), hors du bac à
 *     sable de Nodal → `outside` ;
 *   - toute autre valeur : un runtime que ce runner ne sert pas (une base plus
 *     récente) → `unknown`, jamais supposé confiné.
 * Ajouter une CLI au tableau la range d'elle-même dans `outside`.
 */
export function commandsPlacement(runtime: string): CommandsPlacement {
  if (resolveRuntime(runtime)) return 'outside';
  return runtime === 'nodal' ? 'sandbox' : 'unknown';
}

/**
 * Ce qu'une CLI reçoit à lire, tel qu'il part chez son fournisseur : la frontière du
 * runtime CLI pour les adresses de conversation (#824, passe 1 de la revue),
 * comme `addressedByHandle` l'est du runtime Nodal. Le message et le prompt
 * système d'une CLI sont TOUT ce que le runner lui donne à lire (elle n'a
 * aucun outil Nodal : `--strict-mcp-config` sans configuration) ; chaque
 * identifiant de conversation connu de l'entité y devient son handle.
 *
 * Ce que cette frontière ne voit pas : la transcription d'une session REPRISE
 * (`resumeSessionId`, run-job.ts / run-chat.ts) vit dans le stockage de la
 * CLI elle-même, hors de portée du runner.
 *
 * Rend les options du tour ; le LANCEMENT reste aux deux points qui posent
 * l'intention (le tour y est lancé sur `await cliTurnForModel(…)`, run-job.ts et
 * run-chat.ts — architecture.test.ts).
 */
export async function cliTurnForModel(
  scope: { db: AnyDrizzleDb; entityId: string | null; agentId: string },
  opts: CliTurnOptions,
): Promise<CliTurnOptions> {
  // The job's workspace, else its agent's (the one place it is derived,
  // `conversationIdsAsHandles`); none → the turn is refused, never sent raw.
  const shown = await conversationIdsAsHandles(
    scope.db,
    {
      entityId: scope.entityId,
      agentId: scope.agentId,
      subject: `a CLI turn of agent ${scope.agentId}`,
    },
    { message: opts.message, personality: opts.personality },
  );
  return { ...opts, message: shown.message, personality: shown.personality };
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
