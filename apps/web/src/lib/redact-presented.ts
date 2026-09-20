// redact-presented.ts — mask secrets in a tool CARD before it reaches a screen.
//
// SECURITY (#150). The raw output of a tool call is redacted at read time
// (`redactSecretsInText` on `tool_calls.tool_output`), because the column is
// stored verbatim: the runner re-reads it to resume a job, so redacting at
// write would corrupt the resume. The card built from that same output
// (`tool_calls.presented`, written by `presentToolResult`) went through no such
// pass, and `ToolBlock` renders the card's text in preference to the raw
// output. A tool whose result carried a token therefore showed it masked in the
// raw view and IN CLEAR on the card.
//
// The fix mirrors the raw output exactly: read time, every path that hands a
// card to a person, the stored row left untouched as the truth of what
// happened.
//
// Why a blind walk and no field list
// ----------------------------------
// A list of card fields to mask (`text`, `excerpt`, `path`, …) would hold only
// until the next card is added — and a new card that nobody thought to add to
// the list would be a silent hole, exactly the kind of leak this closes. So
// every string is masked, wherever it sits, and the structure is returned
// intact.

import { redactSecretsInText } from '@nodal-agents/shared';

/**
 * Mask credential-shaped substrings in EVERY string of a card payload, at any
 * depth, keeping the shape: objects stay objects, arrays stay arrays, numbers,
 * booleans, `null` and `undefined` are returned as they are.
 *
 * Object KEYS are left alone: a key is a field name written by the card's
 * schema, never a value a tool captured.
 *
 * Pure, and typed `unknown → unknown` because the column is `jsonb`: the
 * payload is parsed and validated AFTER this pass (`parsePresented`), so a row
 * written before the cards existed, or by a future tool, walks through the same
 * way.
 */
export function redactPresented(presented: unknown): unknown {
  if (typeof presented === 'string') return redactSecretsInText(presented);
  if (Array.isArray(presented)) return presented.map(redactPresented);
  if (presented !== null && typeof presented === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(presented as Record<string, unknown>)) {
      out[key] = redactPresented(value);
    }
    return out;
  }
  return presented;
}

/** Une ligne d'audit telle que les lectures d'écran la manipulent. */
export type AuditRowLike = {
  toolInput: unknown;
  toolOutput: string | null;
  presented: unknown;
};

/**
 * UNE ligne d'audit, masquée AUX TROIS ENDROITS où elle se lit : la carte, la
 * sortie brute, l'entrée.
 *
 * Pourquoi les trois ensemble (Reviewer C, passe 2 du 18/09) : le chargeur d'un
 * run masquait la carte seule avant de passer la ligne au récapitulatif de
 * livraison. Ce récapitulatif ne rend que des comptes AUJOURD'HUI — mais il
 * reçoit la ligne entière, et le premier écran qui montrerait sa sortie
 * afficherait un jeton en clair. On masque à la PORTE, pas à l'usage : c'est la
 * règle qui a fermé le trou de #150, et elle vaut pour chaque champ, pas
 * seulement pour celui auquel on a pensé.
 *
 * La ligne STOCKÉE n'est jamais touchée : le runner la relit pour reprendre un
 * travail, et une reprise doit voir ce qui s'est vraiment passé (SECRET-001).
 */
export function redactAuditRow<T extends AuditRowLike>(row: T): T {
  return {
    ...row,
    toolInput: redactPresented(row.toolInput),
    toolOutput: row.toolOutput === null ? null : redactSecretsInText(row.toolOutput),
    presented: redactPresented(row.presented),
  };
}

/**
 * UN VERDICT DE RELECTURE, masqué avant de voyager (#286).
 *
 * Le problème que ça ferme : les deux lecteurs de `review_verdict`
 * (`lireVerdictsLivres` dans `job-feed.ts`, `readReviewVerdicts` dans
 * `review-verdicts.ts`) parsaient `tool_calls.tool_output` BRUT et rendaient le
 * `summary` et le `issue` de chaque constat tels quels — quatre endroits à
 * l'écran, le fil et la section de relecture d'un run. Or ces textes sont
 * écrits par l'agent relecteur : un relecteur qui recopie une commande qui
 * échoue, une ligne de configuration ou une erreur portant un jeton le posait
 * en clair, pendant que le MÊME jeton, dans le MÊME `tool_output`, était masqué
 * partout ailleurs (#150, #165, #212). `review-verdicts.ts` masquait d'ailleurs
 * le `result` du délégué deux lignes plus bas, ce qui rendait l'écart visible.
 *
 * Le masquage se fait APRÈS l'analyse, jamais avant : le parseur est celui de
 * l'outil, il valide la forme sur les octets EXACTEMENT tels qu'ils ont été
 * écrits. Masquer le JSON d'abord ferait dépendre la lecture d'un texte
 * réécrit, et un verdict deviendrait illisible — donc absent de l'écran — sans
 * que rien ne le dise (invariant #4).
 *
 * La marche est AVEUGLE (`redactPresented`), et pas une liste de champs : un
 * champ ajouté demain à `ReviewVerdictRecord` serait sinon un trou silencieux,
 * exactement ce que la même décision a écarté pour les cartes.
 *
 * Pourquoi la conversion de type est SÛRE : la marche rend un objet pour un
 * objet, un tableau pour un tableau, et ne réécrit que les FEUILLES de type
 * chaîne — les clés, les nombres et les booléens passent intacts. La forme est
 * donc conservée par construction. Les deux valeurs de `verdict` ne risquent
 * rien non plus : le masqueur ne reconnaît que des préfixes de fournisseurs
 * (`sk-ant-`, `ghp_`, `xoxb-`…), jamais un mot ordinaire.
 *
 * La ligne STOCKÉE n'est pas touchée : l'orchestration la relit pour décider si
 * une relecture interdit d'annoncer livré (SECRET-001).
 */
export function redactReviewVerdict<T>(record: T): T {
  return redactPresented(record) as T;
}
