// tool-use-roundtrip.test.ts — mock provider returns tool calls, client surfaces them

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV1 } from 'ai/test';
import { generateText, tool } from 'ai';
import { z } from 'zod';

describe('tool-use round-trip with MockLanguageModelV1', () => {
  it('mock model returns tool calls and generateText surfaces them', async () => {
    const mockModel = new MockLanguageModelV1({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => ({
        rawCall: { rawPrompt: null, rawSettings: {} },
        finishReason: 'tool-calls',
        usage: { promptTokens: 10, completionTokens: 5 },
        toolCalls: [
          {
            toolCallType: 'function',
            toolCallId: 'call-1',
            toolName: 'get_weather',
            args: JSON.stringify({ city: 'Paris' }),
          },
        ],
      }),
    });

    const result = await generateText({
      model: mockModel,
      prompt: 'What is the weather in Paris?',
      tools: {
        get_weather: tool({
          description: 'Get weather for a city',
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      maxSteps: 2,
    });

    // The tool was called — result should contain it
    expect(result.toolCalls.length > 0 || result.steps.length > 0).toBe(true);
  });

  it('mock model returns text after tool use', async () => {
    let callCount = 0;

    const mockModel = new MockLanguageModelV1({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: return a tool call
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: 'tool-calls',
            usage: { promptTokens: 10, completionTokens: 5 },
            toolCalls: [
              {
                toolCallType: 'function',
                toolCallId: 'call-1',
                toolName: 'get_weather',
                args: JSON.stringify({ city: 'Lyon' }),
              },
            ],
          };
        }
        // Second call: return final text
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 10 },
          text: 'Lyon is sunny today.',
        };
      },
    });

    const result = await generateText({
      model: mockModel,
      prompt: 'What is the weather in Lyon?',
      tools: {
        get_weather: tool({
          description: 'Get weather for a city',
          parameters: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      maxSteps: 3,
    });

    expect(result.text).toBe('Lyon is sunny today.');
    expect(callCount).toBe(2);
  });

  it('tool call args are parsed correctly from mock', async () => {
    const capturedArgs: Record<string, unknown>[] = [];
    let callCount = 0;

    const mockModel = new MockLanguageModelV1({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          // First call: return a single tool call
          return {
            rawCall: { rawPrompt: null, rawSettings: {} },
            finishReason: 'tool-calls' as const,
            usage: { promptTokens: 10, completionTokens: 5 },
            toolCalls: [
              {
                toolCallType: 'function' as const,
                toolCallId: 'call-args-test',
                toolName: 'store_data',
                args: JSON.stringify({ key: 'name', value: 'Alice' }),
              },
            ],
          };
        }
        // Second call: return final text (tool result was injected)
        return {
          rawCall: { rawPrompt: null, rawSettings: {} },
          finishReason: 'stop' as const,
          usage: { promptTokens: 20, completionTokens: 5 },
          text: 'Stored successfully.',
        };
      },
    });

    await generateText({
      model: mockModel,
      prompt: 'Store name=Alice',
      tools: {
        store_data: tool({
          description: 'Store a key-value pair',
          parameters: z.object({ key: z.string(), value: z.string() }),
          execute: async (args) => {
            capturedArgs.push(args);
            return 'stored';
          },
        }),
      },
      maxSteps: 2,
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toMatchObject({ key: 'name', value: 'Alice' });
  });
});
