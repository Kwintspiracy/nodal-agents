/**
 * #509 — une déclaration renvoyée reste DUE jusqu'à un `return_result` ACCEPTÉ.
 *
 * Revue Codex, passe 2 : la dette se soldait sur le simple bloc d'appel
 * `return_result`. Un appel DIFFÉRÉ (un outil voisin a échoué) n'a ni déclaré ni
 * retiré quoi que ce soit ; après la reprise du voisin, une réponse en texte
 * seul finissait en succès.
 */
import { describe, it, expect } from 'vitest';
import { declarationDue } from '../../job/execute.js';

const appel = (id: string) => ({
  role: 'assistant',
  content: [{ type: 'tool-call', toolCallId: id, toolName: 'return_result', input: {} }],
});
const reponse = (id: string, value: unknown) => ({
  role: 'tool',
  content: [
    {
      type: 'tool-result',
      toolCallId: id,
      toolName: 'return_result',
      output: { type: 'json', value },
    },
  ],
});
const irresolu = reponse('rr-1', {
  error: 'deferred: deliverables_unresolved: ces chemins …',
  unresolved: [{ path: '/tmp/x/film.mp4', code: 'path_traversal_blocked', reason: '…' }],
});
const du = [{ path: '/tmp/x/film.mp4', check: 'unresolved', detail: 'path_traversal_blocked' }];

describe('declarationDue', () => {
  it('une déclaration renvoyée pour chemin irrésolu est due, avec le code du résolveur', () => {
    expect(declarationDue([appel('rr-1'), irresolu])).toEqual(du);
  });

  it('un appel suivant DIFFÉRÉ (outil voisin en échec) ne solde rien', () => {
    const differe = reponse('rr-2', { error: 'deferred: a sibling tool failed, retry it first' });
    expect(declarationDue([appel('rr-1'), irresolu, appel('rr-2'), differe])).toEqual(du);
  });

  it('un return_result ACCEPTÉ solde la dette (il a redéclaré, ou retiré le fichier)', () => {
    const accepte = reponse('rr-3', { acknowledged: true });
    expect(declarationDue([appel('rr-1'), irresolu, appel('rr-3'), accepte])).toBeNull();
  });

  it('rien de renvoyé, rien de dû', () => {
    expect(declarationDue([appel('rr-1'), reponse('rr-1', { acknowledged: true })])).toBeNull();
  });
});
