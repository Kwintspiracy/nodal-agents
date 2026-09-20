// failure-hint.test.ts — le geste qu'un échec appelle, et le silence quand il
// n'en appelle aucun (#184, #193).
//
// Ce que ce fichier garde, c'est le SILENCE autant que la phrase. Un écran qui
// conseille au hasard après un échec ordinaire est pire qu'un écran muet : il
// envoie la personne changer un réglage qui n'y est pour rien. Et un geste que
// le runner nomme dans un mot plus récent que cet écran ne doit pas s'afficher
// en slug brut.
//
// CE QUI A CHANGÉ AVEC #193. L'écran ne DÉDUIT plus le geste du code d'erreur :
// il lit `agent_jobs.failure_hint`, le mot que le runner a écrit. Le test qui
// gardait la lecture du préfixe a donc disparu d'ici — il vit maintenant côté
// runner (`apps/runner/src/job/tests/fail-job-hint.test.ts`), là où la décision
// se prend. Ce qui reste ici est la seule chose que l'écran décide : quel geste
// il sait dire, et ce qu'il en dit.
//
// Mutation vérifiée : `knownHint` renvoyant `hint as FailureHint` sans son test
// d'appartenance → « un geste inconnu n'est pas rendu au type » rougit.

import { describe, it, expect } from 'vitest';
import { knownHint, hintSentence } from '../failure-hint.ts';

describe('knownHint — le geste lu en base, rendu au type @cap:suivre-execution/ecran', () => {
  it('« switch_model » est un geste que cet écran connaît', () => {
    expect(knownHint('switch_model')).toBe('switch_model');
  });

  it('aucun geste écrit : rien à rendre', () => {
    expect(knownHint(null)).toBeNull();
    expect(knownHint(undefined)).toBeNull();
    expect(knownHint('')).toBeNull();
  });

  it('un geste inconnu n’est pas rendu au type — il vaut le silence', () => {
    // Le jour où un runner plus récent que cet écran nommera un geste de plus,
    // le fil ne portera RIEN pour lui, jamais son slug.
    expect(knownHint('rotate_api_key')).toBeNull();
  });

  it('un code d’erreur n’est pas un geste : l’écran ne déduit plus (#193)', () => {
    // La garde de la bascule. Tant que l'écran lisait le code, cette entrée
    // rendait `switch_model` ; elle ne le rend plus, parce que ce n'est pas ce
    // que le runner a écrit dans `failure_hint`.
    expect(knownHint('provider_rejected_request:openrouter/x (http 400, turn 3)')).toBeNull();
  });

  it('les héritages de `Object.prototype` ne sont pas des gestes', () => {
    // `hint in HINT_SENTENCE` verrait `toString` sur la chaîne de prototypes si
    // la table n'était pas lue avec soin — et l'écran chercherait à dire un
    // geste qui n'existe pas.
    expect(knownHint('toString')).toBeNull();
    expect(knownHint('constructor')).toBeNull();
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

  it('« toString » ne rend pas la méthode héritée', () => {
    // Lu à l'index sans garde, `HINT_SENTENCE['toString']` rendait la fonction
    // d'`Object.prototype`, typée `string` par la signature d'index : l'écran
    // aurait affiché du code source sous un échec.
    expect(hintSentence('toString')).toBeNull();
    expect(hintSentence('valueOf')).toBeNull();
  });
});
