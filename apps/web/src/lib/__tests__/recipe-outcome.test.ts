// recipe-outcome.test.ts — every part of a profile's outcome reaches the
// person, whatever else went wrong (#661, review pass 2 of #663).

import { describe, it, expect } from 'vitest';
import { recipeOutcomeMessages } from '../recipe-outcome.ts';

const base = {
  skillsAttached: ['dev'],
  skillsMissing: [] as string[],
  readOnlyApplied: false,
  connectorsAttached: [] as string[],
  connectorsToSetUp: [] as string[],
  connectorsNotAttached: [] as Array<{ slug: string; reason: string }>,
};

describe('recipeOutcomeMessages @cap:connecter-un-service/ecran', () => {
  it('a missing skill does not silence a connector not attached, nor the ones to set up', () => {
    const messages = recipeOutcomeMessages({
      ...base,
      skillsMissing: ['code-review'],
      connectorsNotAttached: [
        { slug: 'mcp-playwright', reason: '2 servers are "mcp-playwright" here.' },
      ],
      connectorsToSetUp: ['linear'],
    });
    expect(messages.map((m) => m.kind)).toEqual(['error', 'warning', 'info']);
    expect(messages[0]!.text).toContain('code-review');
    expect(messages[1]!.text).toBe(
      'mcp-playwright not attached: 2 servers are "mcp-playwright" here.',
    );
    expect(messages[2]!.text).toContain('linear');
  });

  it('a clean outcome says what was attached, then what is left', () => {
    const messages = recipeOutcomeMessages({
      ...base,
      connectorsAttached: ['mcp-fetch'],
      readOnlyApplied: true,
      connectorsNotAttached: [{ slug: 'mcp-git', reason: 'r' }],
    });
    expect(messages).toEqual([
      {
        kind: 'success',
        text: 'Agent created — 1 skill(s) attached, 1 connector(s) attached, read-only',
      },
      { kind: 'warning', text: 'mcp-git not attached: r' },
    ]);
  });
});
