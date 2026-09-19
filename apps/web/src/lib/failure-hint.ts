// failure-hint.ts — LE GESTE QU'UN ÉCHEC APPELLE, dit par l'écran (#184, #193).
//
// Le harnais ne conseille pas : il pose un fait. Un job qui meurt sur un refus
// du fournisseur porte un champ typé, `hint: 'switch_model'`, et pas une
// phrase (#119, invariant #2 — le runner se tait, le modèle ou l'écran parle).
// La phrase, en anglais et dans la langue de la personne qui lit, vit donc ICI.
//
// D'OÙ VIENT LE GESTE. De la BASE, depuis #193 : `agent_jobs.failure_hint`
// porte le mot que le runner a décidé, écrit par `failJob`. L'écran ne le
// DÉDUIT plus du code d'erreur. Ce qu'il faisait avant, et pourquoi c'était à
// changer : la correspondance « ce code appelle ce geste » était écrite deux
// fois — au site du refus dans le runner, et ici. Les deux ne pouvaient pas se
// contredire, puisqu'elles lisaient le même code, mais un geste ajouté côté
// runner pour un autre échec restait MUET ici jusqu'à ce que quelqu'un y
// ajoute sa ligne. Un seul auteur, maintenant : le runner.
//
// LE TYPE EST PARTAGÉ, PAS RECOPIÉ (#194, revue passe 1). Il vit dans
// `@nodal-agents/shared` : le runner le pose, cet écran le lit. Recopié, un
// renommage d'un côté rendait l'écran muet avec tous les tests au vert.
//
// CE QUI RESTE ÉCRIT ICI, et nulle part ailleurs : la PHRASE de chaque geste.
// Un geste que cet écran ne connaît pas ne rend RIEN — jamais un slug brut. Un
// runner plus récent que l'écran est donc silencieux, pas bavard en jargon.

import type { JobFailureHint } from '@nodal-agents/shared';

/** Les gestes que l'écran sait dire — le type du harnais, jamais une copie. */
export type FailureHint = JobFailureHint;

/** Ce que l'écran DIT de chaque geste. Court, en anglais, une phrase par geste. */
const HINT_SENTENCE: Readonly<Record<FailureHint, string>> = {
  switch_model: 'Try another model for this agent',
};

/**
 * Le geste écrit en base, RENDU AU TYPE quand l'écran le connaît, sinon `null`.
 *
 * `null` est la réponse normale, pour deux raisons qui ne se confondent pas :
 * l'échec n'appelait aucun geste nommable (le cas de la grande majorité), ou le
 * runner en a nommé un que cette version de l'écran ne sait pas dire. Les deux
 * se rendent pareil — par le silence — parce qu'un slug brut affiché ne serait
 * un conseil pour personne.
 *
 * `Object.hasOwn` et non `in` : `in` traverse la chaîne de prototypes, et
 * `'toString' in HINT_SENTENCE` est VRAI. Le champ arrive de la base en texte
 * libre — une valeur homonyme d'un membre d'`Object.prototype` serait passée
 * pour un geste connu.
 */
export function knownHint(hint: string | null | undefined): FailureHint | null {
  if (typeof hint !== 'string') return null;
  return Object.hasOwn(HINT_SENTENCE, hint) ? (hint as FailureHint) : null;
}

/**
 * La phrase à afficher, ou `null` quand il n'y a rien à dire.
 *
 * Prend un `string` et non un `FailureHint` exprès : le champ arrive de la base
 * en texte libre, et un geste venu d'une version du runner plus récente que cet
 * écran ne doit pas s'afficher en slug brut. Il ne se dit pas, point.
 *
 * Passe par `knownHint` pour la même raison de prototypes : lu à l'index sans
 * garde, `HINT_SENTENCE['toString']` rendait la MÉTHODE héritée, typée `string`
 * par l'index signature, et l'écran affichait du code source.
 */
export function hintSentence(hint: string | null | undefined): string | null {
  const connu = knownHint(hint);
  return connu === null ? null : HINT_SENTENCE[connu];
}
