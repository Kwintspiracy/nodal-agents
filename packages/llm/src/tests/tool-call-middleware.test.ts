// tool-call-middleware.test.ts — native tool-call parsers + middleware behavior
//
// Covers: per-family parser extraction (Kimi K2, Nodal JSON-in-XML),
// middleware end-to-end through generateText, APICallError recovery on legit
// native-markup responses, dispatcher matrix, fail-loud on streamText.
//
// DeepSeek-specific tests removed 2026-05-18 along with the parser — live
// observation showed DeepSeek V4 Pro emits standard OpenAI tool_calls (the
// arguments-as-object spec violation is normalised at the fetch boundary by
// `tolerant-fetch.ts`). The OpenAI-tool_calls extraction path inside
// `recoverFromResponseBody` was removed at the same time as it became
// unreachable.

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { wrapLanguageModel, generateText, tool, stepCountIs } from 'ai';
import { APICallError } from '@ai-sdk/provider';
import { z } from 'zod';

import { nodalToolCallMiddleware, __testing } from '../providers/parsers';
import { detectAgenticFamily } from '../providers/openrouter';
import { mockTextResult, mockToolCallResult } from './_mock-helpers';

const { kimiNativeParser, nodalNativeParser } = __testing;

// ─── Kimi K2 parser ────────────────────────────────────────────────────────────

describe('kimiNativeParser', () => {
  it('extracts a single tool call from Kimi pipe-bracket markup', () => {
    const text =
      '<|tool_calls_section_begin|>' +
      '<|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"city": "Lyon"}<|tool_call_end|>' +
      '<|tool_calls_section_end|>';
    const result = kimiNativeParser(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(result.toolCalls[0]?.toolCallId).toBe('functions.get_weather:0');
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ city: 'Lyon' });
  });

  it('also accepts the singular start-token variant', () => {
    const text =
      '<|tool_call_section_begin|>' +
      '<|tool_call_begin|>ping:0<|tool_call_argument_begin|>{}<|tool_call_end|>' +
      '<|tool_call_section_end|>';
    const result = kimiNativeParser(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('ping');
  });

  it('extracts function name from id without namespace prefix', () => {
    const text =
      '<|tool_calls_section_begin|>' +
      '<|tool_call_begin|>send_email:7<|tool_call_argument_begin|>{"to":"x"}<|tool_call_end|>' +
      '<|tool_calls_section_end|>';
    const result = kimiNativeParser(text);
    expect(result.toolCalls[0]?.toolName).toBe('send_email');
    expect(result.toolCalls[0]?.toolCallId).toBe('send_email:7');
  });

  it('returns text unchanged when no start token', () => {
    const result = kimiNativeParser('plain text reply');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toBe('plain text reply');
  });
});

// ─── Nodal / Qwen3 parser ────────────────────────────────────────────────────

describe('nodalNativeParser', () => {
  it('extracts a single Nodal-format tool call', () => {
    const text =
      'Looking up.\n<tool_call>{"name": "get_weather", "arguments": {"city": "Berlin"}}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ city: 'Berlin' });
    expect(result.text).toBe('Looking up.');
  });

  it('extracts multiple Nodal-format calls', () => {
    const text =
      '<tool_call>{"name":"a","arguments":{}}</tool_call>' +
      '<tool_call>{"name":"b","arguments":{"x":1}}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(2);
  });

  it('skips malformed JSON blocks without throwing', () => {
    const text =
      '<tool_call>{"name":"good","arguments":{}}</tool_call>' +
      '<tool_call>not valid json</tool_call>' +
      '<tool_call>{"name":"after","arguments":{}}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls.map((c) => c.toolName)).toEqual(['good', 'after']);
  });

  it('skips blocks missing the name field', () => {
    const text = '<tool_call>{"arguments":{"x":1}}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('handles arguments as a JSON-stringified payload (lenient)', () => {
    const text = '<tool_call>{"name":"do","arguments":"{\\"x\\":1}"}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.input).toBe('{"x":1}');
  });

  it('handles missing arguments by defaulting to {}', () => {
    const text = '<tool_call>{"name":"ping"}</tool_call>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls[0]?.input).toBe('{}');
  });

  it('returns text unchanged when no tool_call tags present', () => {
    const result = nodalNativeParser('plain reply');
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toBe('plain reply');
  });
});

