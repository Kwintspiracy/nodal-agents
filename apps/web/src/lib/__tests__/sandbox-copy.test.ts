// sandbox-copy.test.ts — les phrases du bac à sable (#876), et surtout celle
// du bandeau permanent : il parle tant que le bac à sable est coupé,
// indisponible, ou que son état n'a pas pu être lu ; il ne se tait que quand
// le runner dit qu'il confine.

import { describe, it, expect } from 'vitest';
import type { SandboxState } from '@nodal-agents/shared';
import { limitWords, sandboxBannerWords, unavailableWords } from '../sandbox-copy.ts';

const state = (over: Partial<SandboxState>): SandboxState => ({
  platform: 'win32',
  status: { state: 'available', backend: 'mxc-processcontainer' },
  enabled: true,
  allowedFolders: [],
  agents: [],
  sharedFolder: null,
  readRefused: [],
  network: { deniedPorts: [] },
  ...over,
});

describe('sandboxBannerWords @cap:executer-une-commande/ecran', () => {
  it('silent only when the runner says the sandbox confines', () => {
    expect(sandboxBannerWords(state({}))).toBeNull();
  });

  it('speaks while it is off, unavailable, not on this system, or unread', () => {
    expect(sandboxBannerWords(state({ enabled: false }))).toBe(
      'The sandbox is off for this workspace. Commands run without confinement.',
    );
    expect(
      sandboxBannerWords(
        state({ status: { state: 'unavailable', code: 'SANDBOX_SELF_TEST_FAILED', reason: 'x' } }),
      ),
    ).toBe(
      'The sandbox is unavailable: its self-test failed on this machine. Commands run without confinement.',
    );
    expect(
      sandboxBannerWords(
        state({ status: { state: 'unavailable', code: 'SANDBOX_NOT_IMPLEMENTED', reason: 'x' } }),
      ),
    ).toBe('The sandbox is not available on this system yet. Commands run without confinement.');
    expect(sandboxBannerWords(null)).toBe(
      'The sandbox state could not be read. Commands may run without confinement.',
    );
  });

  it('a code it does not know is shown as it is, never replaced by a made-up sentence', () => {
    expect(unavailableWords('SANDBOX_SOMETHING_NEW')).toBe('SANDBOX_SOMETHING_NEW');
    expect(limitWords('SANDBOX_LIMIT_NEW: what the backend said')).toEqual({
      code: 'SANDBOX_LIMIT_NEW',
      words: 'what the backend said',
    });
  });
});
