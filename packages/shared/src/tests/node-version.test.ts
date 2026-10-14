import { describe, expect, it } from 'vitest';
import { nodeVersionProblem } from '../node-version';

describe('nodeVersionProblem (#628)', () => {
  it.each(['22.12.0', '23.11.1', 'v22.0.0'])('refuses Node %s with the install message', (v) => {
    expect(nodeVersionProblem(v)).toBe(
      `Nodal needs Node.js 24 or newer; this is Node.js ${v}. Install Node 24: https://nodejs.org`,
    );
  });

  it.each(['24.0.0', '26.4.0', 'v24.1.2'])('accepts Node %s', (v) => {
    expect(nodeVersionProblem(v)).toBeNull();
  });

  it.each(['', 'banana', '24', 'x.24.0'])('refuses the malformed version %j loudly', (v) => {
    expect(nodeVersionProblem(v)).toContain('Nodal needs Node.js 24 or newer');
  });
});
