// owner-words.test.ts — le message que la tête d'un run reçoit quand la
// personne répond à la carte d'un délégué : le cadre fixe, puis ses mots TELS
// QUELS. Toutes les sortes de carte, et le cas où elle n'a rien écrit.

import { describe, it, expect } from 'vitest';
import { ownerWordsOnCard, OWNER_ON_CARD_MARK } from '../../approvals/owner-words.ts';
import type { OwnerWordsInput } from '../../approvals/owner-words.ts';

const BASE: OwnerWordsInput = {
  kind: 'approval',
  decision: 'reject',
  resolvedBy: 'api',
  holderJobId: '5700457b-0000-4000-8000-000000000001',
  holderAgentSlug: 'reviewer-a',
  toolName: 'mcp_playwright__browser_run_code_unsafe',
  notes: null,
  answer: null,
  response: null,
};

describe('ownerWordsOnCard @cap:approuver-une-action/moteur', () => {
  it('cite la note d’un refus mot pour mot, sous le cadre de la carte', () => {
    const text = ownerWordsOnCard({ ...BASE, notes: "arrete la review, imprime c'est bon!" });
    expect(text).toBe(
      `${OWNER_ON_CARD_MARK} · agent: reviewer-a · job: ${BASE.holderJobId} · ` +
        'tool: mcp_playwright__browser_run_code_unsafe · card: approval · decision: rejected · via: api\n' +
        "note:\narrete la review, imprime c'est bon!",
    );
  });

  it('garde une note de plusieurs lignes et ses espaces telle quelle', () => {
    const note = '  ligne une\n\n  « ligne deux » ';
    const text = ownerWordsOnCard({ ...BASE, decision: 'approve', notes: note, resolvedBy: 'x' });
    expect(text?.endsWith(`note:\n${note}`)).toBe(true);
    expect(text).toContain('decision: approved · via: x');
  });

  it('une question : la réponse, et la note quand il y en a une', () => {
    const text = ownerWordsOnCard({
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
    expect(ownerWordsOnCard({ ...BASE, kind: 'question', notes: 'pas ça' })).toContain(
      'decision: declined',
    );
  });

  it('un formulaire de serveur MCP : ses valeurs, en données', () => {
    const text = ownerWordsOnCard({
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
    expect(ownerWordsOnCard(BASE)).toBeNull();
    expect(ownerWordsOnCard({ ...BASE, decision: 'approve' })).toBeNull();
    expect(ownerWordsOnCard({ ...BASE, notes: '   \n' })).toBeNull();
    expect(ownerWordsOnCard({ ...BASE, kind: 'elicitation', response: {} })).toBeNull();
  });

  it('une carte sans agent nommé : le champ manque, rien n’est inventé', () => {
    const text = ownerWordsOnCard({ ...BASE, holderAgentSlug: null, notes: 'stop' });
    expect(text).not.toContain('agent:');
    expect(text?.startsWith(`${OWNER_ON_CARD_MARK} · job: ${BASE.holderJobId}`)).toBe(true);
  });
});
