// StatusBar.test.tsx — la barre du bas dit la preuve, les modèles, les agents,
// les jetons et leur part de cache, le coût, la durée, les envois en attente ;
// et un coût partiel se dit « partial », un coût inconnu « n/a ».

import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import StatusBar, { CostPanel } from '../StatusBar.tsx';
import type { SpaceCostView } from '@/lib/space-cost.ts';

const cost: SpaceCostView = {
  byAgent: [
    {
      agentId: 'a',
      agentName: 'Alfred',
      models: ['claude-opus-5'],
      calls: 7,
      inputTokens: 148_200,
      outputTokens: 4_100,
      cachedTokens: 96_000,
      cacheCreationTokens: 18_000,
      costUsd: 0.71,
      unpricedCalls: 0,
    },
    {
      agentId: 'b',
      agentName: 'Analyste',
      models: ['gpt-5'],
      calls: 3,
      inputTokens: 96_400,
      outputTokens: 2_200,
      cachedTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0.38,
      unpricedCalls: 1,
    },
  ],
  totals: {
    calls: 10,
    inputTokens: 244_600,
    outputTokens: 6_300,
    cachedTokens: 96_000,
    cacheCreationTokens: 18_000,
    costUsd: 1.09,
    unpricedCalls: 1,
    llmDurationMs: 312_000,
    durationMs: 18 * 60_000 + 4_000,
    humanWaitMs: 192_000,
    proofMs: 401_000,
  },
  // Le cas ordinaire : aucune reprise sur cache expiré. La barre ne doit alors
  // rien en dire du tout — c'est ce que le dernier cas de ce fichier prouve.
  cacheLost: { resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 },
};

describe('StatusBar', () => {
  const html = renderToStaticMarkup(
    <StatusBar
      cost={cost}
      proofVerdict="green"
      proofSequences={2}
      pendingDeliveries={1}
      live={false}
    />,
  );

  it('dit la preuve et les modèles ; le compte d’agents est dans l’EN-TÊTE, pas ici', () => {
    expect(html).toContain('proof green');
    expect(html).toContain('claude-opus-5, gpt-5');
    // Deux comptes d'agents dans le même écran disaient deux nombres
    // différents sous la même réponse (Quentin, 07/09) : celui de l'en-tête,
    // avec les visages, est le seul.
    expect(html).not.toContain('agents');
  });

  it('dit les jetons avec la part de cache, le coût avec « partial » quand un appel n’a pas de prix, la durée, l’envoi en attente', () => {
    expect(html).toContain('250,900 tokens · 39 % cached');
    expect(html).toContain('$1.09 · partial');
    // Le temps que les MODÈLES ont passé à répondre (312 s), pas le temps
    // écoulé depuis l'ouverture du fil (18 min 04) — une conversation laissée
    // ouverte n'a rien coûté de plus (Quentin, 07/09).
    expect(html).toContain('5 min 12 thinking');
    expect(html).not.toContain('18 min 04');
    expect(html).toContain('1 delivery pending');
  });

  it('AUCUN appel connu : le fil le DIT — jamais « 0 tokens · n/a », qui se lit « gratuit »', () => {
    const empty = renderToStaticMarkup(
      <StatusBar
        cost={{
          byAgent: [],
          totals: {
            ...cost.totals,
            calls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            costUsd: null,
            unpricedCalls: 0,
          },
          cacheLost: { resumes: 0, tokens: 0, costUsd: null, unpricedResumes: 0 },
        }}
        proofVerdict={null}
        proofSequences={0}
        pendingDeliveries={0}
        live={true}
      />,
    );
    expect(empty).toContain('no proof');
    // Un fil d'avant la migration 0100, ou un agent en runtime CLI dont la
    // consommation vit ailleurs : ne rien savoir se dit (revue Codex, passe 65).
    expect(empty).toContain('no usage recorded');
    expect(empty).not.toContain('0 tokens');
    expect(empty).not.toContain('n/a');
    expect(empty).not.toContain('thinking');
    expect(empty).toContain('running…');
    expect(empty).not.toContain('$0');
    expect(empty).not.toContain('cached');
  });
});

