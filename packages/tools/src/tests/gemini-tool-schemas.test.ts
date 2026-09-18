// gemini-tool-schemas.test.ts — les VRAIS schémas d'outils, passés par
// l'assainisseur Gemini (issue #119).
//
// Le test vit ici, et pas dans @nodal-agents/llm, parce que les schémas sont
// ici : c'est `packages/tools` qui dépend de `packages/llm`, jamais l'inverse.
// Aucun schéma n'est recopié à la main — ils sont pris au registre, comme un
// job les prend.

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { sanitizeGeminiTools } from '@nodal-agents/llm';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin/index';

/**
 * Les mots-clés que l'API Gemini refuse dans une déclaration de fonction :
 * ceux que `@ai-sdk/google` laisse tomber en recopiant le schéma champ par
 * champ pour la route native, et que la route OpenAI envoyait tels quels.
 */
const REFUSES = [
  '$schema',
  'additionalProperties',
  '$ref',
  '$defs',
  'definitions',
  'default',
  'pattern',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'propertyNames',
  'patternProperties',
  'title',
  'examples',
  'const',
];

// Les positions d'un JSON Schema : sous `properties`, les clés sont des NOMS de
// champs, pas des mots-clés — un outil qui a un paramètre nommé `pattern` ou
// `title` est parfaitement légal, et un parcours naïf l'accuse à tort (c'est
// arrivé en écrivant ce test : file_search.pattern, pptx_create.title).
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const SCHEMA_NODE_KEYS = new Set([
  'items',
  'contains',
  'not',
  'additionalProperties',
  'propertyNames',
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Les MOTS-CLÉS de schéma employés, à toute profondeur — jamais les noms. */
function schemaKeywords(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) schemaKeywords(item, out);
    return out;
  }
  if (!isPlainObject(node)) return out;
  for (const [key, value] of Object.entries(node)) {
    out.add(key);
    if (SCHEMA_MAP_KEYS.has(key) && isPlainObject(value)) {
      for (const sub of Object.values(value)) schemaKeywords(sub, out);
    } else if (SCHEMA_LIST_KEYS.has(key) && Array.isArray(value)) {
      for (const sub of value) schemaKeywords(sub, out);
    } else if (SCHEMA_NODE_KEYS.has(key)) {
      schemaKeywords(value, out);
    }
  }
  return out;
}

/**
 * `additionalProperties: false` sur chaque objet, en profondeur — la copie
 * fidèle de `addAdditionalPropertiesToJsonSchema` (@ai-sdk/provider-utils,
 * dist/index.mjs), que le SDK applique APRÈS la conversion zod. C'est ce champ,
 * ajouté par le SDK et absent du zod d'origine, qui part sur le fil.
 */
function addAdditionalPropertiesFalse(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(addAdditionalPropertiesFalse);
  if (!isPlainObject(node)) return node;

  if (
    node['type'] === 'object' ||
    (Array.isArray(node['type']) && node['type'].includes('object'))
  ) {
    node['additionalProperties'] = false;
  }
  // Une carte de nom → schéma : seules les VALEURS sont des schémas.
  for (const key of ['properties', 'definitions', '$defs']) {
    const value = node[key];
    if (!isPlainObject(value)) continue;
    for (const [name, sub] of Object.entries(value)) {
      value[name] = addAdditionalPropertiesFalse(sub);
    }
  }
  // Un schéma, ou une liste de schémas.
  for (const key of ['items', 'anyOf', 'allOf', 'oneOf']) {
    if (node[key] != null) node[key] = addAdditionalPropertiesFalse(node[key]);
  }
  return node;
}

/**
 * La conversion EXACTE de la production : `zod4Schema`
 * (@ai-sdk/provider-utils) appelle
 * `z.toJSONSchema(schema, {target:'draft-7', io:'input', reused:'inline'})`,
 * puis pose `additionalProperties:false`. C'est ce corps-là qui est parti chez
 * Google le 16/09 et qui a valu « 400 Request contains an invalid argument ».
 */
function toWireSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const json = z.toJSONSchema(schema, {
    target: 'draft-7',
    io: 'input',
    reused: 'inline',
  }) as Record<string, unknown>;
  return addAdditionalPropertiesFalse(json) as Record<string, unknown>;
}

function builtinToolsOnTheWire(): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  const registry = createToolRegistry();
  registerBuiltins(registry);
  return registry.list().map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: toWireSchema(tool.inputSchema),
    },
  }));
}

describe('les schémas des outils intégrés, pour Gemini @cap:choisir-modele/moteur', () => {
  it('le corps NON assaini porte bien ce que Gemini refuse — sinon ce test ne prouve rien', () => {
    const tools = builtinToolsOnTheWire();
    expect(tools.length).toBeGreaterThan(30);

    const keys = schemaKeywords(tools.map((t) => t.function.parameters));
    expect(keys.has('$schema')).toBe(true);
    expect(keys.has('additionalProperties')).toBe(true);
  });

  it('assainis, ils ne portent AUCUN mot-clé refusé, sur aucun outil', () => {
    const tools = builtinToolsOnTheWire();
    const sanitised = sanitizeGeminiTools(tools) as Array<{
      function: { name: string; parameters?: Record<string, unknown> };
    }>;

    const coupables: string[] = [];
    for (const tool of sanitised) {
      for (const key of schemaKeywords(tool.function.parameters)) {
        if (REFUSES.includes(key)) coupables.push(`${tool.function.name}.${key}`);
      }
    }
    expect(coupables).toEqual([]);
  });

  it('aucun outil ne part avec un objet de paramètres vide', () => {
    // « should be non-empty for OBJECT type » : un outil sans paramètre part
    // sans le champ, jamais avec `properties: {}`.
    const sanitised = sanitizeGeminiTools(builtinToolsOnTheWire()) as Array<{
      function: { name: string; parameters?: Record<string, unknown> };
    }>;

    const vides = sanitised
      .filter((t) => {
        const p = t.function.parameters;
        if (p === undefined) return false;
        const properties = p['properties'];
        return (
          p['type'] === 'object' &&
          (properties == null || Object.keys(properties as object).length === 0)
        );
      })
      .map((t) => t.function.name);
    expect(vides).toEqual([]);
  });

  it('chaque outil garde son nom, et ses paramètres requis quand il en a', () => {
    const before = builtinToolsOnTheWire();
    const after = sanitizeGeminiTools(before) as Array<{
      function: { name: string; parameters?: Record<string, unknown> };
    }>;

    expect(after.map((t) => t.function.name)).toEqual(before.map((t) => t.function.name));
    for (const [i, tool] of before.entries()) {
      const required = tool.function.parameters['required'];
      if (Array.isArray(required) && required.length > 0) {
        expect(after[i]?.function.parameters?.['required'], tool.function.name).toEqual(required);
      }
    }
  });
});
