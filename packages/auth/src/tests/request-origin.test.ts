// request-origin.test.ts — NETWORK-001 regression suite.
//
// Every case below is one of the requests actually sent against a running
// install during the audit, with the verdict it must now produce. The four that
// returned 202 (job created, agent started) are the ones this guard exists for.

import { describe, it, expect } from 'vitest';
import { checkRequestOrigin, isAllowedHost, isAllowedOrigin } from '../lib/request-origin.ts';

const APP_URL = 'http://localhost:3001';

describe('isAllowedOrigin', () => {
  it('allows an absent Origin — a hostile page cannot suppress the header', () => {
    // curl, a script, and the dashboard's own server-side fetch send no Origin.
    // A browser ALWAYS attaches it to a cross-origin POST, so absence is proof
    // the caller is not a page.
    expect(isAllowedOrigin(undefined, APP_URL)).toBe(true);
    expect(isAllowedOrigin(null, APP_URL)).toBe(true);
    expect(isAllowedOrigin('', APP_URL)).toBe(true);
  });

  it('refuses a public attacker origin', () => {
    expect(isAllowedOrigin('https://attacker.test', APP_URL)).toBe(false);
    expect(isAllowedOrigin('http://evil.test', APP_URL)).toBe(false);
    expect(isAllowedOrigin('https://nodal-agents.com.attacker.test', APP_URL)).toBe(false);
  });

  it('refuses the literal "null" origin (sandboxed iframe, data:, file:)', () => {
    // Exactly the contexts used to hide where a request came from.
    expect(isAllowedOrigin('null', APP_URL)).toBe(false);
  });

  it('allows loopback and LAN origins', () => {
    expect(isAllowedOrigin('http://localhost:3000', APP_URL)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:3000', APP_URL)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:3000', APP_URL)).toBe(true);
    expect(isAllowedOrigin('http://192.168.1.42:3000', APP_URL)).toBe(true);
    expect(isAllowedOrigin('http://10.0.0.7:3000', APP_URL)).toBe(true);
  });

  it('allows the configured APP_URL host', () => {
    expect(isAllowedOrigin('https://nodal.example.com', 'https://nodal.example.com')).toBe(true);
  });
});

describe('isAllowedHost', () => {
  it('refuses an absent Host — HTTP/1.1 requires it', () => {
    expect(isAllowedHost(undefined, APP_URL)).toBe(false);
    expect(isAllowedHost('', APP_URL)).toBe(false);
  });

  it('refuses an attacker hostname — this is what stops DNS rebinding', () => {
    expect(isAllowedHost('evil.test', APP_URL)).toBe(false);
    expect(isAllowedHost('evil.test:3001', APP_URL)).toBe(false);
    expect(isAllowedHost('rebind.attacker.test:3001', APP_URL)).toBe(false);
  });

  it('accepts loopback names and addresses, with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:3001',
      '127.0.0.1',
      '127.0.0.1:3001',
      '[::1]:3001',
      '::1',
    ]) {
      expect(isAllowedHost(host, APP_URL), host).toBe(true);
    }
  });

  it('accepts a private LAN address (phone on the same WiFi)', () => {
    expect(isAllowedHost('192.168.1.42:3000', APP_URL)).toBe(true);
    expect(isAllowedHost('10.1.2.3:3000', APP_URL)).toBe(true);
    expect(isAllowedHost('172.16.5.9:3000', APP_URL)).toBe(true);
  });

  it('accepts the host APP_URL points at', () => {
    expect(isAllowedHost('nodal.example.com:3001', 'https://nodal.example.com')).toBe(true);
  });

  it('refuses a public address that is not APP_URL', () => {
    expect(isAllowedHost('8.8.8.8:3001', APP_URL)).toBe(false);
    expect(isAllowedHost('203.0.113.10', APP_URL)).toBe(false);
  });
});

describe('checkRequestOrigin — the six requests measured during the audit', () => {
  // Each of these returned 202 (job created) against nodal-agents@0.8.1 in the
  // default configuration. They must now be refused, except the legitimate ones.

  it('refuses a hostile Origin (plain CSRF from a visited page)', () => {
    expect(
      checkRequestOrigin({
        origin: 'https://attacker.test',
        host: 'localhost:3001',
        appUrl: APP_URL,
      }),
    ).toBe('origin_not_allowed');
  });

  it('refuses a forged Host (rebinding, Origin absent)', () => {
    expect(checkRequestOrigin({ origin: null, host: 'evil.test', appUrl: APP_URL })).toBe(
      'host_not_allowed',
    );
  });

  it('refuses DNS rebinding where Origin and Host AGREE', () => {
    // The case Next's Origin-vs-Host comparison lets through: measured HTTP 200
    // on the dashboard, HTTP 202 on the runner.
    expect(
      checkRequestOrigin({ origin: 'http://evil.test', host: 'evil.test', appUrl: APP_URL }),
    ).toBe('origin_not_allowed');
  });

  it('refuses a text/plain CSRF (no preflight the server could reject)', () => {
    // Content-Type never reaches this check — what stops the request is the
    // Origin the browser is forced to attach.
    expect(
      checkRequestOrigin({
        origin: 'https://attacker.test',
        host: '127.0.0.1:3001',
        appUrl: APP_URL,
      }),
    ).toBe('origin_not_allowed');
  });

  it('still allows the dashboard calling the runner server-side (no Origin)', () => {
    expect(
      checkRequestOrigin({ origin: undefined, host: '127.0.0.1:3001', appUrl: APP_URL }),
    ).toBeNull();
  });

  it('still allows a local script or curl (no Origin, loopback Host)', () => {
    expect(
      checkRequestOrigin({ origin: null, host: 'localhost:3001', appUrl: APP_URL }),
    ).toBeNull();
  });

  it('still allows a phone on the LAN reaching the install by IP', () => {
    expect(
      checkRequestOrigin({
        origin: 'http://192.168.1.42:3000',
        host: '192.168.1.42:3001',
        appUrl: APP_URL,
      }),
    ).toBeNull();
  });

  it('checks Origin before Host, so a hostile page is reported as such', () => {
    // Both are wrong here; the Origin verdict is the more informative one.
    expect(
      checkRequestOrigin({ origin: 'https://attacker.test', host: 'evil.test', appUrl: APP_URL }),
    ).toBe('origin_not_allowed');
  });
});
