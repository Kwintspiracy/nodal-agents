// cache-expiry.ts — ce qu'une REPRISE après délégation a coûté en cache perdu
// (#54, « Delegating expires the parent's cache: 21% of the bill »).
//
// Le constat de l'issue : un agent fait trois appels, les tours 1 et 2 séparés
// par 33 minutes pendant que son équipe travaille. À la reprise le cache du
// fournisseur a expiré, et 35 000 jetons déjà mis en cache repassent au tarif
// plein. Ce n'est pas un accident : toute délégation séquentielle dure plus
// longtemps que la durée de vie d'un cache, donc le parent paie le plein tarif
// à chaque reprise, PAR CONSTRUCTION.
//
// Deux voies étaient ouvertes : ne pas renvoyer le contexte entier pour
// reprendre (protocole de reprise, un lot à part), ou accepter le coût et le
// RENDRE VISIBLE. Ce module est la seconde : il ne change rien à ce qui est
// facturé, il le LIT sur les lignes de `llm_calls` — jamais une estimation
// posée sur un pourcentage, jamais un chiffre inventé (invariant #4).

import { estimateCallCostUsd, hasCachePricing } from '@nodal-agents/shared';

/**
 * Durée de vie d'un préfixe mis en cache : 5 minutes. C'est un FAIT DU
 * FOURNISSEUR, pas une hypothèse — Anthropic documente un cache `ephemeral`
 * de 5 minutes, rafraîchi à chaque lecture
 * (docs.claude.com/en/docs/build-with-claude/prompt-caching : « the cache has
 * a 5-minute lifetime, refreshed each time the cache content is used »).
 *
 * UNE SEULE constante, et non une table par fournisseur, parce que la règle
 * ci-dessous ne se déclenche que sur un appel dont `cache_creation_tokens`
 * est renseigné, et cette colonne ne vient QUE de
 * `providerMetadata.anthropic.cacheCreationInputTokens`
 * (`packages/llm/src/observe.ts`) : c'est le protocole Anthropic qui parle,
 * quel que soit le fournisseur qui le sert. Le dépôt ne porte aucune autre
 * durée de vie : `CAPABILITY_MATRIX` dit QUI sait cacher, jamais combien de
 * temps. Un fournisseur qui ne rapporte pas d'écriture de cache ne déclenche
 * donc rien du tout, plutôt qu'une durée devinée pour lui.
 */
export const CACHE_TTL_MS = 5 * 60_000;

/** Une ligne de `llm_calls`, réduite à ce que la règle regarde. */
export type CacheCallRow = {
  /** Le job qui a fait l'appel. `null` (chat sans job) ⇒ hors règle : pas de « même job ». */
  jobId: string | null;
  provider: string;
  modelEffective: string;
  createdAt: Date | null;
  /** Entrée TOTALE, cache inclus (sémantique AI SDK). */
  inputTokens: number | null;
  /** Lectures de cache. `null` = le fournisseur ne le dit pas — jamais un 0 deviné. */
  cachedTokens: number | null;
  /** Écritures de cache. `null` = idem. */
  cacheCreationTokens: number | null;
};

/** #54 — ce que les reprises ont coûté en cache expiré. Zéro reprise ⇒ rien à dire. */
export type CacheLostView = {
  /** Nombre de reprises où le cache du préfixe avait expiré. */
  resumes: number;
  /** Σ des jetons d'entrée repassés plein tarif alors qu'ils étaient en cache. */
  tokens: number;
  /**
   * Le SURCOÛT en dollars : ce que ces jetons ont coûté au tarif plein moins ce
   * qu'ils auraient coûté relus en cache. `null` quand aucune reprise n'est sur
   * un modèle dont le catalogue connaît le prix de cache — on ne sait pas, et
   * ne pas savoir se dit plutôt que de s'afficher 0.
   */
  costUsd: number | null;
  /** Reprises dont le modèle n'a pas de prix de cache au catalogue : le surcoût est alors partiel. */
  unpricedResumes: number;
};

