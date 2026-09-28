// partial-total.ts — un total sur des lignes dont certaines ne rapportent pas
// la valeur.
//
// Revue Codex de #571 : un usage inconnu ne devient jamais un nombre. Le runner
// écrit NULL dans `agent_jobs.input_tokens`, `output_tokens` et
// `total_cost_usd` quand un appel du job n'a pas rapporté son compte. Un
// `coalesce(sum(x), 0)` saute ces lignes et rend « tout inconnu » comme 0, et
// des lignes mêlées comme un total complet : une sous-estimation muette. Un
// total dit donc ce qu'il connaît ET combien de lignes il ne connaît pas.

/** `known` : la somme des lignes qui rapportent. `unreported` : les autres. */
export interface PartialTotal {
  known: number;
  unreported: number;
}

/**
 * Le total tel qu'il se lit : exact quand rien ne manque, « au moins » sinon,
 * « unknown » quand aucune ligne ne rapporte.
 */
export function formatPartial(total: PartialTotal, format: (n: number) => string): string {
  if (total.unreported === 0) return format(total.known);
  if (total.known === 0) return 'unknown';
  return `≥ ${format(total.known)}`;
}

/** « 1 run not reported », « 3 runs not reported » ; rien quand rien ne manque. */
export function unreportedNote(total: PartialTotal): string | undefined {
  if (total.unreported === 0) return undefined;
  return `${total.unreported} ${total.unreported === 1 ? 'run' : 'runs'} not reported`;
}
