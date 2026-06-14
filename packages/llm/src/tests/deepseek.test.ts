// deepseek.test.ts — unit tests for the DeepSeek native transport provider.
//
// Tests:
// 1. padDeepSeekReasoning — pure body-rewrite helper (host-agnostic).
// 2. injectDeepSeekThinking — pure body-rewrite helper.
// 3. buildDeepSeekModel — constructs a LanguageModel without throwing.
// 4. createLlmClient dispatch — 'deepseek' routes to a client with deepseek
//    capabilities from the registry.

import { describe, it, expect } from 'vitest';
import { padDeepSeekReasoning, injectDeepSeekThinking, buildDeepSeekModel } from '../providers/deepseek';
import { createLlmClient } from '../client';
import { CAPABILITY_MATRIX } from '../providers/registry';
import { ProviderConfigError } from '../errors';

// ─── padDeepSeekReasoning — pure function ─────────────────────────────────────

describe('padDeepSeekReasoning', () => {
  it('pads missing reasoning_content on assistant tool-call messages', () => {
    const body = {
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          // reasoning_content absent
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[1] as Record<string, unknown>;
    expect(assistant['reasoning_content']).toBe(' ');
  });

  it('pads empty-string reasoning_content on assistant tool-call messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          reasoning_content: '',
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[0] as Record<string, unknown>;
    expect(assistant['reasoning_content']).toBe(' ');
  });

  it('pads null reasoning_content on assistant tool-call messages', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          reasoning_content: null,
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[0] as Record<string, unknown>;
    expect(assistant['reasoning_content']).toBe(' ');
  });

  it('leaves existing (non-empty) reasoning_content unchanged', () => {
    const existing = 'I thought about this carefully...';
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'f', arguments: '{}' } }],
          reasoning_content: existing,
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[0] as Record<string, unknown>;
    expect(assistant['reasoning_content']).toBe(existing);
  });

  it('does NOT touch assistant messages with no tool_calls array', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          content: 'Just a text response.',
          reasoning_content: '',
          // No tool_calls field at all
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[0] as Record<string, unknown>;
    // No tool_calls → not a tool-call turn → must not be padded
    expect(assistant['reasoning_content']).toBe('');
  });

  it('does NOT touch assistant messages with empty tool_calls array', () => {
    const body = {
      messages: [
        {
          role: 'assistant',
          tool_calls: [], // empty — no actual tool calls
          reasoning_content: '',
        },
      ],
    };
    const result = padDeepSeekReasoning(body) as typeof body;
    const assistant = result.messages[0] as Record<string, unknown>;
    // Empty array → 0 tool calls → must not be padded
    expect(assistant['reasoning_content']).toBe('');
  });

  it('does NOT touch user messages', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }],
    };
    const orig = JSON.stringify(body);
    padDeepSeekReasoning(body);
    expect(JSON.stringify(body)).toBe(orig);
  });

  it('does NOT touch tool/tool_result messages', () => {
    const body = {
      messages: [{ role: 'tool', tool_call_id: 'tc1', content: '{"result":42}' }],
    };
    const orig = JSON.stringify(body);
    padDeepSeekReasoning(body);
    expect(JSON.stringify(body)).toBe(orig);
  });

  it('returns input unchanged for non-object bodies', () => {
    expect(padDeepSeekReasoning(null)).toBeNull();
    expect(padDeepSeekReasoning('raw string')).toBe('raw string');
    expect(padDeepSeekReasoning(42)).toBe(42);
  });

  it('handles body with no messages array', () => {
    const body = { model: 'deepseek-chat', temperature: 0.7 };
    const result = padDeepSeekReasoning(body);
    // same object reference, no messages to modify
    expect(result).toBe(body);
  });

  it('host-gate: non-deepseek hosts do not trigger the shim (tested at fetch wrapper level via pure functions)', () => {
    // The host gate is in createDeepSeekFetch (not exported). Here we verify
    // that padDeepSeekReasoning is a pure function that only mutates its input —
    // callers (createDeepSeekFetch) are responsible for host-gating invocation.
    // This test validates the pure function does NOT mutate when there are no
    // tool calls (mirroring a non-deepseek passthrough scenario).
    const body = {
      messages: [{ role: 'user', content: 'query' }],
    };
    const before = JSON.stringify(body);
    padDeepSeekReasoning(body);
    expect(JSON.stringify(body)).toBe(before);
  });
});

// ─── injectDeepSeekThinking — pure function ───────────────────────────────────

describe('injectDeepSeekThinking', () => {
  it('injects thinking:{type:"enabled"} when field is absent', () => {
    const body = { model: 'deepseek-reasoner', messages: [] };
    const result = injectDeepSeekThinking(body) as Record<string, unknown>;
    expect(result['thinking']).toEqual({ type: 'enabled' });
  });

  it('does not overwrite existing thinking field', () => {
    const body = { model: 'deepseek-reasoner', thinking: { type: 'disabled' }, messages: [] };
    const result = injectDeepSeekThinking(body) as Record<string, unknown>;
    // Caller-specified value must be preserved
    expect(result['thinking']).toEqual({ type: 'disabled' });
  });

  it('returns non-object input unchanged', () => {
    expect(injectDeepSeekThinking(null)).toBeNull();
    expect(injectDeepSeekThinking('string')).toBe('string');
  });
});

// ─── buildDeepSeekModel ───────────────────────────────────────────────────────

describe('buildDeepSeekModel', () => {
  it('constructs a LanguageModel for deepseek-chat without throwing', () => {
    const model = buildDeepSeekModel({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test-key',
    });
    // AI SDK language models expose specificationVersion
    expect(model).toBeDefined();
    expect(typeof (model as { specificationVersion?: unknown }).specificationVersion).toBe('string');
  });

  it('constructs a LanguageModel for deepseek-reasoner without throwing', () => {
    const model = buildDeepSeekModel({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      apiKey: 'sk-test-key',
    });
    expect(model).toBeDefined();
    expect(typeof (model as { specificationVersion?: unknown }).specificationVersion).toBe('string');
  });

  it('throws ProviderConfigError when apiKey is missing', () => {
    expect(() =>
      buildDeepSeekModel({
        provider: 'deepseek',
        model: 'deepseek-chat',
      }),
    ).toThrow(ProviderConfigError);
  });

  it('accepts a custom baseURL override', () => {
    const model = buildDeepSeekModel({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
      baseURL: 'https://api.deepseek.com/v1',
    });
    expect(model).toBeDefined();
  });
});

// ─── createLlmClient dispatch ─────────────────────────────────────────────────

describe('createLlmClient deepseek dispatch', () => {
  it('routes provider:deepseek to a client with deepseek capabilities', () => {
    const client = createLlmClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    expect(client.config.provider).toBe('deepseek');
    expect(client.capabilities).toEqual(CAPABILITY_MATRIX['deepseek']);
  });

  it('exposes the standard client methods', () => {
    const client = createLlmClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    expect(typeof client.generateText).toBe('function');
    expect(typeof client.streamText).toBe('function');
    expect(typeof client.generateObject).toBe('function');
  });

  it('deepseek capabilities: toolUse:true, promptCaching:false, streaming:true', () => {
    const client = createLlmClient({
      provider: 'deepseek',
      model: 'deepseek-chat',
      apiKey: 'sk-test',
    });
    expect(client.capabilities.toolUse).toBe(true);
    expect(client.capabilities.promptCaching).toBe(false);
    expect(client.capabilities.streaming).toBe(true);
  });
});
