// failure-codes.ts — LES CODES D'ÉCHEC QUE PLUSIEURS SURFACES LISENT.
//
// Ici vivent les deux seules choses qu'un échec de job fait voyager d'un
// paquet à l'autre : le GESTE qu'il appelle, et le PRÉFIXE du code d'erreur qui
// le fait reconnaître. Les deux étaient écrits deux fois — le geste dans
// l'orchestration, le préfixe dans le runner et recopié dans l'écran (#194,
// revue passe 1). Un renommage d'un côté laissait l'autre muet, tous les tests
// au vert, parce que chacun tenait sa propre copie de la chaîne.
//
// POURQUOI DANS `shared` ET PAS AILLEURS. Le producteur est le runner, le
// lecteur est le web, et l'orchestration porte le record qui les relie : aucun
// des trois ne dépend des deux autres. `shared` est le seul endroit qu'ils
// voient tous.

/**
 * Les gestes que le harnais peut nommer après un échec. Un par cas, ajouté
 * quand un cas le mérite — la liste reste courte exprès : un « conseil »
 * fourre-tout ne se rend pas à l'écran.
 *
 * `switch_model` : le fournisseur a refusé la requête de ce modèle-là.
 *
 * Le harnais POSE ce champ et n'écrit aucune phrase (invariant #2) ; c'est
 * l'écran, ou le modèle, qui le dit dans la langue de la personne.
 */
export type JobFailureHint = 'switch_model';

/**
 * La raison de sortie d'un job qu'un fournisseur a refusé
 * (`ExecuteJobResult.exitReason`).
 */
export const PROVIDER_REJECTED = 'provider_rejected_request';

/**
 * Le début du code écrit dans `agent_jobs.error` pour ce refus, LES DEUX-POINTS
 * COMPRIS. Ils font partie du contrat : sans eux, un futur
 * `provider_rejected_request_quelque_chose` passerait pour un refus de
 * fournisseur (#194, revue passe 1, constat C3).
 *
 * Le code entier est fabriqué par `providerRejectionCode`
 * (`apps/runner/src/job/execute.ts`), et lui seul.
 */
export const PROVIDER_REJECTED_PREFIX = `${PROVIDER_REJECTED}:`;
