// launch-link.test.ts — the launch link and the dashboard cookie, derived from
// the install's secret.

import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_COOKIE_MAX_AGE_S,
  LAUNCH_PARAM,
  LAUNCH_TTL_MS,
  LaunchLedger,
  dashboardCookieName,
  launchUrl,
  mintDashboardCookie,
  mintLaunchToken,
  verifyDashboardCookie,
  verifyLaunchToken,
} from '../lib/launch-link.ts';

const SECRET = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0);

describe('the launch link @cap:se-connecter/moteur', () => {
  it('holds for this install, within its time, and names a nonce', () => {
    const token = mintLaunchToken(SECRET, NOW, 'nonce-1');
    expect(verifyLaunchToken(SECRET, token, NOW + 1)).toEqual({
      ok: true,
      nonce: 'nonce-1',
      expiresAt: NOW + LAUNCH_TTL_MS,
    });
  });

  it('another install does not accept it', () => {
    const token = mintLaunchToken(SECRET, NOW);
    expect(verifyLaunchToken(OTHER, token, NOW)).toEqual({ ok: false, reason: 'launch_invalid' });
  });

  it('it expires', () => {
    const token = mintLaunchToken(SECRET, NOW);
    expect(verifyLaunchToken(SECRET, token, NOW + LAUNCH_TTL_MS + 1)).toEqual({
      ok: false,
      reason: 'launch_expired',
    });
  });

  it('a later expiry written over the token breaks its signature', () => {
    const [, nonce, signature] = mintLaunchToken(SECRET, NOW).split('.');
    const forged = `${(NOW + 10 * LAUNCH_TTL_MS).toString(36)}.${nonce}.${signature}`;
    expect(verifyLaunchToken(SECRET, forged, NOW)).toEqual({ ok: false, reason: 'launch_invalid' });
  });

  it('a truncated or foreign token is malformed', () => {
    for (const token of ['', 'abc', 'a.b', 'a.b.c.d', 'zz.n.<script>']) {
      expect(verifyLaunchToken(SECRET, token, NOW), token).toEqual({
        ok: false,
        reason: 'launch_malformed',
      });
    }
  });

  it('nothing is derived from an empty secret, and an empty secret accepts nothing', () => {
    expect(() => mintLaunchToken('', NOW)).toThrow(/install_secret_missing/);
    expect(() => dashboardCookieName('')).toThrow(/install_secret_missing/);
    expect(() => mintDashboardCookie('', NOW)).toThrow(/install_secret_missing/);
    const token = mintLaunchToken(SECRET, NOW);
    expect(verifyLaunchToken('', token, NOW)).toEqual({ ok: false, reason: 'launch_invalid' });
  });

  it('launchUrl keeps the address and adds the token only', () => {
    const url = new URL(launchUrl('http://localhost:3000/agents?tab=x', SECRET, NOW));
    expect(url.origin).toBe('http://localhost:3000');
    expect(url.pathname).toBe('/agents');
    expect(url.searchParams.get('tab')).toBe('x');
    const token = url.searchParams.get(LAUNCH_PARAM) ?? '';
    expect(verifyLaunchToken(SECRET, token, NOW).ok).toBe(true);
  });

  it('two links are two nonces', () => {
    const a = verifyLaunchToken(SECRET, mintLaunchToken(SECRET, NOW), NOW);
    const b = verifyLaunchToken(SECRET, mintLaunchToken(SECRET, NOW), NOW);
    expect(a.ok && b.ok && a.nonce !== b.nonce).toBe(true);
  });
});

describe('the ledger of used links @cap:se-connecter/moteur', () => {
  it('a nonce is accepted once', () => {
    const ledger = new LaunchLedger();
    expect(ledger.consume('n', NOW + LAUNCH_TTL_MS, NOW)).toBe(true);
    expect(ledger.consume('n', NOW + LAUNCH_TTL_MS, NOW + 1)).toBe(false);
    expect(ledger.consume('m', NOW + LAUNCH_TTL_MS, NOW + 2)).toBe(true);
  });

  it('a nonce is forgotten only once its link has expired anyway', () => {
    const ledger = new LaunchLedger();
    ledger.consume('n', NOW + LAUNCH_TTL_MS, NOW);
    expect(ledger.consume('n', NOW + LAUNCH_TTL_MS, NOW + LAUNCH_TTL_MS)).toBe(false);
    // Past its expiry the verifier refuses the link before the ledger is asked.
    expect(ledger.consume('n', NOW + 2 * LAUNCH_TTL_MS, NOW + LAUNCH_TTL_MS + 1)).toBe(true);
  });
});

describe('the dashboard cookie @cap:se-connecter/moteur', () => {
  it('holds for this install for 400 days, and not after', () => {
    const value = mintDashboardCookie(SECRET, NOW);
    expect(verifyDashboardCookie(SECRET, value, NOW + 1)).toBeNull();
    expect(
      verifyDashboardCookie(SECRET, value, NOW + DASHBOARD_COOKIE_MAX_AGE_S * 1000),
    ).toBeNull();
    expect(verifyDashboardCookie(SECRET, value, NOW + DASHBOARD_COOKIE_MAX_AGE_S * 1000 + 1)).toBe(
      'launch_expired',
    );
  });

  it('another install does not accept it, and a changed date breaks it', () => {
    const value = mintDashboardCookie(SECRET, NOW);
    expect(verifyDashboardCookie(OTHER, value, NOW)).toBe('launch_invalid');
    const [, signature] = value.split('.');
    expect(verifyDashboardCookie(SECRET, `${(NOW + 1).toString(36)}.${signature}`, NOW)).toBe(
      'launch_invalid',
    );
    expect(verifyDashboardCookie(SECRET, 'garbage', NOW)).toBe('launch_malformed');
  });

  it('its name is one per install, and a valid cookie name', () => {
    expect(dashboardCookieName(SECRET)).toBe(dashboardCookieName(SECRET));
    expect(dashboardCookieName(SECRET)).not.toBe(dashboardCookieName(OTHER));
    expect(dashboardCookieName(SECRET)).toMatch(/^nodal_dash_[0-9a-f]{12}$/);
  });

  it('a launch token is not a cookie, and a cookie is not a launch token', () => {
    const token = mintLaunchToken(SECRET, NOW, 'n');
    expect(verifyDashboardCookie(SECRET, token, NOW)).toBe('launch_malformed');
    const value = mintDashboardCookie(SECRET, NOW);
    expect(verifyLaunchToken(SECRET, value, NOW)).toEqual({
      ok: false,
      reason: 'launch_malformed',
    });
  });
});
