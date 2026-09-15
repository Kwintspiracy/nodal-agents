// e2e-credential-cleanup.test.ts — proves the e2e credential cleanup guard
// tells a journey-created credential apart from an account a human connected
// by hand.
//
// The bug this locks down (nightly 2026-09-15, run 34948237666): the guard
// only counted rows, so a credential left behind by `credentials-reuse.spec.ts`
// blocked the two Google journeys that ran after it. Order-dependent journeys,
// red on a healthy product.

import { describe, it, expect } from 'vitest';
import {
  E2E_CREDENTIAL_MARKER,
  e2eCredentialName,
  isE2ECredentialName,
  planCredentialCleanup,
  blockedCredentialsMessage,
} from './e2e/credential-cleanup.ts';

describe('planCredentialCleanup', () => {
  it('deletes a credential a previous e2e journey left behind', () => {
    const row = { id: 'c1', name: e2eCredentialName('My Google (reuse test)') };
    const plan = planCredentialCleanup([row], { allowWipe: false });
    expect(plan.deleteIds).toEqual(['c1']);
    expect(plan.blocked).toEqual([]);
  });

  it('never deletes an account connected by hand, and names it', () => {
    const human = { id: 'h1', name: 'My Google' };
    const plan = planCredentialCleanup([human], { allowWipe: false });
    expect(plan.deleteIds).toEqual([]);
    expect(plan.blocked).toEqual([human]);
    expect(blockedCredentialsMessage('google-oauth', plan.blocked)).toContain('My Google');
  });

  it('separates the two when both are present', () => {
    const rows = [
      { id: 'h1', name: 'My Google' },
      { id: 'c1', name: e2eCredentialName('My Google Drive (e2e)') },
      { id: 'h2', name: 'Work Google (reuse test)' },
    ];
    const plan = planCredentialCleanup(rows, { allowWipe: false });
    expect(plan.deleteIds).toEqual(['c1']);
    expect(plan.blocked.map((r) => r.id)).toEqual(['h1', 'h2']);
  });

  it('wipes everything only when the operator asked for it', () => {
    const rows = [
      { id: 'h1', name: 'My Google' },
      { id: 'c1', name: e2eCredentialName('My Google Drive (e2e)') },
    ];
    const plan = planCredentialCleanup(rows, { allowWipe: true });
    expect(plan.deleteIds).toEqual(['h1', 'c1']);
    expect(plan.blocked).toEqual([]);
  });
});

describe('e2e credential marker', () => {
  it('recognises only the literal marker, not a wording heuristic', () => {
    expect(isE2ECredentialName(e2eCredentialName('anything'))).toBe(true);
    expect(isE2ECredentialName('My Google (reuse test)')).toBe(false);
    expect(isE2ECredentialName('My Google Drive (e2e)')).toBe(false);
    expect(e2eCredentialName('X')).toContain(E2E_CREDENTIAL_MARKER);
  });
});
