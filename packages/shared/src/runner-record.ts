// runner-record.ts — le relevé que le runner joint à un échange rejoué (#562).
//
// Ce que le runner sait d'un tour passé — ses actions réelles, ses délégations
// et leur issue, le texte d'autres jobs qu'il a recompilé — voyage dans un
// message à part, de rôle utilisateur, APRÈS l'échange. Jamais dans une part
// assistant : un modèle continue ce qu'il a écrit, et il avait « écrit » ces
// lignes (run b7ecc59a, 28/09).
//
// La provenance est STRUCTURELLE : les entrées vivent dans
// `providerOptions.nodal.runnerRecord`, un champ que seul le runner produit.
// Un message de la personne est une chaîne tirée de sa tâche ; il ne porte
// jamais ce champ, quel que soit son texte. Un préfixe de texte, lui, se
// falsifie : le propriétaire peut écrire « [système] » (revue Codex de #576).
// Les fournisseurs ne lisent que leur propre espace de `providerOptions`,
// celui-ci ne part donc chez aucun.
//
// Le TEXTE que lit le modèle reste le minimum factuel : la marque `[système]`
// que le runner pose sur toutes ses relances, puis les entrées. Aucune phrase :
// l'écran, lui, rend le relevé depuis la structure, avec son propre libellé
// (invariant #2).

export const RUNNER_RECORD_NAMESPACE = 'nodal';

/** Le message d'un relevé, tel qu'il entre dans la transcription. */
export interface RunnerRecordMessage {
  role: 'user';
  content: string;
  providerOptions: { nodal: { runnerRecord: string[] } };
}

export function runnerRecordMessage(entries: readonly string[]): RunnerRecordMessage {
  return {
    role: 'user',
    content: ['[système]', ...entries].join('\n'),
    providerOptions: { [RUNNER_RECORD_NAMESPACE]: { runnerRecord: [...entries] } },
  };
}

/** Les entrées d'un relevé du runner, ou `null` si ce message n'en est pas un. */
export function runnerRecordEntries(message: unknown): string[] | null {
  if (typeof message !== 'object' || message === null) return null;
  const m = message as { role?: unknown; providerOptions?: unknown };
  if (m.role !== 'user') return null;
  const ns = (m.providerOptions as Record<string, unknown> | undefined)?.[RUNNER_RECORD_NAMESPACE];
  const entries = (ns as { runnerRecord?: unknown } | undefined)?.runnerRecord;
  if (!Array.isArray(entries) || !entries.every((e) => typeof e === 'string')) return null;
  return entries as string[];
}
