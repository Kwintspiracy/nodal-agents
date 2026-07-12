// google.test.ts — unit tests for the Google Generative AI native transport provider.
//
// Tests:
// 1. injectGoogleThinking — pure body-rewrite helper (host-agnostic).
// 2. buildGoogleModel — constructs a LanguageModel without throwing.
// 3. createLlmClient dispatch — 'google' routes to a client with google
//    capabilities from the registry.
// 4. The fetch wrapper — host-gating + real end-to-end body rewrite, verified
//    on the actual JSON body reaching the intercepted upstream fetch, for a
//    reasoning-catalogued model vs a non-reasoning/unknown model vs a
//    non-Google host.

import { describe, it, expect, vi } from 'vitest';
import { buildGoogleModel, injectGoogleThinking } from '../providers/google';
import { createLlmClient } from '../client';
import { CAPABILITY_MATRIX } from '../providers/registry';

// ─── injectGoogleThinking — pure function ─────────────────────────────────────

describe('injectGoogleThinking', () => {
  it('injects generationConfig.thinkingConfig = { includeThoughts: true } when absent', () => {
    const body = injectGoogleThinking({
      contents: [],
      generationConfig: { temperature: 0.7 },
    }) as Record<string, unknown>;
    const generationConfig = body['generationConfig'] as Record<string, unknown>;
    expect(generationConfig['thinkingConfig']).toEqual({ includeThoughts: true });
    // Untouched sibling fields survive.
    expect(generationConfig['temperature']).toBe(0.7);
  });

  it('creates generationConfig when the body has none', () => {
    const body = injectGoogleThinking({ contents: [] }) as Record<string, unknown>;
    expect(body['generationConfig']).toEqual({ thinkingConfig: { includeThoughts: true } });
  });

  it('is idempotent — a body with an explicit thinkingConfig is left untouched', () => {
    const preset = {
      generationConfig: { thinkingConfig: { thinkingBudget: 4000, includeThoughts: false } },
    };
    const out = injectGoogleThinking(preset) as Record<string, unknown>;
    const generationConfig = out['generationConfig'] as Record<string, unknown>;
    expect(generationConfig['thinkingConfig']).toEqual({
      thinkingBudget: 4000,
      includeThoughts: false,
    });
  });

  it('passes non-object bodies through unchanged', () => {
    expect(injectGoogleThinking(null)).toBeNull();
    expect(injectGoogleThinking('text')).toBe('text');
  });
});

// ─── buildGoogleModel ──────────────────────────────────────────────────────────

describe('buildGoogleModel', () => {
  it('constructs a LanguageModel object without throwing', () => {
    const model = buildGoogleModel({
      provider: 'google',
      model: 'gemini-3.5-flash',
      apiKey: 'google-test-key',
    });
    expect(model).toBeDefined();
    expect(typeof (model as { specificationVersion?: unknown }).specificationVersion).toBe(
      'string',
    );
  });

  it('accepts a custom baseURL override', () => {
    const model = buildGoogleModel({
      provider: 'google',
      model: 'gemini-3.5-flash',
      apiKey: 'google-test-key',
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    });
    expect(model).toBeDefined();
  });
});

// ─── createLlmClient dispatch ─────────────────────────────────────────────────

describe('createLlmClient google dispatch', () => {
  it('routes provider:google to a client with google capabilities', () => {
    const client = createLlmClient({
      provider: 'google',
      model: 'gemini-3.5-flash',
      apiKey: 'google-test',
    });
    expect(client.config.provider).toBe('google');
    expect(client.capabilities).toEqual(CAPABILITY_MATRIX['google']);
  });

  it('exposes the standard client methods', () => {
    const client = createLlmClient({
      provider: 'google',
      model: 'gemini-3.5-flash',
      apiKey: 'google-test',
    });
    expect(typeof client.generateText).toBe('function');
    expect(typeof client.streamText).toBe('function');
    expect(typeof client.generateObject).toBe('function');
  });
});

// ─── Google fetch wrapper — host-gating + real end-to-end body rewrite ────────
// Exercises the actual fetch wrapper built into the LanguageModel (not a
// reimplementation) by intercepting global fetch and inspecting the exact
// JSON body it sends upstream.

function fakeGoogleResponse(): Response {
  return new Response(
    JSON.stringify({
      candidates: [
        {
          content: { role: 'model', parts: [{ text: 'ok' }] },
          finishReason: 'STOP',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('Google fetch wrapper behaviour (end-to-end via generateText)', () => {
  it('injects thinkingConfig for a reasoning-catalogued model on the real Google host', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return fakeGoogleResponse();
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'google',
      model: 'gemini-3.5-flash', // catalogued reasoning:true
      apiKey: 'google-test',
    });

    await client.generateText({ prompt: 'hi' });

    expect(capturedBody).toBeDefined();
    const generationConfig = capturedBody!['generationConfig'] as Record<string, unknown>;
    expect(generationConfig['thinkingConfig']).toEqual({ includeThoughts: true });

    vi.unstubAllGlobals();
  });

  it('does NOT inject thinkingConfig for a non-reasoning/uncatalogued model', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return fakeGoogleResponse();
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'google',
      model: 'some-custom-gemma-model', // not in the catalog → isReasoning=false
      apiKey: 'google-test',
    });

    await client.generateText({ prompt: 'hi' });

    expect(capturedBody).toBeDefined();
    const generationConfig = (capturedBody!['generationConfig'] ?? {}) as Record<string, unknown>;
    expect(generationConfig['thinkingConfig']).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('does NOT rewrite requests to a non-Google host', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return fakeGoogleResponse();
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'google',
      model: 'gemini-3.5-flash',
      apiKey: 'google-test',
      baseURL: 'https://some-other-host.example.com/v1beta',
    });

    await client.generateText({ prompt: 'hi' });

    expect(capturedBody).toBeDefined();
    const generationConfig = (capturedBody!['generationConfig'] ?? {}) as Record<string, unknown>;
    // Host isn't gated in: no thinkingConfig injected even for a reasoning model.
    expect(generationConfig['thinkingConfig']).toBeUndefined();

    vi.unstubAllGlobals();
  });
});