// ─── Middleware: end-to-end through generateText ──────────────────────────────

describe('createNativeToolCallMiddleware end-to-end (mock LLM)', () => {
  it('passes through cleanly when provider already extracted tool calls', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () =>
        mockToolCallResult([
          {
            toolCallId: 'call-existing',
            toolName: 'get_weather',
            input: JSON.stringify({ city: 'Paris' }),
          },
        ]),
    });

    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });

    const result = await generateText({
      model: wrapped,
      prompt: 'weather?',
      tools: {
        get_weather: tool({
          description: 'weather',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    const firstStep = result.steps[0];
    expect(firstStep?.toolCalls).toHaveLength(1);
    expect(firstStep?.toolCalls[0]?.toolName).toBe('get_weather');
  });

  it('extracts native markup from result.text when provider returned no toolCalls', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () =>
        mockTextResult(
          '<tool_call>{"name":"get_weather","arguments":{"city":"Marseille"}}</tool_call>',
        ),
    });

    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });

    const result = await generateText({
      model: wrapped,
      prompt: 'weather?',
      tools: {
        get_weather: tool({
          description: 'weather',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    const firstStep = result.steps[0];
    expect(firstStep?.toolCalls).toHaveLength(1);
    expect(firstStep?.toolCalls[0]?.toolName).toBe('get_weather');
  });

  it('does NOT inject any system prompt (philosophy: no prompt modification)', async () => {
    let observedPromptHadAddendum = false;
    let observedToolsPresent = false;

    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async (params) => {
        // V3CallOptions: tools is at the top level (no more params.mode.type/tools)
        observedToolsPresent = (params.tools?.length ?? 0) > 0;
        const sys = params.prompt[0];
        if (sys && sys.role === 'system' && typeof sys.content === 'string') {
          observedPromptHadAddendum =
            sys.content.includes('Tool calling format') || sys.content.includes('<tool_call>');
        }
        return mockTextResult('');
      },
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });
    await generateText({
      model: wrapped,
      system: 'You are an assistant.',
      prompt: 'hi',
      tools: {
        ping: tool({
          description: 'ping',
          inputSchema: z.object({}),
          execute: async () => 'pong',
        }),
      },
      stopWhen: stepCountIs(1),
    });

    expect(observedPromptHadAddendum).toBe(false);
    expect(observedToolsPresent).toBe(true);
  });

  it('passes through clean text when no native markup', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () => mockTextResult('plain reply no markup'),
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });
    const result = await generateText({
      model: wrapped,
      prompt: 'hi',
      stopWhen: stepCountIs(1),
    });
    expect(result.text).toBe('plain reply no markup');
    expect(result.toolCalls).toHaveLength(0);
  });
});

// ─── Middleware: APICallError recovery ─────────────────────────────────────────

