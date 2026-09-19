// job-result-kind.ts — COMMENT le résultat d'un job a été produit (#154, #210).
//
// `agent_jobs.result` porte le texte ; cette marque porte sa PROVENANCE. Elle
// existe parce que deux écrans devinaient la provenance à partir du texte :
//
//   - le fil (`readsAsReply`, apps/web/src/lib/conversation-thread.ts) lisait
//     le PREMIER CARACTÈRE du résultat et le tenait pour du texte machine dès
//     qu'il commençait par `{` ou `[` et parsait comme du JSON. Une réponse
//     légitime rendue sous forme de tableau JSON lisible était donc refusée, et
//     le fil montrait l'annonce de l'agent à sa place (#154) ;
//   - la page d'un run cachait la réponse dès qu'un verdict de relecture était
//     enregistré, sans pouvoir dire si cette réponse était les mots de l'agent
//     ou le texte de ses délégués recompilé (#210).
//
// Trois surfaces lisent ces mots : le runner les écrit (`apps/runner/src/job`),
// `packages/db` les range (colonne `agent_jobs.result_kind`, migration 0117),
// `apps/web` les rend. Le type vit donc ici, en un seul exemplaire.

/**
 * D'où vient le texte de `agent_jobs.result`.
 *
 * `prose` — LES MOTS DE L'AGENT. Son texte final (branche texte de
 *   `executeJob`, texte final d'un runtime CLI), son dernier texte repris par
 *   `fillResultFromFinalTextIfEmpty`, ou le texte qu'il a publié lui-même par
 *   `dashboard_publish`. Dans les trois cas c'est l'agent qui parle, et le
 *   texte se lit comme une réponse quelle que soit sa forme — du JSON compris.
 *
 * `relay` — LE TEXTE D'AUTRES JOBS, recompilé par le runner : les résultats
 *   des enfants (`fillResultFromChildrenIfEmpty`), ceux des tâches d'un root
 *   de tableau (`deliverCompletedRoots`, `cancelRootJob`). L'agent n'a rien
 *   écrit de sa main ; ce que la personne lit est la production de ses
 *   délégués, et les écrans qui montrent DÉJÀ cette production ailleurs (le
 *   bloc Review d'une page de run) n'ont pas à la répéter en haut.
 *
 * IL N'Y A PAS DE TROISIÈME VALEUR, et c'est un fait du runner, pas un oubli :
 * `return_result` ne transporte AUCUN contenu depuis la brique 33
 * (`packages/tools/src/builtin/return-result.ts` : « Pure state-machine signal
 * … Content delivery is handled by dedicated delivery tools »). Aucun chemin
 * n'écrit donc une charge utile structurée dans `result` ; écrire une valeur
 * `structured` que rien ne pose aurait donné aux écrans une distinction sans
 * réalité (invariant #4).
 */
export type JobResultKind = 'prose' | 'relay';

export const JOB_RESULT_KINDS: readonly JobResultKind[] = ['prose', 'relay'];

export function isJobResultKind(value: unknown): value is JobResultKind {
  return value === 'prose' || value === 'relay';
}
