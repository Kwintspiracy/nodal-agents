// tool-result-shape.test.ts — UNE lecture de l'issue d'un appel, celle de la
// boucle (`toolResultShape`), et la garde qui retient un `return_result` à côté
// d'un outil en échec la lit sans seconde grammaire (revue Nodal de la PR #740,
// passe 1 : `{ error: 500 }` était une erreur pour un lecteur et un résultat
// rendu pour l'autre).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { toolResultShape } from '../../job/tool-result-shape.ts';

describe('the one reader of a tool outcome @cap:parler-a-un-agent/moteur', () => {
  it('the shapes the loop recognises, error codes included', () => {
    expect(toolResultShape({ type: 'json', value: { error: 'EACCES' } })).toBe('error');
    expect(toolResultShape({ type: 'json', value: { error: 500 } })).toBe('error');
    expect(
      toolResultShape({ type: 'json', value: { error: 'timeout', mayHaveDelivered: true } }),
    ).toBe('may_have_delivered');
    expect(toolResultShape({ type: 'text', value: '{"error":"cut… [truncated]' })).toBe('error');
    expect(toolResultShape({ type: 'json', value: { ok: true } })).toBe('ok');
    expect(toolResultShape({ type: 'text', value: 'plain result' })).toBe('ok');
  });

  it('the loop’s sibling-error guard reads through the same function, and no second reading exists', () => {
    const execute = readFileSync(
      fileURLToPath(new URL('../../job/execute.ts', import.meta.url)),
      'utf8',
    );
    expect(execute).toMatch(
      /isToolErrorBlock[\s\S]{0,200}toolResultShape\(block\.output\) === 'error'/,
    );
    expect(execute).not.toContain(`startsWith('{"error":')`);
  });
});
