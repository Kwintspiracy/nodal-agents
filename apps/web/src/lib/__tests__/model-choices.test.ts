// model-choices.test.ts — LA liste que les deux écrans proposent (#138).
//
// `buildModelOptionGroups` est le seul endroit où la liste des modèles d'une
// clé se construit : l'écran d'édition d'un agent et les trois listes du
// composeur l'appellent tous les deux. Si elle ment, ils mentent ensemble — et
// le test de parité côté écran ne le verrait pas. Ce fichier la juge donc sur
// pièces, contre le vrai catalogue.

import { describe, it, expect } from 'vitest';
import { MODEL_CATALOG } from '@nodal-agents/shared';
import {
  buildModelOptionGroups,
  modelIdsOf,
  isModelInOptions,
  defaultModelForProvider,
  llmKeyLabel,
  llmKeyShortLabel,
  isRefusedEffort,
  reasoningOptionValues,
  disabledHintFor,
  NO_TOOLS_HINT,
  type ModelChoice,
} from '../model-choices.ts';

describe('buildModelOptionGroups @cap:choisir-modele/moteur', () => {
  it('propose TOUT le catalogue du fournisseur, et rien d’un autre', () => {
    const ids = modelIdsOf(buildModelOptionGroups('openai', []));
    const attendu = (MODEL_CATALOG['openai'] ?? []).map((m) => m.modelId);
    expect([...ids].sort()).toEqual([...attendu].sort());
    expect(ids).not.toContain('claude-opus-5');
  });

  it('ajoute les modèles vus EN DIRECT que le catalogue n’a pas, sans doublon', () => {
    const groups = buildModelOptionGroups('openai', ['gpt-5', 'un-modele-tout-neuf']);
    const ids = modelIdsOf(groups);
    // 'gpt-5' est au catalogue : il n'apparaît pas deux fois.
    expect(ids.filter((id) => id === 'gpt-5')).toEqual(['gpt-5']);
    // Le neuf est là, dans sa propre section.
    expect(ids).toContain('un-modele-tout-neuf');
    const live = groups.find((g) => g.group === 'Live from provider');
    expect(live?.models.map((m) => m.modelId)).toEqual(['un-modele-tout-neuf']);
    // Et il ne prétend rien de ses capacités : le catalogue ne le connaît pas.
    expect(live?.models[0]?.entry).toBeUndefined();
  });

  it('un fournisseur sans catalogue ne rend que ce que le fournisseur a dit', () => {
    expect(buildModelOptionGroups('openai-compatible', [])).toEqual([]);
    expect(modelIdsOf(buildModelOptionGroups('openai-compatible', ['llama-maison']))).toEqual([
      'llama-maison',
    ]);
  });

  it('sait dire si un modèle est dans la liste', () => {
    const groups = buildModelOptionGroups('openai', ['un-modele-tout-neuf']);
    expect(isModelInOptions(groups, 'gpt-5')).toBe(true);
    expect(isModelInOptions(groups, 'un-modele-tout-neuf')).toBe(true);
    expect(isModelInOptions(groups, 'claude-opus-5')).toBe(false);
  });
});

describe('les règles qui suivent un changement de clé @cap:choisir-modele/moteur', () => {
  it('le modèle par défaut d’un fournisseur est le PREMIER de son catalogue', () => {
    expect(defaultModelForProvider('openai')).toBe(MODEL_CATALOG['openai']?.[0]?.modelId);
    expect(defaultModelForProvider('anthropic')).toBe(MODEL_CATALOG['anthropic']?.[0]?.modelId);
    // Sans catalogue, aucun défaut à inventer.
    expect(defaultModelForProvider('openai-compatible')).toBe('');
  });

  it('une clé se nomme par son surnom, son fournisseur entre parenthèses', () => {
    expect(llmKeyLabel({ nickname: 'Work', provider: 'openai' })).toBe('Work (OpenAI)');
    // Sans surnom, le fournisseur tient les deux rôles — comme sur l'écran
    // d'édition, dont c'est la formule exacte.
    expect(llmKeyLabel({ nickname: null, provider: 'anthropic' })).toBe('Anthropic (Anthropic)');
  });

  it('la pastille écrit le nom d’une clé UNE fois : le surnom, sinon le fournisseur', () => {
    expect(llmKeyShortLabel({ nickname: 'Work', provider: 'openai' })).toBe('Work');
    expect(llmKeyShortLabel({ nickname: null, provider: 'anthropic' })).toBe('Anthropic');
    // Un surnom vide ne compte pas comme un surnom.
    expect(llmKeyShortLabel({ nickname: '   ', provider: 'openrouter' })).toBe('OpenRouter');
    expect(llmKeyShortLabel({ nickname: null, provider: 'anthropic' })).not.toContain('(');
  });

  it('un routeur ne peut pas choisir un modèle catalogué SANS outils — grisé, avec la raison des réglages', () => {
    const catalogued = buildModelOptionGroups('openai', [])[0]?.models[0];
    if (!catalogued?.entry) throw new Error('the OpenAI catalog has no entry');
    // Le vrai catalogue ne porte aujourd'hui aucun modèle sans outils : la
    // règle se prouve sur une entrée forgée à partir d'une vraie, où seul le
    // drapeau change. Le jour où un tel modèle entre au catalogue, il sera
    // grisé sans qu'on y touche.
    const sansOutils: ModelChoice = {
      ...catalogued,
      entry: {
        ...catalogued.entry,
        capabilities: { ...catalogued.entry.capabilities, tools: false },
      },
    };
    expect(disabledHintFor(sansOutils, true)).toBe(NO_TOOLS_HINT);
    expect(disabledHintFor(sansOutils, false)).toBeNull();
    // Un modèle AVEC outils se choisit, routeur ou pas.
    expect(disabledHintFor(catalogued, true)).toBeNull();
    // Hors catalogue, on ne sait rien de ses outils : jamais grisé (inv. #4).
    expect(disabledHintFor({ modelId: 'x', label: 'x' }, true)).toBeNull();
  });

  it('un effort ne se refuse que sur un modèle CATALOGUÉ qui ne l’offre pas', () => {
    // gpt-5 : low / medium / high, raisonnement obligatoire.
    expect(reasoningOptionValues('openai', 'gpt-5')).toEqual(['low', 'medium', 'high']);
    expect(isRefusedEffort('openai', 'gpt-5', 'max')).toBe(true);
    expect(isRefusedEffort('openai', 'gpt-5', 'high')).toBe(false);
    // Hors catalogue, on ne sait rien : refuser serait un faux « non », et
    // interdirait ici ce que l'écran d'édition accepte.
    expect(isRefusedEffort('openai', 'un-modele-tout-neuf', 'max')).toBe(false);
  });
});
