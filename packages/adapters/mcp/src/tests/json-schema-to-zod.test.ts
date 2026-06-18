import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod } from '../json-schema-to-zod.ts';

/** Recursively assert a serialised JSON Schema contains no `propertyNames`. */
function hasPropertyNames(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  if ('propertyNames' in (node as Record<string, unknown>)) return true;
  return Object.values(node as Record<string, unknown>).some(hasPropertyNames);
}

describe('jsonSchemaToZod', () => {
  it('converts an object schema with required + optional properties', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer' },
      },
      required: ['name'],
    });
    expect(zod.safeParse({ name: 'a', count: 3 }).success).toBe(true); // both present
    expect(zod.safeParse({ name: 'a' }).success).toBe(true); // optional omitted
    expect(zod.safeParse({ count: 3 }).success).toBe(false); // required missing
    expect(zod.safeParse({ name: 123 }).success).toBe(false); // wrong type
  });

  it('converts string / number / boolean primitives', () => {
    expect(jsonSchemaToZod({ type: 'string' }).safeParse('x').success).toBe(true);
    expect(jsonSchemaToZod({ type: 'string' }).safeParse(1).success).toBe(false);
    expect(jsonSchemaToZod({ type: 'number' }).safeParse(1.5).success).toBe(true);
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(2).success).toBe(true);
    expect(jsonSchemaToZod({ type: 'integer' }).safeParse(2.5).success).toBe(false);
    expect(jsonSchemaToZod({ type: 'boolean' }).safeParse(true).success).toBe(true);
  });

  it('converts array schemas with typed items', () => {
    const zod = jsonSchemaToZod({ type: 'array', items: { type: 'string' } });
    expect(zod.safeParse(['a', 'b']).success).toBe(true);
    expect(zod.safeParse(['a', 2]).success).toBe(false);
  });

  it('converts string enums', () => {
    const zod = jsonSchemaToZod({ type: 'string', enum: ['up', 'down'] });
    expect(zod.safeParse('up').success).toBe(true);
    expect(zod.safeParse('sideways').success).toBe(false);
  });

  it('falls back to a permissive schema for an undefined/malformed schema', () => {
    expect(jsonSchemaToZod(undefined).safeParse({ anything: 1 }).success).toBe(true);
    expect(jsonSchemaToZod('not a schema').safeParse({ x: 1 }).success).toBe(true);
  });

  it('permissive fallback PRESERVES all keys (never strips them)', () => {
    // An object schema with no `properties` is un-introspectable → permissive.
    // The MCP server re-validates, so the args must reach it intact.
    const zod = jsonSchemaToZod({ type: 'object' });
    const r = zod.safeParse({ foo: 1, bar: 'two' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual({ foo: 1, bar: 'two' });
  });

  it('permissive fallback serialises to a provider-portable JSON Schema (no propertyNames)', () => {
    // `z.record()` emits `propertyNames`, which OpenRouter→Parasail and other
    // strict grammar engines reject with a hard 502. The fallback must avoid it.
    // Top-level schemaless object (e.g. a ComfyUI `workflow` dict arg):
    expect(hasPropertyNames(z.toJSONSchema(jsonSchemaToZod({ type: 'object' })))).toBe(false);
    // Nested schemaless object inside a typed object:
    const nested = jsonSchemaToZod({
      type: 'object',
      properties: { workflow: { type: 'object' } },
      required: ['workflow'],
    });
    expect(hasPropertyNames(z.toJSONSchema(nested))).toBe(false);
    // Undefined / malformed schema also takes the permissive path:
    expect(hasPropertyNames(z.toJSONSchema(jsonSchemaToZod(undefined)))).toBe(false);
  });
});
