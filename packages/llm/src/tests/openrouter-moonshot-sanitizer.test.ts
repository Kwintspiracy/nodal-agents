// openrouter-moonshot-sanitizer.test.ts — the Moonshot tool-schema sanitizer
// branches into the OpenRouter request path for any Kimi model (detected by
// NAME, not host — OpenRouter is one shared host for every model family), and
// leaves non-Kimi models' tool schemas untouched.

import { describe, it, expect, vi } from 'vitest';
import { jsonSchema, tool } from 'ai';
import { patchOpenRouterRequestBody, buildOpenRouterModel } from '../providers/openrouter';
import { createLlmClient } from '../client';

const rawWeatherTool = tool({
  description: 'weather',
  inputSchema: jsonSchema({
    type: 'object',
    properties: { city: { anyOf: [{ type: 'string' }, { type: 'null' }] } },
  }),
});

const rawKimiTool = {
  type: 'function',
  function: {
    name: 'get_weather',
    parameters: {
      properties: {
        city: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        units: { enum: ['metric', 'imperial', null] },
      },
    },
  },
};

describe('patchOpenRouterRequestBody', () => {
  it('sanitizes tools for a Kimi model (moonshotai/kimi-k2.6)', () => {
    const body = patchOpenRouterRequestBody({
      model: 'moonshotai/kimi-k2.6',
      tools: [rawKimiTool],
    }) as Record<string, unknown>;

    const tools = body['tools'] as Array<{ function: { parameters: Record<string, unknown> } }>;
    const params = tools[0]!.function.parameters;
    expect(params['type']).toBe('object');
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['city']).toEqual({ type: 'string' });
    expect(props['units']).toEqual({ type: 'string', enum: ['metric', 'imperial'] });
  });

  it('sanitizes tools for an aggregator-prefixed Kimi slug', () => {
    const body = patchOpenRouterRequestBody({
      model: 'nous/moonshotai/kimi-k2.6',
      tools: [rawKimiTool],
    }) as Record<string, unknown>;
    const tools = body['tools'] as Array<{ function: { parameters: Record<string, unknown> } }>;
    expect(
      (tools[0]!.function.parameters['properties'] as Record<string, unknown>)['city'],
    ).toEqual({
      type: 'string',
    });
  });

  it('does NOT sanitize tools for a non-Kimi model — schema passes through byte-identical', () => {
    const original = {
      model: 'anthropic/claude-sonnet-4.6',
      tools: [rawKimiTool],
    };
    const body = patchOpenRouterRequestBody(original) as Record<string, unknown>;
    // Untouched: the raw (unsanitized) anyOf/null-enum shape survives as-is.
    expect(body['tools']).toEqual(original.tools);
  });

  it('passes through bodies with no tools untouched', () => {
    const body = patchOpenRouterRequestBody({
      model: 'moonshotai/kimi-k2.6',
      messages: [],
    }) as Record<string, unknown>;
    expect(body).not.toHaveProperty('tools');
  });

  it('passes non-object bodies through unchanged', () => {
    expect(patchOpenRouterRequestBody(null)).toBeNull();
    expect(patchOpenRouterRequestBody('text')).toBe('text');
  });
});

// ─── End-to-end: the actual fetch wrapper built into buildOpenRouterModel ─────

describe('OpenRouter fetch wrapper — Moonshot sanitizer branch (end-to-end)', () => {
  it('rewrites the outgoing tools for a Kimi model routed through OpenRouter', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.6',
      apiKey: 'or-test-key',
    });

    await client.generateText({
      prompt: 'weather?',
      tools: { get_weather: rawWeatherTool },
    });

    expect(capturedBody).toBeDefined();
    const tools = capturedBody!['tools'] as Array<{
      function: { parameters: Record<string, unknown> };
    }>;
    expect(tools.length).toBeGreaterThan(0);
    const props = tools[0]!.function.parameters['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    // The raw anyOf/null shape must have been repaired before hitting the wire.
    expect(props['city']).toEqual({ type: 'string' });

    vi.unstubAllGlobals();
  });

  it('leaves a non-Kimi model tools schema untouched end-to-end', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    const fakeFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: 'x',
          choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fakeFetch);

    const client = createLlmClient({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
      apiKey: 'or-test-key',
    });

    await client.generateText({
      prompt: 'weather?',
      tools: { get_weather: rawWeatherTool },
    });

    expect(capturedBody).toBeDefined();
    const tools = capturedBody!['tools'] as Array<{
      function: { parameters: Record<string, unknown> };
    }>;
    // Untouched: still carries the raw anyOf shape (no Moonshot repair applied).
    const props = tools[0]!.function.parameters['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    expect(props['city']).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });

    vi.unstubAllGlobals();
  });

  it('buildOpenRouterModel still constructs a LanguageModel without throwing', () => {
    const model = buildOpenRouterModel({
      provider: 'openrouter',
      model: 'moonshotai/kimi-k2.6',
      apiKey: 'or-test',
    });
    expect(model).toBeDefined();
  });
});
