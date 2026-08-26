// cli-runtime/audit.ts — la ligne `tool_calls` d'un appel d'outil INTERNE à une
// session CLI.
//
// Elle était construite deux fois, à l'identique, dans run-job.ts et
// run-chat.ts. La revue Codex (27/08) a trouvé que les DEUX enregistraient la
// sortie de l'outil EN CLAIR, alors que le chemin `code_task` la masque depuis
// toujours (live-events.ts). Une copie, deux fois le même trou.
//
// D'où cette fonction : PURE, donc le masquage se prouve au lieu de se relire.

import { redactSecretsForAudit, redactSecretsInText } from '@nodal-agents/shared';

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
 * Les deux masquages ne font PAS le même travail, et il faut les deux :
 *
 *   - `redactSecretsForAudit` masque par NOM DE CHAMP. Il convient à l'entrée,
 *     qui est structurée.
 *   - `redactSecretsInText` cherche des FORMES de credentials dans du texte
 *     libre. C'est le seul qui vaille pour la sortie — et c'est là que se
 *     trouve le vrai risque : ces lignes enregistrent la sortie de chaque
 *     commande interne de la CLI, donc le contenu de chaque fichier lu, jeton
 *     compris. Il rend la chaîne inchangée quand rien ne correspond.
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
}): CliAuditRow {
  return {
    toolName: `cli:${args.toolName}`,
    toolInput: redactSecretsForAudit(args.toolInput) as Record<string, unknown>,
    toolOutput: redactSecretsInText((args.toolOutput ?? '').slice(0, MAX_AUDIT_OUTPUT_CHARS)),
    toolCallId: args.toolCallId,
    durationMs: args.now - args.startedAt,
  };
}
