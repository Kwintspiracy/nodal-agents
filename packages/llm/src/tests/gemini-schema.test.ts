// gemini-schema.test.ts — le sous-ensemble de JSON Schema que Gemini accepte,
// et la route OpenRouter qui l'applique (issue #119).

import { describe, it, expect } from 'vitest';
import {
  convertSchemaForGemini,
  sanitizeGeminiTools,
  isGeminiModel,
} from '../providers/gemini-schema';
import { patchOpenRouterRequestBody } from '../providers/openrouter';

/**
 * Les mots-clés que l'API Gemini refuse dans une déclaration de fonction — ceux
 * que `@ai-sdk/google` laisse tomber en recopiant le schéma champ par champ.
 * `additionalProperties` et `$schema` sont les deux que le SDK ajoute ou
 * conserve sur la route OpenAI : ce sont les suspects du 400 de l'issue.
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

// Sous `properties`, les clés sont des NOMS de champs, pas des mots-clés : un
// outil peut avoir un paramètre nommé `pattern` ou `title` sans rien enfreindre.
// Le parcours distingue donc les positions, comme le fait l'assainisseur.
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
 * La forme EXACTE que le SDK met sur le fil : `zod4Schema`
 * (@ai-sdk/provider-utils) appelle `z.toJSONSchema(schema, {target:'draft-7',
 * io:'input', reused:'inline'})` puis `addAdditionalPropertiesToJsonSchema`,
 * qui pose `additionalProperties:false` sur chaque objet, en profondeur.
 */
const REAL_TOOL_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  properties: {
    path: { type: 'string', description: 'Chemin du fichier', minLength: 1 },
    encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
    range: {
      type: 'object',
      properties: {
        from: { type: 'integer', minimum: 1 },
        to: { type: 'integer', minimum: 1 },
      },
      required: ['from'],
      additionalProperties: false,
    },
    tags: { type: 'array', items: { type: 'string', pattern: '^[a-z]+$' } },
    owner: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    mode: { type: ['string', 'null'] },
  },
  required: ['path'],
  additionalProperties: false,
};

describe('isGeminiModel @cap:choisir-modele/moteur', () => {
  it('reconnaît la famille quel que soit le préfixe de l’agrégateur', () => {
    expect(isGeminiModel('google/gemini-3.7-flash')).toBe(true);
    expect(isGeminiModel('gemini-3.5-flash')).toBe(true);
    expect(isGeminiModel('openrouter/google/gemini-3.1-pro-preview')).toBe(true);
    expect(isGeminiModel('GOOGLE/Gemini-3.7-Flash')).toBe(true);
  });

  it('ne reconnaît pas les autres familles', () => {
    expect(isGeminiModel('z-ai/glm-5.3-flash')).toBe(false);
    expect(isGeminiModel('moonshotai/kimi-k2.6')).toBe(false);
    expect(isGeminiModel('anthropic/claude-opus-5')).toBe(false);
    expect(isGeminiModel(null)).toBe(false);
    expect(isGeminiModel('')).toBe(false);
  });

  it('lit le DERNIER segment, et Gemma n’est pas Gemini', () => {
    // Chercher « /gemini » n'importe où dans la chaîne accrochait un nom de
    // fournisseur ou de dossier sans qu'aucun modèle Gemini ne soit en jeu.
    expect(isGeminiModel('google/gemma-3-27b')).toBe(false);
    expect(isGeminiModel('gemini-labs/llama-4')).toBe(false);
    expect(isGeminiModel('vendor/gemini/llama-4')).toBe(false);
    expect(isGeminiModel('google/gemini-3.7-flash')).toBe(true);
  });
});

