// cli-runtime/audit.ts — la ligne `tool_calls` d'un appel d'outil INTERNE à une
// session CLI.
//
// Elle était construite deux fois, à l'identique, dans run-job.ts et
// run-chat.ts. La revue Codex (27/08) a trouvé que les DEUX enregistraient la
// sortie de l'outil EN CLAIR, alors que le chemin `code_task` la masque depuis
// toujours (live-events.ts). Une copie, deux fois le même trou.
//
// D'où cette fonction : PURE, donc le masquage se prouve au lieu de se relire.

import { maskToolResultText, redactSecrets, type ToolResultMaskPolicy } from '@nodal-agents/shared';

/**
 * Plafond par ligne d'audit. La sortie d'un outil peut peser des mégaoctets
 * (un `Read` sur un gros fichier) ; l'audit doit dire CE QUI s'est passé, pas
 * archiver le contenu du dépôt. Même valeur que le chemin `code_task`.
 */
export const MAX_AUDIT_OUTPUT_CHARS = 8_000;

export interface CliAuditRow {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolOutput: string;
  toolCallId: string;
  durationMs: number;
}

/**
 * Ce qu'on écrit pour un appel d'outil interne, prêt à insérer.
 *
 * Un seul masqueur, sous ses deux formes :
 *
 *   - `redactSecrets` pour l'entrée, structurée : un champ dont le NOM dit
 *     secret est masqué en entier, et CHAQUE chaîne est masquée par forme —
 *     pour une CLI, l'entrée est du texte libre (`command`, `content`,
 *     `new_string`), pas seulement des champs nommés ;
 *   - pour la sortie, la frontière des résultats d'outil
 *     (`maskToolResultText`, la même que `executeTool`) : les valeurs exactes
 *     que Nodal garde pour l'espace, puis les formes selon le réglage de
 *     l'agent. Ces lignes enregistrent la sortie de chaque commande interne de
 *     la CLI, donc le contenu de chaque fichier lu, jeton compris. Ce que la
 *     CLI a lu est parti chez son fournisseur sans passer par Nodal : Nodal ne
 *     masque que ce qu'il range et montre.
 *
 * La sortie est masquée AVANT d'être coupée au plafond : une valeur à cheval
 * sur la coupe ne serait plus reconnue, et son début resterait lisible.
 *
 * Le nom est préfixé `cli:` pour qu'un `Read` interne ne soit jamais confondu
 * avec un builtin Nodal dans les écrans Runs et Logs.
 */
export function buildCliAuditRow(args: {
  toolName: string;
  toolInput: unknown;
  toolOutput: string | undefined;
  toolCallId: string;
  startedAt: number;
  now: number;
  /** The agent's policy for its tool results (`loadToolResultMaskPolicy`). */
  policy: ToolResultMaskPolicy;
}): CliAuditRow {
  return {
    toolName: `cli:${args.toolName}`,
    toolInput: redactSecrets(args.toolInput) as Record<string, unknown>,
    toolOutput: maskToolResultText(args.toolOutput ?? '', args.policy).slice(
      0,
      MAX_AUDIT_OUTPUT_CHARS,
    ),
    toolCallId: args.toolCallId,
    durationMs: args.now - args.startedAt,
  };
}