describe('createNativeToolCallMiddleware error recovery', () => {
  it('recovers from APICallError("Invalid JSON response") by parsing responseBody with native markup', async () => {
    // When the body carries native markup in `content` and AI SDK rejected
    // the response (e.g. Zod schema mismatch on some unrelated field), the
    // parser path kicks in and rebuilds a valid LanguageModelV3 result.
    const recoveredBody = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '<tool_call>{"name":"do_thing","arguments":{"arg":42}}</tool_call>',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () => {
        throw new APICallError({
          message: 'Invalid JSON response',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          requestBodyValues: {},
          responseBody: recoveredBody,
          statusCode: 200,
        });
      },
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });
    const result = await generateText({
      model: wrapped,
      prompt: 'x',
      tools: {
        do_thing: tool({
          description: 'd',
          inputSchema: z.object({ arg: z.number() }),
          execute: async ({ arg }) => `${arg}`,
        }),
      },
      stopWhen: stepCountIs(2),
    });
    expect(result.steps[0]?.toolCalls).toHaveLength(1);
    expect(result.steps[0]?.toolCalls[0]?.input).toEqual({ arg: 42 });
  });

  it('re-throws APICallError when responseBody has no native markup', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () => {
        throw new APICallError({
          message: 'Invalid JSON response',
          url: 'https://openrouter.ai/api/v1/chat/completions',
          requestBodyValues: {},
          responseBody: JSON.stringify({
            choices: [{ message: { content: 'just text, no tool markup' } }],
          }),
          statusCode: 200,
        });
      },
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });
    await expect(
      generateText({ model: wrapped, prompt: 'x', stopWhen: stepCountIs(1) }),
    ).rejects.toThrow(/Invalid JSON response/);
  });

  it('re-throws non-APICallError errors (no silent fallback)', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-nodal',
      doGenerate: async () => {
        throw new Error('network timeout');
      },
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: nodalToolCallMiddleware,
    });
    await expect(
      generateText({ model: wrapped, prompt: 'x', stopWhen: stepCountIs(1) }),
    ).rejects.toThrow(/network timeout/);
  });

  it('wrapStream throws UnsupportedFunctionalityError (no silent fallback)', async () => {
    expect(nodalToolCallMiddleware.wrapStream).toBeDefined();
    await expect(
      nodalToolCallMiddleware.wrapStream!({
        doStream: () => {
          throw new Error('should not reach doStream');
        },
        doGenerate: () => {
          throw new Error('should not reach doGenerate');
        },
        params: {} as unknown as Parameters<
          NonNullable<typeof nodalToolCallMiddleware.wrapStream>
        >[0]['params'],
        model: {} as unknown as Parameters<
          NonNullable<typeof nodalToolCallMiddleware.wrapStream>
        >[0]['model'],
      }),
    ).rejects.toThrow(/text-based tool-call parsing/i);
  });
});

// ─── OpenRouter dispatcher matrix ─────────────────────────────────────────────

describe('detectAgenticFamily dispatch', () => {
  it.each([
    ['moonshotai/kimi-k2', 'kimi'],
    ['moonshotai/kimi-k2.6', 'kimi'],
    ['moonshotai/kimi-k2-thinking', 'kimi'],
    // K2.7+ emits native OpenAI tool_calls (live-verified) → no markup parser.
    ['moonshotai/kimi-k2.7-code', null],
    ['moonshotai/kimi-k2.8', null],
    ['qwen/qwen3-coder', 'nodal-format'],
    ['zai/glm-4.5', 'nodal-format'],
    ['zai/glm-4.7', 'nodal-format'],
    ['anthropic/claude-sonnet-4', null],
    ['openai/gpt-4o', null],
    ['google/gemma-4-31b', null],
    ['mistral/mistral-large', null],
    // DeepSeek family is no longer special-cased — V4 Pro/Flash emit standard
    // OpenAI tool_calls; the `function.arguments` object→string spec violation
    // is handled upstream by `tolerant-fetch.ts`. R1 and chat were never wired
    // to a parser. All should return null.
    ['deepseek/deepseek-v4-pro', null],
    ['deepseek/deepseek-v4-flash', null],
    ['deepseek/deepseek-v3', null],
    ['deepseek/deepseek-v3.1', null],
    ['deepseek/deepseek-r1', null],
    ['deepseek/deepseek-chat', null],
  ])('model %s → family=%s', (modelId, expected) => {
    expect(detectAgenticFamily(modelId)).toBe(expected);
  });
});

// ─── Cross-parser independence ─────────────────────────────────────────────────

describe('parser independence', () => {
  it('kimi parser ignores Nodal/Qwen tag markup (no false positive)', () => {
    const text = '<tool_call>{"name":"x","arguments":{}}</tool_call>';
    const result = kimiNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('nodal parser ignores Kimi markup (no false positive)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>x:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>';
    const result = nodalNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
  });
});