describe('convertSchemaForGemini @cap:choisir-modele/moteur', () => {
  it('ne laisse passer AUCUN des mots-clés que Gemini refuse', () => {
    const converted = convertSchemaForGemini(REAL_TOOL_SCHEMA);
    const keys = schemaKeywords(converted);
    for (const refuse of REFUSES) {
      expect(keys.has(refuse), `${refuse} est resté dans le schéma`).toBe(false);
    }
  });

  it('garde ce qui fait le sens de l’outil', () => {
    const converted = convertSchemaForGemini(REAL_TOOL_SCHEMA) as Record<string, unknown>;
    const properties = converted['properties'] as Record<string, Record<string, unknown>>;
    expect(converted['type']).toBe('object');
    expect(converted['required']).toEqual(['path']);
    expect(properties['path']?.['type']).toBe('string');
    expect(properties['path']?.['description']).toBe('Chemin du fichier');
    expect(properties['encoding']?.['enum']).toEqual(['utf8', 'base64']);
    expect(properties['tags']?.['items']).toEqual({ type: 'string' });
    expect((properties['range']?.['properties'] as Record<string, unknown>)['from']).toEqual({
      type: 'integer',
    });
  });

  it('dit « nullable » là où le schéma disait « ou null »', () => {
    const converted = convertSchemaForGemini(REAL_TOOL_SCHEMA) as Record<string, unknown>;
    const properties = converted['properties'] as Record<string, Record<string, unknown>>;
    // anyOf[string, null] : la branche nulle disparaît, le reste est promu.
    expect(properties['owner']?.['nullable']).toBe(true);
    expect(properties['owner']?.['type']).toBe('string');
    expect(properties['owner']?.['anyOf']).toBeUndefined();
    // type: ['string','null'] : un type en tableau n'existe pas chez Gemini.
    expect(properties['mode']?.['nullable']).toBe(true);
    expect(properties['mode']?.['anyOf']).toEqual([{ type: 'string' }]);
  });

  it('un objet vide imbriqué devient un objet nu, la racine vide ne se dit pas', () => {
    // « should be non-empty for OBJECT type » : Gemini refuse `properties: {}`.
    expect(convertSchemaForGemini({ type: 'object', properties: {} }, false)).toEqual({
      type: 'object',
    });
    expect(convertSchemaForGemini({ type: 'object', properties: {} }, true)).toBeUndefined();
  });
});

describe('sanitizeGeminiTools @cap:choisir-modele/moteur', () => {
  it('assainit les paramètres de chaque outil sans toucher au reste', () => {
    const tools = [
      { type: 'function', function: { name: 'read_file', parameters: REAL_TOOL_SCHEMA } },
    ];
    const out = sanitizeGeminiTools(tools) as Array<{
      type: string;
      function: { name: string; parameters: Record<string, unknown> };
    }>;
    expect(out[0]?.type).toBe('function');
    expect(out[0]?.function.name).toBe('read_file');
    expect(schemaKeywords(out[0]?.function.parameters).has('additionalProperties')).toBe(false);
    // L'entrée n'est jamais modifiée.
    expect(REAL_TOOL_SCHEMA.additionalProperties).toBe(false);
  });

  it('un outil sans paramètre part SANS le champ, jamais avec un objet vide', () => {
    const tools = [
      {
        type: 'function',
        function: {
          name: 'list_tasks',
          parameters: { $schema: 'x', type: 'object', properties: {}, additionalProperties: false },
        },
      },
    ];
    const out = sanitizeGeminiTools(tools) as Array<{ function: Record<string, unknown> }>;
    expect('parameters' in (out[0]?.function ?? {})).toBe(false);
    expect(out[0]?.function['name']).toBe('list_tasks');
  });
});

describe('le corps envoyé à OpenRouter @cap:choisir-modele/moteur', () => {
  it('pour un modèle Gemini, les outils partent assainis', () => {
    const body = {
      model: 'google/gemini-3.7-flash',
      messages: [{ role: 'user', content: 'relis la PR' }],
      tools: [{ type: 'function', function: { name: 'read_file', parameters: REAL_TOOL_SCHEMA } }],
    };

    const patched = patchOpenRouterRequestBody(structuredClone(body)) as Record<string, unknown>;

    // Les paramètres, pas l'enveloppe de l'outil : `{type:'function',
    // function:{…}}` n'est pas un schéma, et un parcours qui partait de là ne
    // descendait jamais jusqu'aux mots-clés (trouvé PAR MUTATION en écrivant ce
    // test — il restait vert alors que l'assainisseur était débranché).
    const parameters = (patched['tools'] as Array<{ function: { parameters: unknown } }>).map(
      (t) => t.function.parameters,
    );
    const keys = schemaKeywords(parameters);
    expect(keys.has('additionalProperties')).toBe(false);
    expect(keys.has('$schema')).toBe(false);
    expect(keys.has('minimum')).toBe(false);
    // Le reste du corps est intact : on ne touche qu'aux schémas d'outils.
    expect(patched['model']).toBe('google/gemini-3.7-flash');
    expect(patched['messages']).toEqual(body.messages);
  });

  it('pour un autre modèle, le corps est rendu tel quel', () => {
    const body = {
      model: 'z-ai/glm-5.3-flash',
      tools: [{ type: 'function', function: { name: 'read_file', parameters: REAL_TOOL_SCHEMA } }],
    };

    const patched = patchOpenRouterRequestBody(structuredClone(body));

    expect(patched).toEqual(body);
  });
});