// #54 — LE CACHE PERDU À LA REPRISE, tel que l'écran le dit. Le calcul est
// prouvé ailleurs (`cache-expiry.test.ts` pour la règle,
// `delegation-cache-cost.test.ts` contre une vraie base) ; ici, uniquement ce
// qu'un œil voit : la ligne apparaît quand il y a eu une reprise, avec le
// montant, le nombre de reprises et la cause, et elle DISPARAÎT sinon.
describe('StatusBar — cache expiry @cap:voir-le-cout/ecran', () => {
  const withLoss: SpaceCostView = {
    ...cost,
    cacheLost: { resumes: 1, tokens: 35_200, costUsd: 0.1584, unpricedResumes: 0 },
  };

  it('dit le montant perdu et le nombre de reprises, à côté du coût', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        cost={withLoss}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).toContain('$1.09 · partial');
    expect(html).toContain('of which $0.16 lost to cache expiry (1 resume)');
    // La cause est lisible au survol, pas seulement le chiffre.
    expect(html).toContain('the provider&#x27;s cache expired while a delegate was working');
  });

  it('deux reprises se disent au PLURIEL, et le détail nomme les jetons', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        cost={{
          ...cost,
          cacheLost: { resumes: 2, tokens: 70_400, costUsd: 0.3168, unpricedResumes: 0 },
        }}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).toContain('of which $0.32 lost to cache expiry (2 resumes)');
  });

  it('aucune reprise : la barre n’en dit RIEN — pas de ligne à zéro', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        cost={cost}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).not.toContain('cache expiry');
    expect(html).not.toContain('cache lost on resume');
  });

  it('une somme PARTIELLE le dit, avec le mot du segment voisin', () => {
    // Trois reprises, une sur un modèle sans prix de cache : les 0,16 $ sont
    // vrais mais incomplets. La ligne de coût voisine écrit déjà « · partial »
    // pour la même raison ; les deux doivent porter le même mot, sinon celle
    // qui se tait se lit comme un total (revue Reviewer C, passe 1).
    const html = renderToStaticMarkup(
      <StatusBar
        cost={{
          ...cost,
          cacheLost: { resumes: 3, tokens: 105_600, costUsd: 0.1584, unpricedResumes: 1 },
        }}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).toContain('of which $0.16 lost to cache expiry (3 resumes) · partial');
  });

  it('toutes les reprises tarifées : pas de « partial » posé pour rien', () => {
    const html = renderToStaticMarkup(
      <StatusBar
        cost={withLoss}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).toContain('of which $0.16 lost to cache expiry (1 resume)');
    expect(html).not.toContain('cache expiry (1 resume) · partial');
  });

  it('le panneau détaillé nomme les jetons, le montant et la CAUSE', () => {
    const html = renderToStaticMarkup(<CostPanel cost={withLoss} onClose={() => {}} />);
    expect(html).toContain('cache lost on resume');
    expect(html).toContain('35,200 · $0.16 · 1 resume');
    expect(html).toContain(
      '35,200 input tokens, $0.16 went back to full price on 1 resume: the provider&#x27;s cache expired while a delegate was working.',
    );
  });

  it('le panneau compte les jetons même quand le montant est inconnu, et le DIT', () => {
    const html = renderToStaticMarkup(
      <CostPanel
        cost={{
          ...cost,
          cacheLost: { resumes: 1, tokens: 35_200, costUsd: null, unpricedResumes: 1 },
        }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain('35,200 input tokens went back to full price on 1 resume');
    expect(html).toContain('whose cache price we do not know, so the amount is partial');
    // Le montant reste « n/a » dans la grille : jamais un 0 qui se lirait « gratuit ».
    expect(html).toContain('35,200 · n/a · 1 resume');
  });

  it('un surcoût inconnu ne s’affiche pas en dollars : les jetons sont comptés, le montant est tu', () => {
    // Un modèle dont le catalogue ignore le prix de lecture de cache : on sait
    // combien de jetons sont repassés plein tarif, pas ce qu'ils ont coûté de
    // plus. « $0.0000 » dirait « on a mesuré, c'est nul » (invariant #4).
    const html = renderToStaticMarkup(
      <StatusBar
        cost={{
          ...cost,
          cacheLost: { resumes: 1, tokens: 35_200, costUsd: null, unpricedResumes: 1 },
        }}
        proofVerdict="green"
        proofSequences={1}
        pendingDeliveries={0}
        live={false}
      />,
    );
    expect(html).not.toContain('cache expiry');
    expect(html).not.toContain('$0.0000');
  });
});

describe('StatusBar — the run budget in the cost panel (#442) @cap:suivre-execution/ecran', () => {
  it('names the ceilings the runner holds this run to', () => {
    const html = renderToStaticMarkup(
      <CostPanel
        cost={{ ...cost, runBudget: { maxRunCostUsd: 2, maxRunHours: 1.5 } }}
        onClose={() => {}}
      />,
    );
    expect(html).toContain(
      'The workspace stops a run once it has cost $2.00 or after 1.5 h of work (Settings, Safety).',
    );
  });

  it('says there is none when both are zero, and nothing on a view that is not a run', () => {
    const none = renderToStaticMarkup(
      <CostPanel
        cost={{ ...cost, runBudget: { maxRunCostUsd: 0, maxRunHours: 0 } }}
        onClose={() => {}}
      />,
    );
    expect(none).toContain('The workspace sets no run budget (Settings, Safety).');
    const thread = renderToStaticMarkup(<CostPanel cost={cost} onClose={() => {}} />);
    expect(thread).not.toContain('run budget');
    expect(thread).not.toContain('stops a run');
  });
});
