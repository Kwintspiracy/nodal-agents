import { it, expect } from 'vitest';

// Rouge quand la garde le demande, vert sinon : le même run prouve les deux
// sens du code de sortie.
it('verdict imposed by the guard', () => {
  expect(process.env['PG_RUN_EXIT_CODE_VERDICT']).toBe('green');
});
