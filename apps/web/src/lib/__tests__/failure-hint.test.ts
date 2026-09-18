// failure-hint.test.ts — le geste qu'un échec appelle, et le silence quand il
// n'en appelle aucun (#184).
//
// Ce que ce fichier garde, c'est le SILENCE autant que la phrase. Un écran qui
// conseille au hasard après un échec ordinaire est pire qu'un écran muet : il
// envoie la personne changer un réglage qui n'y est pour rien. Et un geste que
// le runner nomme dans un mot plus récent que cet écran ne doit pas s'afficher
// en slug brut.

import { describe, it, expect } from 'vitest';
import { PROVIDER_REJECTED, PROVIDER_REJECTED_PREFIX } from '@nodal-agents/shared';
import { failureHint, hintSentence } from '../failure-hint.ts';

// Le code exact que `providerRejectionCode` écrit dans `agent_jobs.error`,
// bâti sur LA constante partagée et non sur une copie de la chaîne : un
// renommage du préfixe doit faire rougir ce fichier, au lieu de le laisser vert
// sur un code que plus personne n'écrit (#194, revue passe 1).
const REFUS = `${PROVIDER_REJECTED_PREFIX}openrouter/google/gemini-3.7-flash (http 400, turn 3)`;

describe('failureHint — le geste se lit sur ce qui est persisté @cap:suivre-execution/ecran', () => {
  it('la constante partagée vaut CE qu’elle doit valoir', () => {
    // Épinglée en clair, une fois (revue passe 2). Tout le reste du fichier est
    // bâti SUR elle : si la jonction `node_modules` d'un worktree la résout vers
    // un autre paquet, elle vaut `undefined` et la suite passe au vert sur du
    // vide — c'est arrivé. Cette ligne-là le dit tout de suite.
    expect(PROVIDER_REJECTED_PREFIX).toBe('provider_rejected_request:');
    expect(PROVIDER_REJECTED).toBe('provider_rejected_request');
  });

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
    expect(failureHint(`the child said ${PROVIDER_REJECTED} happened`)).toBeNull();
  });

  it('les DEUX-POINTS font partie du code : un voisin de nom n’est pas ce refus', () => {
    // Sans eux, un futur `provider_rejected_request_upstream` serait lu comme
    // un refus de ce modèle-là, et l'écran enverrait changer un réglage qui
    // n'y est pour rien (revue passe 1, constat C3).
    expect(failureHint(`${PROVIDER_REJECTED}_upstream:openrouter/x (http 500, turn 1)`)).toBeNull();
    expect(failureHint(PROVIDER_REJECTED)).toBeNull();
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
