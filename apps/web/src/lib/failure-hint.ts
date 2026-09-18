// failure-hint.ts — LE GESTE QU'UN ÉCHEC APPELLE, dit par l'écran (#184).
//
// Le harnais ne conseille pas : il pose un fait. Un job qui meurt sur un refus
// du fournisseur porte un champ typé, `hint: 'switch_model'`, et pas une
// phrase (#119, invariant #2 — le runner se tait, le modèle ou l'écran parle).
// La phrase, en anglais et dans la langue de la personne qui lit, vit donc ICI.
//
// D'OÙ VIENT LE CODE, PUISQUE LE CHAMP N'EST PAS EN BASE. Le `hint` du runner
// voyage en mémoire jusqu'au parent (`delegationRecordFromOutcome`), et dans le
// résultat d'outil que le modèle parent lit. Il n'atteint JAMAIS la base :
// `agent_jobs` n'a pas de colonne pour lui, et un `assign_*` n'écrit pas de
// ligne d'audit (`conversation-feed.ts` le dit : « execute() lève avant
// d'écrire »). Le seul fait persisté de ce refus est le CODE D'ERREUR du job,
// écrit par `providerRejectionCode` (`apps/runner/src/job/execute.ts`) :
// `provider_rejected_request:<fournisseur>/<modèle> (http <n>, turn <n>)`.
// L'écran lit donc le même fait que le runner, et en tire le même geste.
//
// ⚠️ DEUX ENDROITS NOMMENT CE GESTE tant que le champ n'est pas persisté : le
// site du refus dans le runner, et la table ci-dessous. Ils ne peuvent pas se
// contredire — ils disent la même chose du même code — mais ils peuvent se
// désynchroniser : un `hint` ajouté côté runner pour un autre échec resterait
// MUET à l'écran jusqu'à ce que quelqu'un l'ajoute ici. C'est le sens du
// silence choisi plus bas : un geste inconnu ne rend RIEN, jamais un slug brut.
// Issue de suite : porter le champ en base, pour que l'écran lise le mot du
// runner au lieu de le relire du code d'erreur.

/** Les gestes que l'écran sait dire. Même liste que `JobFailureHint` (#119). */
export type FailureHint = 'switch_model';

/**
 * Le préfixe que `providerRejectionCode` écrit dans `agent_jobs.error`. C'est
 * un CONTRAT de données, pas une heuristique de texte : le code est fabriqué
 * par une seule fonction, et il commence par ce mot-là.
 */
const PROVIDER_REJECTED = 'provider_rejected_request';

/**
 * Le geste que cet échec appelle, lu sur ce qui est PERSISTÉ, ou `null`.
 *
 * `null` est la réponse normale : la grande majorité des échecs n'appellent
 * aucun geste nommable, et inventer une suggestion pour eux serait pire que le
 * silence.
 */
export function failureHint(error: string | null | undefined): FailureHint | null {
  if (typeof error !== 'string') return null;
  return error.startsWith(PROVIDER_REJECTED) ? 'switch_model' : null;
}

/** Ce que l'écran DIT de chaque geste. Court, en anglais, une phrase par code. */
const HINT_SENTENCE: Readonly<Record<FailureHint, string>> = {
  switch_model: 'Try another model for this agent',
};

/**
 * La phrase à afficher, ou `null` quand il n'y a rien à dire.
 *
 * Prend un `string` et non un `FailureHint` exprès : un code venu d'une version
 * du runner plus récente que cet écran ne doit pas s'afficher en slug brut. Il
 * ne se dit pas, point.
 */
export function hintSentence(hint: string | null | undefined): string | null {
  if (typeof hint !== 'string') return null;
  return HINT_SENTENCE[hint as FailureHint] ?? null;
}
