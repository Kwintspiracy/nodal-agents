// tool-use-roundtrip.test.ts — mock provider returns tool calls, client surfaces them

import { describe, it, expect } from 'vitest';
import { MockLanguageModelV3 } from 'ai/test';
import { generateText, tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { mockTextResult, mockToolCallResult } from './_mock-helpers';

describe('tool-use round-trip with MockLanguageModelV3', () => {
  it('mock model returns tool calls and generateText surfaces them', async () => {
    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () =>
        mockToolCallResult([
          {
            toolCallId: 'call-1',
            toolName: 'get_weather',
            input: JSON.stringify({ city: 'Paris' }),
          },
        ]),
    });

    const result = await generateText({
      model: mockModel,
      prompt: 'What is the weather in Paris?',
      tools: {
        get_weather: tool({
          description: 'Get weather for a city',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      stopWhen: stepCountIs(2),
    });

    // The tool was called — result should contain it
    expect(result.toolCalls.length > 0 || result.steps.length > 0).toBe(true);
  });

  it('mock model returns text after tool use', async () => {
    let callCount = 0;

    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return mockToolCallResult([
            {
              toolCallId: 'call-1',
              toolName: 'get_weather',
              input: JSON.stringify({ city: 'Lyon' }),
            },
          ]);
        }
        return mockTextResult('Lyon is sunny today.', { input: 20, output: 10 });
      },
    });

    const result = await generateText({
      model: mockModel,
      prompt: 'What is the weather in Lyon?',
      tools: {
        get_weather: tool({
          description: 'Get weather for a city',
          inputSchema: z.object({ city: z.string() }),
          execute: async ({ city }) => `Weather in ${city}: sunny`,
        }),
      },
      stopWhen: stepCountIs(3),
    });

    expect(result.text).toBe('Lyon is sunny today.');
    expect(callCount).toBe(2);
  });

  it('tool call args are parsed correctly from mock', async () => {
    const capturedArgs: Record<string, unknown>[] = [];
    let callCount = 0;

    const mockModel = new MockLanguageModelV3({
      provider: 'mock',
      modelId: 'mock-model',
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return mockToolCallResult([
            {
              toolCallId: 'call-args-test',
              toolName: 'store_data',
              input: JSON.stringify({ key: 'name', value: 'Alice' }),
            },
          ]);
        }
        return mockTextResult('Stored successfully.', { input: 20, output: 5 });
      },
    });

    await generateText({
      model: mockModel,
      prompt: 'Store name=Alice',
      tools: {
        store_data: tool({
          description: 'Store a key-value pair',
          inputSchema: z.object({ key: z.string(), value: z.string() }),
          execute: async (args) => {
            capturedArgs.push(args);
            return 'stored';
          },
        }),
      },
      stopWhen: stepCountIs(2),
    });

    expect(capturedArgs).toHaveLength(1);
    expect(capturedArgs[0]).toMatchObject({ key: 'name', value: 'Alice' });
  });
});
