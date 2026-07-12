// moonshot-schema.ts — normalises tool JSON Schemas to the strict subset
// Moonshot (Kimi) accepts. TS port of Hermes' `agent/moonshot_schema.py`.
//
// Moonshot rejects requests whose `tools[].function.parameters` use standard
// JSON Schema features it doesn't parse, with:
//   "tools.function.parameters is not a valid moonshot flavored json schema"
//
// Known rejection modes (see
// https://forum.moonshot.ai/t/tool-calling-specification-violation-on-moonshot-api/102
// and MoonshotAI/kimi-cli#1595), each repaired here:
//   1. Every property schema must carry a `type` — standard JSON Schema allows
//      it to be omitted (unconstrained); Moonshot refuses. Inferred from
//      `properties`/`items`/`enum` when absent, else `string`.
//   2. `anyOf` branches must each carry their own `type` — a `type` on the
//      parent alongside `anyOf` is rejected. Additionally Moonshot rejects a
//      `{type:'null'}` branch inside `anyOf` — those are dropped; a single
//      remaining branch is promoted (its shape merged into the parent).
//   3. `enum` arrays reject `null`/empty-string entries when the schema's own
//      `type` is a scalar — those values are stripped (enum dropped entirely
//      if nothing survives).
//   4. The non-standard `nullable` keyword is rejected — stripped.
//
// This module is transport-agnostic (no fetch/host logic) so it can be reused
// by both the native moonshot.ts provider AND the OpenRouter path for any
// Kimi model routed through an aggregator.

type JsonSchemaNode = Record<string, unknown>;

// Keys whose values are maps of name → schema (not schemas themselves).
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
// Keys whose values are lists of schemas.
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
// Keys whose values are a single nested schema.
const SCHEMA_NODE_KEYS = new Set([
  'items',
  'contains',
  'not',
  'additionalProperties',
  'propertyNames',
]);

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Infer a reasonable `type` for a schema node that has none. */
function fillMissingType(node: JsonSchemaNode): JsonSchemaNode {
  const nodeType = node['type'];
  if (Array.isArray(nodeType)) {
    const concrete = nodeType.find((t) => typeof t === 'string' && t !== '' && t !== 'null');
    return { ...node, type: concrete ?? 'string' };
  }
  if ('type' in node && nodeType !== undefined && nodeType !== null && nodeType !== '') {
    return node;
  }

  let inferred: string;
  if ('properties' in node || 'required' in node || 'additionalProperties' in node) {
    inferred = 'object';
  } else if ('items' in node || 'prefixItems' in node) {
    inferred = 'array';
  } else if (Array.isArray(node['enum']) && (node['enum'] as unknown[]).length > 0) {
    const sample = (node['enum'] as unknown[])[0];
    if (typeof sample === 'boolean') inferred = 'boolean';
    else if (typeof sample === 'number') inferred = Number.isInteger(sample) ? 'integer' : 'number';
    else inferred = 'string';
  } else {
    inferred = 'string';
  }
  return { ...node, type: inferred };
}

/** Rules 3 (enum null/empty cleanup) + 4 (nullable strip) + 1 (fill type). */
function finalizeSchemaNode(node: JsonSchemaNode): JsonSchemaNode {
  const { nullable: _nullable, ...withoutNullable } = node;
  let out = withoutNullable;

  // $ref nodes are exempt from type-filling — their type comes from the
  // referenced definition.
  if (!('$ref' in out)) {
    out = fillMissingType(out);
  }

  if (Array.isArray(out['enum'])) {
    const nodeType = out['type'];
    if (
      nodeType === 'string' ||
      nodeType === 'integer' ||
      nodeType === 'number' ||
      nodeType === 'boolean'
    ) {
      const cleaned = (out['enum'] as unknown[]).filter((v) => v !== null && v !== '');
      if (cleaned.length > 0) {
        out = { ...out, enum: cleaned };
      } else {
        const { enum: _enum, ...rest } = out;
        out = rest;
      }
    }
  }

  return out;
}

/**
 * Recursively repair a schema node. `isSchema=false` marks a container map
 * (e.g. the value of `properties`) whose own keys are names, not schema
 * keywords — only its values get schema treatment.
 */
