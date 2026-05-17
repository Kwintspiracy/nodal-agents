// tool-call-middleware.test.ts — native tool-call parsers + middleware behavior
//
// Covers: per-family parser extraction (DeepSeek V3, Kimi K2, Nodal JSON),
// middleware end-to-end through generateText, APICallError recovery, dispatcher
// matrix, fail-loud on streamText.

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { wrapLanguageModel, generateText, tool, stepCountIs } from 'ai';
import { APICallError } from '@ai-sdk/provider';
import { z } from 'zod';

import {
  deepseekToolCallMiddleware,
  nodalToolCallMiddleware,
  __testing,
} from '../providers/parsers';
import { detectAgenticFamily } from '../providers/openrouter';
import { mockTextResult, mockToolCallResult } from './_mock-helpers';

const { deepseekNativeParser, kimiNativeParser, nodalNativeParser } = __testing;

// ─── DeepSeek V3 parser ────────────────────────────────────────────────────────

describe('deepseekNativeParser', () => {
  it('extracts a single tool call from DeepSeek fullwidth markup', () => {
    const text =
      'Let me check.\n' +
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n' +
      '```json\n{"city": "Paris"}\n```\n' +
      '<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = deepseekNativeParser(text);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('get_weather');
    expect(JSON.parse(result.toolCalls[0]!.input)).toEqual({ city: 'Paris' });
    expect(result.toolCalls[0]?.type).toBe('tool-call');
    expect(result.toolCalls[0]?.toolCallId).toMatch(/^call_[a-f0-9]{16}$/);
    expect(result.text).toBe('Let me check.');
  });

  it('extracts multiple tool calls in one response', () => {
    const text =
      '<｜tool▁calls▁begin｜>' +
      '<｜tool▁call▁begin｜>function<｜tool▁sep｜>fn_a\n```json\n{}\n```\n<｜tool▁call▁end｜>' +
      '<｜tool▁call▁begin｜>function<｜tool▁sep｜>fn_b\n```json\n{"x":1}\n```\n<｜tool▁call▁end｜>' +
      '<｜tool▁calls▁end｜>';
    const result = deepseekNativeParser(text);
    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]?.toolName).toBe('fn_a');
    expect(result.toolCalls[1]?.toolName).toBe('fn_b');
    expect(JSON.parse(result.toolCalls[1]!.input)).toEqual({ x: 1 });
  });

  it('returns text unchanged when no DeepSeek start token present', () => {
    const text = 'just a plain assistant reply';
    const result = deepseekNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.text).toBe(text);
  });

  it('handles arbitrary whitespace around the JSON block', () => {
    const text =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>multi   \n' +
      '```json\n   {\n  "a": 1\n}   \n```   \n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = deepseekNativeParser(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]?.toolName).toBe('multi');
  });
});

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
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
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
      modelId: 'mock-deepseek',
      doGenerate: async () =>
        mockTextResult(
          '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>get_weather\n' +
            '```json\n{"city":"Marseille"}\n```\n' +
            '<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
        ),
    });

    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: deepseekToolCallMiddleware,
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
      modelId: 'mock-deepseek',
      doGenerate: async (params) => {
        // V3CallOptions: tools is at the top level (no more params.mode.type/tools)
        observedToolsPresent = (params.tools?.length ?? 0) > 0;
        const sys = params.prompt[0];
        if (sys && sys.role === 'system' && typeof sys.content === 'string') {
          observedPromptHadAddendum =
            sys.content.includes('Tool calling format') ||
            sys.content.includes('<tool_call>') ||
            sys.content.includes('<｜tool▁call▁begin｜>');
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
      modelId: 'mock-deepseek',
      doGenerate: async () => mockTextResult('plain reply no markup'),
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: deepseekToolCallMiddleware,
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
  it('recovers from APICallError("Invalid JSON response") by parsing responseBody', async () => {
    const recoveredBody = JSON.stringify({
      id: 'resp-1',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content:
              '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>do_thing\n' +
              '```json\n{"arg":42}\n```\n' +
              '<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
          },
        },
      ],
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    });

    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
    });

    const result = await generateText({
      model: wrapped,
      prompt: 'do something',
      tools: {
        do_thing: tool({
          description: 'do',
          inputSchema: z.object({ arg: z.number() }),
          execute: async ({ arg }) => `did ${arg}`,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    const firstStep = result.steps[0];
    expect(firstStep?.toolCalls).toHaveLength(1);
    expect(firstStep?.toolCalls[0]?.toolName).toBe('do_thing');
    // AI SDK level exposes args already parsed (object) — not a JSON string
    expect(firstStep!.toolCalls[0]!.input).toEqual({ arg: 42 });
  });

  it('recovers from APICallError when body has standard OpenAI tool_calls + DeepSeek reasoning_content extras', async () => {
    // Live failure pattern (job 57ff323d, 2026-05-17): DeepSeek V4 Pro emits
    // tool_calls in OpenAI standard format alongside reasoning_content. AI SDK
    // openai-compatible Zod schema rejects the extras → "Invalid JSON response".
    // The recovery path must extract the standard tool_calls and ignore extras.
    const recoveredBody = JSON.stringify({
      id: 'resp-ds',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: '', // empty — actual answer is in tool_calls
            // DeepSeek-specific extra that breaks AI SDK strict schema
            reasoning_content: 'Let me think about this. I should call do_thing.',
            tool_calls: [
              {
                id: 'chatcmpl-tool-abc123',
                type: 'function',
                function: { name: 'do_thing', arguments: '{"arg":7}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 50, completion_tokens: 12 },
    });

    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
    });

    const result = await generateText({
      model: wrapped,
      prompt: 'do something',
      tools: {
        do_thing: tool({
          description: 'do',
          inputSchema: z.object({ arg: z.number() }),
          execute: async ({ arg }) => `did ${arg}`,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    const firstStep = result.steps[0];
    expect(firstStep?.toolCalls).toHaveLength(1);
    expect(firstStep?.toolCalls[0]?.toolName).toBe('do_thing');
    expect(firstStep!.toolCalls[0]!.input).toEqual({ arg: 7 });
    // Preserves the original OpenAI tool_call id (used by Telegram-style providers
    // that echo it back in tool_result messages)
    expect(firstStep!.toolCalls[0]!.toolCallId).toBe('chatcmpl-tool-abc123');
  });

  it('recovers OpenAI tool_calls even when arguments is an already-parsed object', async () => {
    // Some providers return parsed JSON in arguments instead of a string.
    const recoveredBody = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tc-1',
                type: 'function',
                function: { name: 'do_thing', arguments: { arg: 99 } },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
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
    expect(result.steps[0]?.toolCalls[0]?.input).toEqual({ arg: 99 });
  });

  it('falls back to native markup parser when no OpenAI tool_calls present in body', async () => {
    // When the body carries DeepSeek native markup in `content` (and no
    // OpenAI tool_calls), the existing parser path must still kick in.
    const recoveredBody = JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content:
              '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>do_thing\n' +
              '```json\n{"arg":1}\n```\n' +
              '<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
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
    expect(result.steps[0]?.toolCalls[0]?.input).toEqual({ arg: 1 });
  });

  it('re-throws APICallError when responseBody has no native markup', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
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
      middleware: deepseekToolCallMiddleware,
    });
    await expect(
      generateText({ model: wrapped, prompt: 'x', stopWhen: stepCountIs(1) }),
    ).rejects.toThrow(/Invalid JSON response/);
  });

  it('re-throws non-APICallError errors (no silent fallback)', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-deepseek',
      doGenerate: async () => {
        throw new Error('network timeout');
      },
    });
    const wrapped = wrapLanguageModel({
      model: mockModel,
      middleware: deepseekToolCallMiddleware,
    });
    await expect(
      generateText({ model: wrapped, prompt: 'x', stopWhen: stepCountIs(1) }),
    ).rejects.toThrow(/network timeout/);
  });

  it('wrapStream throws UnsupportedFunctionalityError (no silent fallback)', async () => {
    expect(deepseekToolCallMiddleware.wrapStream).toBeDefined();
    await expect(
      deepseekToolCallMiddleware.wrapStream!({
        doStream: () => {
          throw new Error('should not reach doStream');
        },
        doGenerate: () => {
          throw new Error('should not reach doGenerate');
        },
        params: {} as unknown as Parameters<
          NonNullable<typeof deepseekToolCallMiddleware.wrapStream>
        >[0]['params'],
        model: {} as unknown as Parameters<
          NonNullable<typeof deepseekToolCallMiddleware.wrapStream>
        >[0]['model'],
      }),
    ).rejects.toThrow(/text-based tool-call parsing/i);
  });
});

// ─── OpenRouter dispatcher matrix ─────────────────────────────────────────────

describe('detectAgenticFamily dispatch', () => {
  it.each([
    ['deepseek/deepseek-v4-pro', 'deepseek'],
    ['deepseek/deepseek-v4-flash', 'deepseek'],
    ['deepseek/deepseek-v3', 'deepseek'],
    ['deepseek/deepseek-v3.1', 'deepseek'],
    ['moonshotai/kimi-k2', 'kimi'],
    ['moonshotai/kimi-k2.6', 'kimi'],
    ['moonshotai/kimi-k2-thinking', 'kimi'],
    ['qwen/qwen3-coder', 'nodal-format'],
    ['zai/glm-4.5', 'nodal-format'],
    ['zai/glm-4.7', 'nodal-format'],
    ['anthropic/claude-sonnet-4', null],
    ['openai/gpt-4o', null],
    ['google/gemma-4-31b', null],
    ['mistral/mistral-large', null],
    ['deepseek/deepseek-r1', null], // R1 is reasoning, not agentic-OSS tool-call family
    ['deepseek/deepseek-chat', null], // legacy chat, no native tool-call markup
  ])('model %s → family=%s', (modelId, expected) => {
    expect(detectAgenticFamily(modelId)).toBe(expected);
  });
});

// ─── Cross-parser independence ─────────────────────────────────────────────────

describe('parser independence', () => {
  it('kimi parser ignores DeepSeek markup (no false positive)', () => {
    const text =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n```json\n{}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const result = kimiNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('deepseek parser ignores Kimi markup (no false positive)', () => {
    const text =
      '<|tool_calls_section_begin|><|tool_call_begin|>x:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>';
    const result = deepseekNativeParser(text);
    expect(result.toolCalls).toHaveLength(0);
  });

  it('nodal parser ignores DeepSeek and Kimi markup', () => {
    const dsText =
      '<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>x\n```json\n{}\n```\n<｜tool▁call▁end｜><｜tool▁calls▁end｜>';
    const kimiText =
      '<|tool_calls_section_begin|><|tool_call_begin|>x:0<|tool_call_argument_begin|>{}<|tool_call_end|><|tool_calls_section_end|>';
    expect(nodalNativeParser(dsText).toolCalls).toHaveLength(0);
    expect(nodalNativeParser(kimiText).toolCalls).toHaveLength(0);
  });
});
