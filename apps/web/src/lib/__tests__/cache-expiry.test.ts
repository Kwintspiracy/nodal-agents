// cache-expiry.test.ts — LA RÈGLE de #54, cas par cas.
//
// Ce que ce fichier prouve : qu'une reprise après délégation est reconnue par
// ce qu'elle EST (un préfixe mis en cache, rien relu, un écart plus long que
// la durée de vie du cache) et pas par un pourcentage posé à la main ; et que
// chacune des six conditions est NÉCESSAIRE — retirer l'une d'elles fait
// compter une reprise qui n'en est pas une.
//
// Mutations vérifiées (chacune fait rougir au moins un cas de ce fichier) :
//   - `gapMs <= CACHE_TTL_MS` → `gapMs < CACHE_TTL_MS` : « deux appels
//     rapprochés » compte une reprise ;
//   - `cur.cachedTokens !== 0` → `cur.cachedTokens === null` : le tour 3 de
//     l'issue, qui a bien relu son cache, devient une perte ;
//   - `Math.min(input, written)` → `input` : les jetons perdus dépassent ce
//     qui avait été mis en cache ;
//   - la condition de modèle retirée : un changement de modèle est compté
//     comme une expiration de cache ;
//   - `hasCachePricing` retiré : un modèle sans prix de cache ajoute $0 au
//     total au lieu d'être compté à part.

import { describe, it, expect } from 'vitest';
import { cacheLostOnResume, CACHE_TTL_MS, type CacheCallRow } from '../cache-expiry.ts';

/** Les trois appels du ticket #54, à la minute près. */
const T1 = new Date('2026-08-21T14:19:15Z');
const T2 = new Date('2026-08-21T14:52:57Z'); // 33 min plus tard
const T3 = new Date('2026-08-21T14:53:06Z'); // 9 s plus tard

const base = {
  jobId: 'parent',
  provider: 'anthropic',
  modelEffective: 'claude-opus-5',
} satisfies Pick<CacheCallRow, 'jobId' | 'provider' | 'modelEffective'>;

