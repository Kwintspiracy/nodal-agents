// card-words.test.ts — le message que la tête d'un run reçoit quand une
// personne répond à la carte d'un délégué : le cadre fixe — qui a répondu, avec
// le rôle que les données lui donnent —, puis ses mots TELS QUELS. Toutes les
// sortes de carte, et le cas où elle n'a rien écrit.

import { describe, it, expect } from 'vitest';
import {
  cardCarriesWords,
  personWordsOnCard,
  PERSON_ON_CARD_MARK,
} from '../../approvals/card-words.ts';
import type { CardWordsInput } from '../../approvals/card-words.ts';

const BASE: CardWordsInput = {
  kind: 'approval',
  decision: 'reject',
  resolvedBy: 'api',
  responder: { role: 'owner', identity: 'user:local@nodalai.local' },
  holderJobId: '5700457b-0000-4000-8000-000000000001',
  holderAgentSlug: 'reviewer-a',
  toolName: 'mcp_playwright__browser_run_code_unsafe',
  notes: null,
  answer: null,
  response: null,
};

describe('personWordsOnCard @cap:approuver-une-action/moteur', () => {
  it('cite la note d’un refus mot pour mot, sous le cadre de la carte', () => {
    const text = personWordsOnCard({ ...BASE, notes: "arrete la review, imprime c'est bon!" });
    expect(text).toBe(
      `${PERSON_ON_CARD_MARK} · by: owner user:local@nodalai.local · agent: reviewer-a · ` +
        `job: ${BASE.holderJobId} · ` +
        'tool: mcp_playwright__browser_run_code_unsafe · card: approval · decision: rejected · via: api\n' +
        "note:\narrete la review, imprime c'est bon!",
    );
  });

  it('garde une note de plusieurs lignes et ses espaces telle quelle', () => {
    const note = '  ligne une\n\n  « ligne deux » ';
    const text = personWordsOnCard({ ...BASE, decision: 'approve', notes: note, resolvedBy: 'x' });
    expect(text?.endsWith(`note:\n${note}`)).toBe(true);
    expect(text).toContain('decision: approved · via: x');
  });

  it('une question : la réponse, et la note quand il y en a une', () => {
    const text = personWordsOnCard({
      ...BASE,
      kind: 'question',
      decision: 'approve',
      resolvedBy: 'telegram',
      toolName: 'ask_user',
      answer: 'A new file in notes',
      notes: 'et fais court',
    });
    expect(text).toContain('card: question · decision: answered · via: telegram');
    expect(text).toContain('\nanswer:\nA new file in notes\nnote:\net fais court');
    expect(personWordsOnCard({ ...BASE, kind: 'question', notes: 'pas ça' })).toContain(
      'decision: declined',
    );
  });

  it('un formulaire de serveur MCP : ses valeurs, en données', () => {
    const text = personWordsOnCard({
      ...BASE,
      kind: 'elicitation',
      decision: 'approve',
      resolvedBy: 'slack',
      response: { copies: 2, color: false },
    });
    expect(text).toContain('card: elicitation · decision: sent · via: slack');
    expect(text).toContain('\nform:\n{"copies":2,"color":false}');
  });

  it('rien à citer : un clic seul, une note vide ou d’espaces, un formulaire vide', () => {
    expect(personWordsOnCard(BASE)).toBeNull();
    expect(personWordsOnCard({ ...BASE, decision: 'approve' })).toBeNull();
    expect(personWordsOnCard({ ...BASE, notes: '   \n' })).toBeNull();
    expect(personWordsOnCard({ ...BASE, kind: 'elicitation', response: {} })).toBeNull();
  });

  it('une carte sans agent nommé : le champ manque, rien n’est inventé', () => {
    const text = personWordsOnCard({ ...BASE, holderAgentSlug: null, notes: 'stop' });
    expect(text).not.toContain('agent:');
    expect(
      text?.startsWith(
        `${PERSON_ON_CARD_MARK} · by: owner user:local@nodalai.local · job: ${BASE.holderJobId}`,
      ),
    ).toBe(true);
  });

  it('un MEMBRE qui répond est dit membre : rien ne le fait passer pour le propriétaire', () => {
    const text = personWordsOnCard({
      ...BASE,
      responder: { role: 'member', identity: 'user:invite@example.com' },
      notes: 'imprime',
    });
    expect(text).toContain(' · by: member user:invite@example.com · ');
    expect(text).not.toContain('owner');
  });

  it('un répondant qu’aucune ligne ne décrit est dit tel quel', () => {
    const text = personWordsOnCard({
      ...BASE,
      responder: { role: 'unlisted', identity: 'telegram:777000222' },
      notes: 'stop',
    });
    expect(text).toContain(' · by: unlisted telegram:777000222 · ');
  });

  it('cardCarriesWords lit les mêmes champs que le message cite', () => {
    expect(cardCarriesWords({ notes: null, answer: null, response: null })).toBe(false);
    expect(cardCarriesWords({ notes: ' ', answer: '', response: {} })).toBe(false);
    expect(cardCarriesWords({ notes: 'x', answer: null, response: null })).toBe(true);
    expect(cardCarriesWords({ notes: null, answer: 'A', response: null })).toBe(true);
    expect(cardCarriesWords({ notes: null, answer: null, response: { a: 1 } })).toBe(true);
  });
});
