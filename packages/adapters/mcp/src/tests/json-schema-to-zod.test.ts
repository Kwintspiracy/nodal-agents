import { describe, it, expect } from 'vitest';
import { jsonSchemaToZod } from '../json-schema-to-zod.ts';

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
});
