// request-origin.test.ts — the one admission decision both servers apply.
//
// The servers' own suites prove that each door calls it on every route
// (apps/runner/src/tests/routes/request-admission.test.ts,
// apps/web/src/tests/proxy-admission.test.ts). This one proves the decision.

import { describe, it, expect } from 'vitest';
import {
  admitRequest,
  bodyTypesFor,
  hasRequestBody,
  isAllowedHost,
  mediaTypeOf,
  JSON_BODY,
  type RequestFacts,
} from '../lib/request-origin.ts';

const APP_URL = 'http://localhost:3000';

/**
 * A request with no Origin, no proof, no body, on a loopback Host, on a route
 * that does not ask for a proof (the caller rule has its own suite below).
 */
function facts(over: Partial<RequestFacts>): RequestFacts {
  return {
    origin: null,
    host: '127.0.0.1:3001',
    appUrl: APP_URL,
    proof: null,
    proofPresented: false,
    proofRequired: false,
    servesPages: false,
    contentType: null,
    hasBody: false,
    bodyTypes: JSON_BODY,
    ...over,
  };
}

const ORIGIN_REFUSED = { status: 403, reason: 'origin_not_allowed' };
const HOST_REFUSED = { status: 403, reason: 'host_not_allowed' };
const TYPE_REFUSED = { status: 415, reason: 'unsupported_media_type' };
const PROOF_REQUIRED = { status: 401, reason: 'proof_required' };
const PROOF_INVALID = { status: 401, reason: 'proof_invalid' };

describe('admitRequest: every caller proves who it is @cap:se-connecter/moteur', () => {
  const required = { proofRequired: true };

  it('no proof at all: 401 proof_required, on either server', () => {
    for (const servesPages of [false, true]) {
      expect(admitRequest(facts({ ...required, servesPages }))).toEqual(PROOF_REQUIRED);
    }
  });

  it('a proof presented that does not hold: 401 proof_invalid', () => {
    expect(admitRequest(facts({ ...required, proofPresented: true }))).toEqual(PROOF_INVALID);
  });

  it('every kind of proof admits a caller that sends no Origin', () => {
    for (const proof of ['worker_secret', 'api_token', 'device_key', 'launch_cookie'] as const) {
      expect(admitRequest(facts({ ...required, proof, proofPresented: true })), proof).toBeNull();
    }
  });

  it('the launch cookie is never what lets a page in: a foreign Origin is refused with it', () => {
    for (const servesPages of [false, true]) {
      expect(
        admitRequest(
          facts({
            ...required,
            servesPages,
            host: 'localhost:3000',
            origin: 'https://pages.example',
            proof: 'launch_cookie',
            proofPresented: true,
          }),
        ),
      ).toEqual(ORIGIN_REFUSED);
    }
  });

  it("the dashboard's own page with the cookie is served; without it, 401", () => {
    const own = { ...required, servesPages: true, host: 'localhost:3000', origin: APP_URL };
    expect(
      admitRequest(facts({ ...own, proof: 'launch_cookie', proofPresented: true })),
    ).toBeNull();
    expect(admitRequest(facts(own))).toEqual(PROOF_REQUIRED);
  });

  it('a route whose handler checks its own proof is served without one', () => {
    expect(admitRequest(facts({ proofRequired: false }))).toBeNull();
  });

  it('Host, then Origin, then the caller, then the body', () => {
    // A forged Host is refused before anything else.
    expect(admitRequest(facts({ ...required, host: 'evil.test' }))).toEqual(HOST_REFUSED);
    // A page without a header proof is an Origin refusal, not a missing proof.
    expect(admitRequest(facts({ ...required, origin: 'http://localhost:5173' }))).toEqual(
      ORIGIN_REFUSED,
    );
    // A text body with no proof: the missing proof first.
    expect(admitRequest(facts({ ...required, hasBody: true, contentType: 'text/plain' }))).toEqual(
      PROOF_REQUIRED,
    );
    // With the proof, the body is judged.
    expect(
      admitRequest(
        facts({ ...required, proof: 'worker_secret', hasBody: true, contentType: 'text/plain' }),
      ),
    ).toEqual(TYPE_REFUSED);
  });
});