function repairSchema(node: unknown, isSchema: boolean): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => repairSchema(item, true));
  }
  if (!isPlainObject(node)) return node;

  const repaired: JsonSchemaNode = {};
  for (const [key, value] of Object.entries(node)) {
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      const mapped: JsonSchemaNode = {};
      for (const [subKey, subVal] of Object.entries(value)) {
        mapped[subKey] = repairSchema(subVal, true);
      }
      repaired[key] = mapped;
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      repaired[key] = value.map((v) => repairSchema(v, true));
    } else if (SCHEMA_NODE_KEYS.has(key)) {
      // additionalProperties/propertyNames may be a bare boolean — leave as-is.
      repaired[key] = isPlainObject(value) ? repairSchema(value, true) : value;
    } else {
      repaired[key] = value;
    }
  }

  if (!isSchema) return repaired;

  // Rule 2: anyOf — type belongs on the children, not the parent; drop
  // null-type branches (collapsing to a single merged schema when only one
  // non-null branch remains).
  const anyOf = repaired['anyOf'];
  if (Array.isArray(anyOf)) {
    delete repaired['type'];
    const nonNull = anyOf.filter((b) => isPlainObject(b) && b['type'] !== 'null');
    if (nonNull.length > 0 && nonNull.length < anyOf.length) {
      if (nonNull.length === 1) {
        const merged: JsonSchemaNode = {};
        for (const [k, v] of Object.entries(repaired)) {
          if (k !== 'anyOf') merged[k] = v;
        }
        Object.assign(merged, nonNull[0] as JsonSchemaNode);
        return finalizeSchemaNode(merged);
      }
      repaired['anyOf'] = nonNull;
      return repaired;
    }
    // Nothing to collapse (all-null or none-null) — children already
    // repaired above; parent type already stripped.
    return repaired;
  }

  return finalizeSchemaNode(repaired);
}

/**
 * Normalize a single tool's `function.parameters` schema to Moonshot's
 * accepted subset. Returns a deep, repaired copy — input is never mutated.
 */
export function sanitizeMoonshotToolParameters(parameters: unknown): Record<string, unknown> {
  if (!isPlainObject(parameters)) return { type: 'object', properties: {} };

  const repaired = repairSchema(structuredClone(parameters), true);
  if (!isPlainObject(repaired)) return { type: 'object', properties: {} };

  const out: JsonSchemaNode = { ...repaired };
  if (out['type'] !== 'object') out['type'] = 'object';
  if (!('properties' in out)) out['properties'] = {};
  return out;
}

/**
 * Apply `sanitizeMoonshotToolParameters` to every tool's `function.parameters`
 * in an OpenAI-shaped `tools` array (`{type:'function', function:{name,
 * parameters}}`). Tools with no recognisable `function.parameters` shape pass
 * through unchanged. Returns the input unchanged when it isn't a non-empty
 * array (nothing to sanitize).
 */
export function sanitizeMoonshotTools(tools: unknown): unknown {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  return tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const fn = tool['function'];
    if (!isPlainObject(fn)) return tool;
    const parameters = sanitizeMoonshotToolParameters(fn['parameters']);
    return { ...tool, function: { ...fn, parameters } };
  });
}

/**
 * True for any Kimi/Moonshot model slug, regardless of aggregator prefix.
 * Matches bare names (`kimi-k2.6`, `moonshotai/Kimi-K2.6`) and
 * aggregator-prefixed slugs (`nous/moonshotai/kimi-k2.6`,
 * `openrouter/moonshotai/...`). Detection by model NAME (not host) covers
 * OpenRouter and other aggregators that route to Moonshot's inference, where
 * the base URL is the aggregator's, not api.moonshot.ai.
 */
export function isMoonshotModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const bare = modelId.trim().toLowerCase();
  if (!bare) return false;
  const tail = bare.includes('/') ? (bare.split('/').pop() ?? '') : bare;
  if (tail.startsWith('kimi-') || tail === 'kimi') return true;
  if (bare.includes('moonshot') || bare.includes('/kimi') || bare.startsWith('kimi')) return true;
  return false;
}
