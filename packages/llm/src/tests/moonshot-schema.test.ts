// moonshot-schema.test.ts — unit tests for the Moonshot flavored-JSON-Schema
// sanitizer. Fixtures mirror the cases Hermes' `agent/moonshot_schema.py`
// covers (missing type, anyOf with a null branch, enum with null/empty).

import { describe, it, expect } from 'vitest';
import {
  sanitizeMoonshotToolParameters,
  sanitizeMoonshotTools,
  isMoonshotModel,
} from '../providers/moonshot-schema';

// ─── sanitizeMoonshotToolParameters ───────────────────────────────────────────

describe('sanitizeMoonshotToolParameters', () => {
  it('fills a missing type on a property from its properties/items/enum shape', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        // no `type` at all — must be inferred as 'object' from `properties`
        nested: { properties: { x: { type: 'string' } } },
        // no `type` — inferred as 'array' from `items`
        list: { items: { type: 'string' } },
        // no `type` — inferred from first enum value
        status: { enum: ['active', 'archived'] },
        // no `type`, no hints — falls back to 'string'
        freeform: { description: 'anything' },
      },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['nested']?.['type']).toBe('object');
    expect(props['list']?.['type']).toBe('array');
    expect(props['status']?.['type']).toBe('string');
    expect(props['freeform']?.['type']).toBe('string');
  });

  it('moves type off the anyOf parent onto surviving children, dropping null branches', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        maybeCity: {
          anyOf: [{ type: 'string' }, { type: 'null' }],
        },
      },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    // Single non-null branch collapses — merged into the parent, no anyOf left.
    expect(props['maybeCity']).toEqual({ type: 'string' });
  });

  it('keeps multiple non-null anyOf branches (no type promoted to the parent)', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        val: { anyOf: [{ type: 'string' }, { type: 'integer' }, { type: 'null' }] },
      },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['val']).toEqual({ anyOf: [{ type: 'string' }, { type: 'integer' }] });
    expect(props['val']?.['type']).toBeUndefined();
  });

  it('strips null and empty-string values from a scalar-typed enum', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        color: { type: 'string', enum: ['red', null, '', 'blue'] },
      },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['color']?.['enum']).toEqual(['red', 'blue']);
  });

  it('drops the enum entirely when nothing survives the cleanup', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        color: { type: 'string', enum: [null, ''] },
      },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['color']).not.toHaveProperty('enum');
  });

  it('strips the non-standard `nullable` keyword', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: { x: { type: 'string', nullable: true } },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['x']).not.toHaveProperty('nullable');
  });

  it('exempts $ref nodes from type-filling', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: { x: { $ref: '#/$defs/Thing' } },
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['x']).toEqual({ $ref: '#/$defs/Thing' });
  });

  it('a realistic MCP-shaped schema comes out fully repaired', () => {
    const out = sanitizeMoonshotToolParameters({
      type: 'object',
      properties: {
        city: { anyOf: [{ type: 'string' }, { type: 'null' }], description: 'the city' },
        units: { type: 'string', enum: ['metric', 'imperial', null] },
        forecast: { properties: { days: { type: 'integer' } } },
      },
      required: ['city'],
    });
    const props = out['properties'] as Record<string, Record<string, unknown>>;
    expect(props['city']).toEqual({ type: 'string', description: 'the city' });
    expect(props['units']).toEqual({ type: 'string', enum: ['metric', 'imperial'] });
    expect(props['forecast']?.['type']).toBe('object');
    expect(out['type']).toBe('object');
  });

  it('defaults to an empty object schema for non-object input', () => {
    expect(sanitizeMoonshotToolParameters(null)).toEqual({ type: 'object', properties: {} });
    expect(sanitizeMoonshotToolParameters('nope')).toEqual({ type: 'object', properties: {} });
    expect(sanitizeMoonshotToolParameters(undefined)).toEqual({ type: 'object', properties: {} });
  });

  it('forces the top-level type to object and adds empty properties if absent', () => {
    const out = sanitizeMoonshotToolParameters({ type: 'string' });
    expect(out['type']).toBe('object');
    expect(out['properties']).toEqual({});
  });

  it('does not mutate the input', () => {
    const input = { type: 'object', properties: { x: { enum: [null, 'a'] } } };
    const before = JSON.stringify(input);
    sanitizeMoonshotToolParameters(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

// ─── sanitizeMoonshotTools ─────────────────────────────────────────────────────

describe('sanitizeMoonshotTools', () => {
  it('sanitizes function.parameters for every tool in the array', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          parameters: { properties: { city: { enum: ['Paris', null] } } },
        },
      },
    ];
    const out = sanitizeMoonshotTools(tools) as typeof tools;
    const params = out[0]?.function.parameters as Record<string, unknown>;
    expect(params['type']).toBe('object');
    const props = params['properties'] as Record<string, Record<string, unknown>>;
    expect(props['city']).toEqual({ type: 'string', enum: ['Paris'] });
  });

  it('passes through non-function tools and malformed entries untouched', () => {
    const tools = [{ notATool: true }, { type: 'function' /* no function.parameters shape */ }];
    expect(sanitizeMoonshotTools(tools)).toEqual(tools);
  });

  it('returns the input unchanged for empty/non-array input', () => {
    expect(sanitizeMoonshotTools([])).toEqual([]);
    expect(sanitizeMoonshotTools(undefined)).toBeUndefined();
    expect(sanitizeMoonshotTools('not-an-array')).toBe('not-an-array');
  });
});

// ─── isMoonshotModel ───────────────────────────────────────────────────────────

describe('isMoonshotModel', () => {
  it('matches bare Kimi model ids', () => {
    expect(isMoonshotModel('kimi-k2.6')).toBe(true);
    expect(isMoonshotModel('kimi-k2.7-code')).toBe(true);
    expect(isMoonshotModel('Kimi-K2.6')).toBe(true); // case-insensitive
  });

  it('matches OpenRouter-namespaced Kimi slugs', () => {
    expect(isMoonshotModel('moonshotai/kimi-k2.6')).toBe(true);
    expect(isMoonshotModel('moonshotai/Kimi-K2.7-code')).toBe(true);
  });

  it('matches aggregator-prefixed slugs', () => {
    expect(isMoonshotModel('nous/moonshotai/kimi-k2.6')).toBe(true);
    expect(isMoonshotModel('openrouter/moonshotai/kimi-k2.6')).toBe(true);
  });

  it('returns false for non-Kimi models', () => {
    expect(isMoonshotModel('anthropic/claude-sonnet-4.6')).toBe(false);
    expect(isMoonshotModel('deepseek/deepseek-v4-pro')).toBe(false);
    expect(isMoonshotModel('minimax/minimax-m3')).toBe(false);
    expect(isMoonshotModel('z-ai/glm-5.2')).toBe(false);
  });

  it('returns false for empty/null/undefined', () => {
    expect(isMoonshotModel('')).toBe(false);
    expect(isMoonshotModel(null)).toBe(false);
    expect(isMoonshotModel(undefined)).toBe(false);
    expect(isMoonshotModel('   ')).toBe(false);
  });
});