describe('admitRequest: a page proves who sends it @cap:se-connecter/moteur', () => {
  const PAGES = [
    'http://192.168.1.1',
    'http://10.0.0.7:8080',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://[::1]:3000',
    'https://pages.example',
    'http://localhost:3000',
    'null',
  ];

  it('a server that serves no page refuses every Origin without a proof, wherever it lives', () => {
    for (const origin of PAGES) {
      expect(admitRequest(facts({ origin })), origin).toEqual(ORIGIN_REFUSED);
    }
  });

  it('a verified credential is the proof, whatever the Origin', () => {
    for (const proof of ['worker_secret', 'api_token', 'device_key'] as const) {
      for (const origin of PAGES) {
        expect(admitRequest(facts({ origin, proof })), `${proof} ${origin}`).toBeNull();
      }
    }
  });

  it('a request with no Origin is not a page: the rule does not apply to it', () => {
    for (const origin of [null, undefined, '']) {
      expect(admitRequest(facts({ origin }))).toBeNull();
    }
  });

  it('a server that serves pages lets its own pages in, and only them', () => {
    const own = { servesPages: true, host: 'localhost:3000' };
    expect(admitRequest(facts({ ...own, origin: 'http://localhost:3000' }))).toBeNull();
    // Another port, another name for the same machine, the default port of
    // the scheme, an opaque origin: none is this server's own page.
    for (const origin of [
      'http://localhost:5173',
      'http://127.0.0.1:3000',
      'http://localhost',
      'https://localhost',
      'http://192.168.1.1',
      'null',
    ]) {
      expect(admitRequest(facts({ ...own, origin })), origin).toEqual(ORIGIN_REFUSED);
    }
  });

  it('own pages compare with the default port of their scheme, on a LAN address and IPv6 too', () => {
    expect(
      admitRequest(facts({ servesPages: true, host: 'localhost', origin: 'http://localhost' })),
    ).toBeNull();
    expect(
      admitRequest(facts({ servesPages: true, host: 'localhost:80', origin: 'http://localhost' })),
    ).toBeNull();
    expect(
      admitRequest(
        facts({
          servesPages: true,
          host: '192.168.1.42:3000',
          origin: 'http://192.168.1.42:3000',
        }),
      ),
    ).toBeNull();
    expect(
      admitRequest(facts({ servesPages: true, host: '[::1]:3000', origin: 'http://[::1]:3000' })),
    ).toBeNull();
  });

  it('a page whose Origin and Host agree on a foreign name is refused by the Host rule', () => {
    expect(
      admitRequest(facts({ servesPages: true, host: 'evil.test', origin: 'http://evil.test' })),
    ).toEqual(HOST_REFUSED);
    expect(admitRequest(facts({ host: 'evil.test', proof: 'worker_secret' }))).toEqual(
      HOST_REFUSED,
    );
  });
});

describe('admitRequest: a body has the type its route takes @cap:se-connecter/moteur', () => {
  it('refuses the types a page sends without a preflight, on a JSON route, with a proof too', () => {
    for (const contentType of [
      'text/plain;charset=UTF-8',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
    ]) {
      expect(admitRequest(facts({ hasBody: true, contentType })), contentType).toEqual(
        TYPE_REFUSED,
      );
      expect(admitRequest(facts({ hasBody: true, contentType, proof: 'worker_secret' }))).toEqual(
        TYPE_REFUSED,
      );
    }
  });

  it('refuses a body with no type', () => {
    expect(admitRequest(facts({ hasBody: true, contentType: null }))).toEqual(TYPE_REFUSED);
  });

  it('accepts JSON, with parameters and in any case', () => {
    expect(
      admitRequest(facts({ hasBody: true, contentType: 'Application/JSON; charset=utf-8' })),
    ).toBeNull();
  });

  it('accepts a declared type on its route, and only there', () => {
    const declared = [
      { method: 'POST', path: '/api/upload/:id', types: ['application/octet-stream'] },
    ];
    const onRoute = bodyTypesFor('post', '/api/upload/abc', declared);
    expect(onRoute).toEqual(['application/octet-stream']);
    expect(
      admitRequest(
        facts({ hasBody: true, contentType: 'application/octet-stream', bodyTypes: onRoute }),
      ),
    ).toBeNull();
    expect(
      admitRequest(facts({ hasBody: true, contentType: 'application/json', bodyTypes: onRoute })),
    ).toEqual(TYPE_REFUSED);
    // Another route, another method, a deeper path: JSON.
    expect(bodyTypesFor('POST', '/api/other/abc', declared)).toEqual(JSON_BODY);
    expect(bodyTypesFor('PUT', '/api/upload/abc', declared)).toEqual(JSON_BODY);
    expect(bodyTypesFor('POST', '/api/upload/abc/more', declared)).toEqual(JSON_BODY);
    expect(bodyTypesFor('POST', '/api/upload/', declared)).toEqual(JSON_BODY);
  });

  it('no body needs no type, whatever the method', () => {
    expect(admitRequest(facts({ hasBody: false, contentType: 'text/plain' }))).toBeNull();
  });

  it('checks Host, then Origin, then the body', () => {
    expect(
      admitRequest(
        facts({
          host: 'evil.test',
          origin: 'https://pages.example',
          hasBody: true,
          contentType: null,
        }),
      ),
    ).toEqual(HOST_REFUSED);
    expect(
      admitRequest(facts({ origin: 'https://pages.example', hasBody: true, contentType: null })),
    ).toEqual(ORIGIN_REFUSED);
  });
});

describe('hasRequestBody, mediaTypeOf', () => {
  it('reads the framing headers', () => {
    expect(hasRequestBody(new Headers())).toBe(false);
    expect(hasRequestBody(new Headers({ 'content-length': '0' }))).toBe(false);
    expect(hasRequestBody(new Headers({ 'content-length': '12' }))).toBe(true);
    expect(hasRequestBody(new Headers({ 'transfer-encoding': 'chunked' }))).toBe(true);
    // Never guessed in the lenient direction.
    expect(hasRequestBody(new Headers({ 'content-length': 'x' }))).toBe(true);
  });

  it('reads a media type', () => {
    expect(mediaTypeOf(null)).toBeNull();
    expect(mediaTypeOf('')).toBeNull();
    expect(mediaTypeOf(' ; charset=x')).toBeNull();
    expect(mediaTypeOf('Text/Plain;charset=UTF-8')).toBe('text/plain');
  });
});

describe('isAllowedHost', () => {
  it('refuses an absent Host — HTTP/1.1 requires it', () => {
    expect(isAllowedHost(undefined, APP_URL)).toBe(false);
    expect(isAllowedHost('', APP_URL)).toBe(false);
  });

  it('refuses a foreign hostname, which is what stops DNS rebinding', () => {
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
