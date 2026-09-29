// local-url.test.ts — which model endpoints are on the user's machine or
// network (#608)
//
// One definition, read by the turn clocks (a local model is slow, not dead)
// and by the provider transport (a local model is reached directly, never
// through the environment's proxy, which cannot reach it).

import { describe, it, expect } from 'vitest';

import { isLocalUrl } from '../local-url';

describe('isLocalUrl (#608) @cap:choisir-modele/moteur', () => {
  it.each([
    'http://localhost:11434',
    'http://127.0.0.1:1234/v1',
    'http://[::1]:8080',
    'http://10.0.0.5:8000/v1',
    'http://192.168.1.60:8080/v1',
    'http://172.20.0.2:11434',
    // A bare name only resolves on the local network (search domain, hosts
    // file, a compose service): no public host is dotless.
    'http://gpu-box:11434',
    'http://ollama:11434/api',
    // RFC 6762: multicast DNS names.
    'http://studio.local:1234/v1',
    // RFC 8375: the special-use domain for home networks.
    'http://nas.home.arpa:8080/v1',
    // ICANN (2024): `.internal` is reserved for private use, never delegated.
    'http://llm.corp.internal/v1',
  ])('%s is local', (url) => {
    expect(isLocalUrl(url)).toBe(true);
  });

  it.each([
    'https://openrouter.ai/api/v1',
    'https://api.openai.com/v1',
    'https://8.8.8.8/v1',
    'https://provider.example.com/v1',
    // No IETF or ICANN reservation: widely used by home routers, but also a
    // name anyone may register tomorrow. Left to NO_PROXY.
    'http://nas.lan:8080',
    'http://box.home:8080',
    'not a url',
  ])('%s is not local', (url) => {
    expect(isLocalUrl(url)).toBe(false);
  });
});
