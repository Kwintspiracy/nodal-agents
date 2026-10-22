// Un run vert : vitest arrête lui-même ses workers à la fin.
import { it, expect } from 'vitest';

it('passes', () => {
  expect(1 + 1).toBe(2);
});