/** Les trois tours de l'issue : 1 met en cache, 2 reprend 33 min après, 3 relit 9 s après. */
const troisTours: CacheCallRow[] = [
  { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
  { ...base, createdAt: T2, inputTokens: 35_400, cachedTokens: 0, cacheCreationTokens: 35_400 },
  {
    ...base,
    createdAt: T3,
    inputTokens: 35_600,
    cachedTokens: 35_400,
    cacheCreationTokens: 200,
  },
];

describe('cacheLostOnResume @cap:voir-le-cout/moteur', () => {
  it('les trois tours du ticket #54 : UNE reprise, 35 200 jetons, et le surcoût au centième de cent', () => {
    const lost = cacheLostOnResume(troisTours);
    expect(lost.resumes).toBe(1);
    // min(entrée du tour 2 = 35 400, cache écrit au tour 1 = 35 200).
    expect(lost.tokens).toBe(35_200);
    expect(lost.unpricedResumes).toBe(0);
    // claude-opus-5 : 5 $/M en entrée fraîche, 0,50 $/M en lecture de cache
    // (packages/shared/src/model-catalog.ts). Le surcoût est la DIFFÉRENCE :
    // 35 200 × 4,50 $/M = 0,1584 $.
    expect(lost.costUsd).toBeCloseTo(0.1584, 9);
  });

  it('le tour 3 ne perd rien : il a relu son cache neuf secondes plus tard', () => {
    // C'est le cas qui fait exister la règle. Une règle qui ne regarderait que
    // l'écart de temps compterait ici une seconde perte : le tour 3 est proche
    // du tour 2, mais surtout il a RELU — et il le dit.
    const lost = cacheLostOnResume([troisTours[1]!, troisTours[2]!]);
    expect(lost).toEqual({ resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 });
  });

  it('le cache a TENU malgré 33 minutes : ce qui a été relu n’a rien coûté de plus', () => {
    // Le temps seul ne prouve rien. Un fournisseur peut servir un cache plus
    // long que 5 minutes, ou l'avoir rafraîchi entre-temps. Ce qui tranche est
    // ce que la ligne DIT avoir relu, pas l'horloge : sans ce cas, une règle
    // qui ne regarderait que l'écart passerait pour juste.
    const relu: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      {
        ...base,
        createdAt: T2,
        inputTokens: 35_400,
        cachedTokens: 35_200,
        cacheCreationTokens: 200,
      },
    ];
    expect(cacheLostOnResume(relu).resumes).toBe(0);
  });

  it('trois appels rapprochés ne perdent rien : le cache n’avait pas expiré', () => {
    const serres: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      {
        ...base,
        createdAt: new Date(T1.getTime() + 30_000),
        inputTokens: 35_400,
        cachedTokens: 0,
        cacheCreationTokens: 35_400,
      },
      {
        ...base,
        createdAt: new Date(T1.getTime() + 60_000),
        inputTokens: 35_600,
        cachedTokens: 0,
        cacheCreationTokens: 35_600,
      },
    ];
    expect(cacheLostOnResume(serres)).toEqual({
      resumes: 0,
      tokens: 0,
      costUsd: null,
      unpricedResumes: 0,
    });
  });

  it('la frontière est la durée de vie du cache : à la seconde près, avant ne compte pas, après compte', () => {
    const paire = (gapMs: number): CacheCallRow[] => [
      { ...base, createdAt: T1, inputTokens: 10_000, cachedTokens: 0, cacheCreationTokens: 10_000 },
      {
        ...base,
        createdAt: new Date(T1.getTime() + gapMs),
        inputTokens: 10_000,
        cachedTokens: 0,
        cacheCreationTokens: 10_000,
      },
    ];
    expect(cacheLostOnResume(paire(CACHE_TTL_MS)).resumes).toBe(0);
    expect(cacheLostOnResume(paire(CACHE_TTL_MS + 1_000)).resumes).toBe(1);
  });

  it('rien n’avait été mis en cache : il n’y a rien à perdre', () => {
    const jamaisEnCache: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 0 },
      { ...base, createdAt: T2, inputTokens: 35_400, cachedTokens: 0, cacheCreationTokens: 0 },
    ];
    expect(cacheLostOnResume(jamaisEnCache).resumes).toBe(0);
  });

  it('« le fournisseur ne dit pas » n’est pas « zéro » : une lecture inconnue ne devient pas une perte', () => {
    // `cached_tokens` à `null` veut dire que le fournisseur n'a rien rapporté
    // (ligne d'avant la migration 0078, fournisseur muet). Le compter comme
    // une lecture nulle inventerait une perte (invariant #4).
    const muet: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      {
        ...base,
        createdAt: T2,
        inputTokens: 35_400,
        cachedTokens: null,
        cacheCreationTokens: null,
      },
    ];
    expect(cacheLostOnResume(muet).resumes).toBe(0);
  });

  it('un changement de modèle n’est pas une expiration de cache', () => {
    const autreModele: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      {
        ...base,
        modelEffective: 'claude-sonnet-5',
        createdAt: T2,
        inputTokens: 35_400,
        cachedTokens: 0,
        cacheCreationTokens: 35_400,
      },
    ];
    expect(cacheLostOnResume(autreModele).resumes).toBe(0);
  });

  it('un préfixe plus COURT que ce qui avait été mis en cache n’est pas le même préfixe', () => {
    // Le contexte d'un job ne fait que grandir. Un appel dont l'entrée est
    // plus petite que ce qui avait été caché parle d'autre chose — une
    // conversation compactée, un autre gabarit — et la règle se tait.
    const pluscourt: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      { ...base, createdAt: T2, inputTokens: 900, cachedTokens: 0, cacheCreationTokens: 900 },
    ];
    expect(cacheLostOnResume(pluscourt).resumes).toBe(0);
  });

  it('deux jobs différents ne se suivent pas : chacun a son propre préfixe', () => {
    const deuxJobs: CacheCallRow[] = [
      { ...base, createdAt: T1, inputTokens: 35_200, cachedTokens: 0, cacheCreationTokens: 35_200 },
      {
        ...base,
        jobId: 'delegue',
        createdAt: T2,
        inputTokens: 35_400,
        cachedTokens: 0,
        cacheCreationTokens: 35_400,
      },
    ];
    expect(cacheLostOnResume(deuxJobs).resumes).toBe(0);
  });

  it('l’ordre d’arrivée des lignes n’y change rien : la règle range par date', () => {
    const melange = [troisTours[2]!, troisTours[0]!, troisTours[1]!];
    expect(cacheLostOnResume(melange).tokens).toBe(35_200);
  });

  it('un modèle sans prix de cache : les jetons sont comptés, le montant est dit INCONNU', () => {
    // `llama-3.3-70b-versatile` n'a pas de prix de lecture de cache au
    // catalogue. Ajouter 0 $ au total dirait « cette reprise n'a rien coûté ».
    const sansPrix: CacheCallRow[] = [
      {
        ...base,
        provider: 'groq',
        modelEffective: 'llama-3.3-70b-versatile',
        createdAt: T1,
        inputTokens: 35_200,
        cachedTokens: 0,
        cacheCreationTokens: 35_200,
      },
      {
        ...base,
        provider: 'groq',
        modelEffective: 'llama-3.3-70b-versatile',
        createdAt: T2,
        inputTokens: 35_400,
        cachedTokens: 0,
        cacheCreationTokens: 35_400,
      },
    ];
    const lost = cacheLostOnResume(sansPrix);
    expect(lost.resumes).toBe(1);
    expect(lost.tokens).toBe(35_200);
    expect(lost.unpricedResumes).toBe(1);
    expect(lost.costUsd).toBeNull();
  });

  it('sans date ni job, la règle se tait plutôt que de deviner', () => {
    const orphelins: CacheCallRow[] = [
      {
        ...base,
        jobId: null,
        createdAt: null,
        inputTokens: 35_200,
        cachedTokens: 0,
        cacheCreationTokens: 35_200,
      },
      {
        ...base,
        jobId: null,
        createdAt: null,
        inputTokens: 35_400,
        cachedTokens: 0,
        cacheCreationTokens: 35_400,
      },
    ];
    expect(cacheLostOnResume(orphelins).resumes).toBe(0);
  });
});