/**
 * LA RÈGLE, en toutes lettres, parce qu'un chiffre affiché sans sa règle est
 * un chiffre inventé.
 *
 * Les appels sont rangés par job puis par date. Un appel N est une REPRISE
 * SUR CACHE EXPIRÉ quand les six conditions tiennent ensemble :
 *
 *   1. N et N−1 appartiennent au MÊME job — « le même préfixe » n'a de sens
 *      qu'à l'intérieur d'un job, dont le système et l'historique ne font que
 *      grandir d'un tour à l'autre ;
 *   2. N−1 a `cache_creation_tokens > 0` — un préfixe a RÉELLEMENT été mis en
 *      cache, ce n'est pas une supposition ;
 *   3. N a `cached_tokens === 0`, renseigné et non `null` — rien n'a été relu,
 *      et on le sait (un `null` veut dire « le fournisseur ne l'a pas dit »,
 *      pas « zéro ») ;
 *   4. N et N−1 ont le même fournisseur ET le même modèle effectif — un
 *      changement de modèle invalide le cache pour une autre raison que le
 *      temps, et ce n'est pas ce que cette ligne mesure ;
 *   5. `input(N) >= cache_creation_tokens(N−1)` — le préfixe renvoyé à N
 *      CONTIENT celui qui avait été mis en cache. C'est le plus proche d'une
 *      comparaison de préfixes que la base permette : `llm_calls` garde les
 *      jetons et `tools_hash`, jamais une empreinte du système + historique.
 *      La condition est donc APPROCHÉE, et elle est écrite ici comme telle ;
 *   6. l'écart `created_at(N) − created_at(N−1)` dépasse `CACHE_TTL_MS`.
 *
 * Jetons perdus = `min(input(N), cache_creation_tokens(N−1))` : on ne compte
 * jamais plus que ce qui avait été mis en cache, ni plus que ce qui a été
 * renvoyé.
 *
 * Le surcoût se lit avec le MÊME tarificateur que le reste du coût
 * (`estimateCallCostUsd`), appelé deux fois sur les mêmes jetons : une fois
 * comme entrée fraîche, une fois comme lecture de cache. La différence est ce
 * que l'expiration a coûté. Un modèle dont le catalogue ignore le prix de
 * lecture rendrait une différence de 0 qui se lirait « ça n'a rien coûté » :
 * `hasCachePricing` le range dans `unpricedResumes` au lieu de le sommer.
 *
 * Pur : aucune base, aucune horloge.
 */
export function cacheLostOnResume(calls: readonly CacheCallRow[]): CacheLostView {
  const byJob = new Map<string, CacheCallRow[]>();
  for (const c of calls) {
    // Sans job ni date, il n'y a ni « appel précédent du même job » ni écart de
    // temps : la règle ne peut pas se prononcer, et ne se prononce pas.
    if (c.jobId === null || c.createdAt === null) continue;
    const list = byJob.get(c.jobId);
    if (list) list.push(c);
    else byJob.set(c.jobId, [c]);
  }

  const out: CacheLostView = { resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 };

  for (const list of byJob.values()) {
    const ordered = [...list].sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
    for (let i = 1; i < ordered.length; i += 1) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (!prev || !cur) continue;

      const written = prev.cacheCreationTokens;
      if (written === null || written <= 0) continue; // (2)
      if (cur.cachedTokens !== 0) continue; // (3) — `null` inclus : on ne sait pas
      if (cur.provider !== prev.provider || cur.modelEffective !== prev.modelEffective) continue; // (4)

      const input = cur.inputTokens ?? 0;
      if (input < written) continue; // (5)

      const gapMs = (cur.createdAt?.getTime() ?? 0) - (prev.createdAt?.getTime() ?? 0);
      if (gapMs <= CACHE_TTL_MS) continue; // (6)

      const lost = Math.min(input, written);
      out.resumes += 1;
      out.tokens += lost;

      if (!hasCachePricing(cur.provider, cur.modelEffective)) {
        out.unpricedResumes += 1;
        continue;
      }
      const fresh = estimateCallCostUsd(cur.provider, cur.modelEffective, {
        inputTokens: lost,
        outputTokens: 0,
        cachedTokens: 0,
        cacheCreationTokens: 0,
      });
      const cached = estimateCallCostUsd(cur.provider, cur.modelEffective, {
        inputTokens: lost,
        outputTokens: 0,
        cachedTokens: lost,
        cacheCreationTokens: 0,
      });
      out.costUsd = (out.costUsd ?? 0) + Math.max(0, fresh - cached);
    }
  }

  return out;
}
