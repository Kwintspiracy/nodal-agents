// JSON Schema → Zod converter for MCP tool input schemas.
//
// MCP servers describe each tool's input as JSON Schema. NodalAI's
// `ToolDefinition.inputSchema` is a Zod schema — it is validated by
// `executeTool` and introspected by the Vercel AI SDK so the LLM sees the
// tool's parameters. This converts the JSON-Schema subset MCP tools actually
// use (object / string / number / boolean / array / enum, required vs
// optional). Anything unrecognised falls back to a permissive schema — the
// MCP server re-validates server-side regardless, so a loose schema never
// causes a wrong call, it only gives the LLM less precise parameter hints.
//
// No third-party converter: the maintained runtime libraries (e.g.
// @n8n/json-schema-to-zod) peer-depend on Zod 3, and NodalAI is on Zod 4.

import { z } from 'zod';

type JsonSchema = Record<string, unknown>;

/** Whole-schema fallback: an object with arbitrary keys, all values kept. */
const PERMISSIVE: z.ZodTypeAny = z.record(z.string(), z.unknown());

/**
 * Convert a JSON Schema (an MCP tool's `inputSchema`) to a Zod schema.
 * Never throws — on any unexpected shape it returns the permissive fallback.
 */
export function jsonSchemaToZod(schema: unknown): z.ZodTypeAny {
  try {
    return convert(schema);
  } catch {
    return PERMISSIVE;
  }
}

function convert(raw: unknown): z.ZodTypeAny {
  if (!raw || typeof raw !== 'object') return z.unknown();
  const schema = raw as JsonSchema;

  // Enum — string-only enums become z.enum; mixed enums stay unconstrained.
  const enumVals = schema['enum'];
  if (Array.isArray(enumVals) && enumVals.length > 0) {
    if (enumVals.every((v): v is string => typeof v === 'string')) {
      return describe(z.enum(enumVals as [string, ...string[]]), schema);
    }
    return z.unknown();
  }

  switch (schema['type']) {
    case 'string':
      return describe(z.string(), schema);
    case 'number':
      return describe(z.number(), schema);
    case 'integer':
      return describe(z.number().int(), schema);
    case 'boolean':
      return describe(z.boolean(), schema);
    case 'null':
      return z.null();
    case 'array': {
      const items = schema['items'];
      const itemSchema = items && typeof items === 'object' ? convert(items) : z.unknown();
      return describe(z.array(itemSchema), schema);
    }
    case 'object':
      return convertObject(schema);
    default:
      // No explicit type — treat as an object when it carries `properties`.
      if (schema['properties']) return convertObject(schema);
      return z.unknown();
  }
}

function convertObject(schema: JsonSchema): z.ZodTypeAny {
  const props = schema['properties'];
  if (!props || typeof props !== 'object') {
    return describe(PERMISSIVE, schema);
  }
  const requiredList = schema['required'];
  const required = new Set(
    Array.isArray(requiredList)
      ? requiredList.filter((r): r is string => typeof r === 'string')
      : [],
  );
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, propSchema] of Object.entries(props as Record<string, unknown>)) {
    const zodProp = convert(propSchema);
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return describe(z.object(shape), schema);
}

function describe(zodType: z.ZodTypeAny, schema: JsonSchema): z.ZodTypeAny {
  const desc = schema['description'];
  return typeof desc === 'string' && desc.length > 0 ? zodType.describe(desc) : zodType;
}
