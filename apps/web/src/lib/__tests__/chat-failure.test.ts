// chat-failure.test.ts — ce que l'écran dit d'un tour de chat sans réponse.
// Le frein d'urgence arrête un tour de CLI avant tout texte (#494) : l'écran
// dit le frein, pas « l'agent n'a pas répondu ».

import { describe, it, expect } from 'vitest';
import { chatFailureText } from '../chat-failure';

describe('chatFailureText @cap:executer-une-commande/ecran', () => {
  it.each([
    ['auto_run_paused', 'The workspace emergency brake stopped this turn.'],
    [
      'auto_run_state_unreadable',
      'The emergency brake state could not be read, so this turn stopped.',
    ],
    ['cli_runtime_error: boom', 'The agent did not reply'],
  ])('%s', (code, text) => {
    expect(chatFailureText(code)).toBe(text);
  });
});
