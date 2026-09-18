// failure-hint.test.ts — le geste qu'un échec appelle, et le silence quand il
// n'en appelle aucun (#184).
//
// Ce que ce fichier garde, c'est le SILENCE autant que la phrase. Un écran qui
// conseille au hasard après un échec ordinaire est pire qu'un écran muet : il
// envoie la personne changer un réglage qui n'y est pour rien. Et un geste que
// le runner nomme dans un mot plus récent que cet écran ne doit pas s'afficher
// en slug brut.

import { describe, it, expect } from 'vitest';
import { failureHint, hintSentence } from '../failure-hint.ts';

// Le code exact que `providerRejectionCode` écrit dans `agent_jobs.error`
// (apps/runner/src/job/execute.ts) — un vrai, pas une paraphrase.
const REFUS = 'provider_rejected_request:openrouter/google/gemini-3.7-flash (http 400, turn 3)';

describe('failureHint — le geste se lit sur ce qui est persisté @cap:suivre-execution/ecran', () => {
  it('un refus du fournisseur appelle un changement de modèle', () => {
    expect(failureHint(REFUS)).toBe('switch_model');
  });

  it('tout autre échec n’appelle rien, et l’absence de code non plus', () => {
    expect(failureHint('delivery_spam_guard')).toBeNull();
    expect(failureHint('max_turns_reached')).toBeNull();
    expect(failureHint('')).toBeNull();
    expect(failureHint(null)).toBeNull();
    expect(failureHint(undefined)).toBeNull();
  });

  it('le code est lu au DÉBUT : un message qui cite le refus n’en est pas un', () => {
    expect(failureHint('the child said provider_rejected_request happened')).toBeNull();
  });
});

describe('hintSentence — ce que l’écran DIT @cap:suivre-execution/ecran', () => {
  it('« switch_model » se dit en une phrase, en anglais', () => {
    expect(hintSentence('switch_model')).toBe('Try another model for this agent');
  });

  it('aucun geste, aucune phrase', () => {
    expect(hintSentence(null)).toBeNull();
    expect(hintSentence(undefined)).toBeNull();
  });

  it('un geste que cet écran ne connaît pas se TAIT, il ne s’affiche pas en slug', () => {
    // Le jour où le runner nommera un geste de plus, cet écran restera muet
    // jusqu'à ce que quelqu'un lui donne sa phrase. Muet, jamais bavard à tort.
    expect(hintSentence('rotate_api_key')).toBeNull();
  });
});
