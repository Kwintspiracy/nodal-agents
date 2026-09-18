// gemini-schema.ts — ramène les schémas d'outils au sous-ensemble que la
// fonction-calling de Gemini accepte (issue #119).
//
// Ce qui a été observé le 16/09/2026 : un agent de 43 outils sur
// `google/gemini-3.7-flash` via OpenRouter (fournisseur amont Google AI Studio)
// meurt au tour 1 sur « 400 Request contains an invalid argument », sans un
// outil exécuté. Le même travail passe sur un autre modèle.
//
// Pourquoi la route native, elle, marche — VÉRIFIÉ en lisant le SDK, pas
// supposé : `@ai-sdk/google` (dist/index.mjs, `convertJSONSchemaToOpenAPISchema`)
// ne transmet PAS le JSON Schema tel quel. Il le RECOPIE CHAMP PAR CHAMP dans
// le schéma OpenAPI que l'API Gemini attend, et tout ce qui n'est pas dans sa
// liste — `$schema`, `additionalProperties`, `$ref`, `default`, `pattern`,
// `maxLength`… — disparaît en chemin. La route OpenRouter parle le protocole
// OpenAI : elle envoie le schéma brut, le relais le passe à Google, et Google
// refuse. Il n'y a donc jamais eu d'assainisseur Gemini dans ce dépôt ; celui
// qui manquait était celui de l'autre route.
//
// Ce module PORTE les règles du SDK, il n'en invente pas : mêmes champs gardés,
// même traitement de l'objet vide, des types en tableau et du `anyOf` nullable.
// C'est l'implémentation dont on sait qu'elle passe en production sur la route
// native ; s'en écarter serait deviner.
//
// Transport-agnostique (aucune logique de fetch ni d'hôte), comme
// `moonshot-schema.ts` : la règle porte sur la FAMILLE DE MODÈLE, pas sur le
// fournisseur qui relaie — Gemini refuse le même corps quel que soit le chemin.

type JsonSchemaNode = Record<string, unknown>;

/**
 * Les champs que le SDK natif recopie, et EUX SEULS. Tout le reste est laissé
 * de côté : c'est une liste blanche, pas une liste d'interdits — un mot-clé
 * JSON Schema apparu demain sera écarté sans que personne ait à y penser.
 */
const KEPT_KEYS = [
  'description',
  'required',
  'format',
  'type',
  'enum',
  'properties',
  'items',
  'allOf',
  'anyOf',
  'oneOf',
  'minLength',
] as const;

function isPlainObject(value: unknown): value is JsonSchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Un objet sans propriété : Gemini refuse `type: "object"` avec des
 * `properties` vides (« should be non-empty for OBJECT type »). Même lecture
 * que `isEmptyObjectSchema` du SDK.
 */
function isEmptyObjectSchema(node: unknown): boolean {
  return (
    isPlainObject(node) &&
    node['type'] === 'object' &&
    (node['properties'] == null || Object.keys(node['properties'] as object).length === 0) &&
    !node['additionalProperties']
  );
}

/**
 * Convertit un nœud JSON Schema en schéma acceptable par Gemini.
 *
 * `undefined` en retour veut dire « ce schéma ne se dit pas » : à la racine,
 * c'est un objet vide, et l'appelant doit alors RETIRER `parameters` au lieu
 * d'envoyer un objet sans propriété — exactement ce que fait le SDK natif.
 */
export function convertSchemaForGemini(node: unknown, isRoot = true): unknown {
  if (node == null) return undefined;

  if (isEmptyObjectSchema(node)) {
    if (isRoot) return undefined;
    const description = isPlainObject(node) ? node['description'] : undefined;
    return typeof description === 'string' && description !== ''
      ? { type: 'object', description }
      : { type: 'object' };
  }

  if (typeof node === 'boolean') return { type: 'boolean', properties: {} };
  if (!isPlainObject(node)) return undefined;

  const out: JsonSchemaNode = {};
  if (typeof node['description'] === 'string' && node['description'] !== '') {
    out['description'] = node['description'];
  }
  if (node['required'] !== undefined) out['required'] = node['required'];
  // `format` est recopié TEL QUEL, comme le fait le SDK sur la route native.
  // Risque résiduel assumé, et nommé : zod émet des formats que Gemini ne
  // documente pas (`z.string().url()` → `format: 'uri'`, vu sur
  // `packages/tools/src/builtin/create-mcp.ts`). S'il devait en refuser un, la
  // route native le ferait refuser de la même façon : cette copie EST la
  // spécification, et s'en écarter ici serait inventer une règle que rien ne
  // vérifie (revue passe 1 de la PR #180).
  if (node['format'] !== undefined) out['format'] = node['format'];
  // `const` n'existe pas chez Gemini : il se dit comme un `enum` d'une valeur.
  if (node['const'] !== undefined) out['enum'] = [node['const']];

  const type = node['type'];
  if (type !== undefined && type !== null) {
    if (Array.isArray(type)) {
      // Un type en tableau (`['string','null']`) n'existe pas non plus : il
      // devient un `anyOf` de types, et le `null` devient `nullable`.
      const nonNull = type.filter((t) => t !== 'null');
      if (nonNull.length === 0) {
        out['type'] = 'null';
      } else {
        out['anyOf'] = nonNull.map((t) => ({ type: t }));
        if (type.includes('null')) out['nullable'] = true;
      }
    } else {
      out['type'] = type;
    }
  }

  if (node['enum'] !== undefined) out['enum'] = node['enum'];

  const properties = node['properties'];
  if (isPlainObject(properties)) {
    const converted: JsonSchemaNode = {};
    for (const [key, value] of Object.entries(properties)) {
      converted[key] = convertSchemaForGemini(value, false);
    }
    out['properties'] = converted;
  }

  const items = node['items'];
  if (items !== undefined && items !== null) {
    out['items'] = Array.isArray(items)
      ? items.map((item) => convertSchemaForGemini(item, false))
      : convertSchemaForGemini(items, false);
  }

  const allOf = node['allOf'];
  if (Array.isArray(allOf)) out['allOf'] = allOf.map((i) => convertSchemaForGemini(i, false));

  const anyOf = node['anyOf'];
  if (Array.isArray(anyOf)) {
    const isNullBranch = (s: unknown): boolean => isPlainObject(s) && s['type'] === 'null';
    if (anyOf.some(isNullBranch)) {
      const nonNull = anyOf.filter((s) => !isNullBranch(s));
      if (nonNull.length === 1) {
        // Une seule branche reste : elle prend la place du `anyOf`, et le
        // `null` devient `nullable` — la forme que Gemini comprend.
        const converted = convertSchemaForGemini(nonNull[0], false);
        if (isPlainObject(converted)) {
          out['nullable'] = true;
          Object.assign(out, converted);
        }
      } else {
        out['anyOf'] = nonNull.map((i) => convertSchemaForGemini(i, false));
        out['nullable'] = true;
      }
    } else {
      out['anyOf'] = anyOf.map((i) => convertSchemaForGemini(i, false));
    }
  }

  const oneOf = node['oneOf'];
  if (Array.isArray(oneOf)) out['oneOf'] = oneOf.map((i) => convertSchemaForGemini(i, false));

  if (node['minLength'] !== undefined) out['minLength'] = node['minLength'];

  return out;
}

/** Les champs gardés, pour les tests et pour qui lit ce module. */
export const GEMINI_KEPT_SCHEMA_KEYS: readonly string[] = KEPT_KEYS;

/**
 * Assainit les schémas d'outils d'un corps de requête de forme OpenAI
 * (`[{type:'function', function:{name, parameters}}]`).
 *
 * Un outil dont les paramètres se réduisent à un objet vide part SANS
 * `parameters` : c'est licite côté OpenAI, et c'est ce que fait la route native
 * (le SDK rend `undefined` et n'écrit rien). Envoyer `{type:'object',
 * properties:{}}` serait précisément le refus « should be non-empty ».
 *
 * Rien n'est muté : la sortie est une copie.
 */
export function sanitizeGeminiTools(tools: unknown): unknown {
  if (!Array.isArray(tools) || tools.length === 0) return tools;

  return tools.map((tool) => {
    if (!isPlainObject(tool)) return tool;
    const fn = tool['function'];
    if (!isPlainObject(fn)) return tool;
    if (!('parameters' in fn)) return tool;

    const converted = convertSchemaForGemini(fn['parameters'], true);
    if (converted === undefined) {
      const { parameters: _dropped, ...withoutParameters } = fn;
      return { ...tool, function: withoutParameters };
    }
    return { ...tool, function: { ...fn, parameters: converted } };
  });
}

/**
 * Vrai pour un modèle de la famille Gemini, quel que soit le préfixe de
 * l'agrégateur : `gemini-3.5-flash`, `google/gemini-3.7-flash`,
 * `openrouter/google/gemini-…`. La détection est par NOM DE MODÈLE et non par
 * hôte — OpenRouter est un hôte unique pour toutes les familles, et c'est bien
 * l'inférence Gemini qui refuse le schéma, où qu'elle soit relayée.
 *
 * Le DERNIER segment, et lui seul : chercher « /gemini » n'importe où dans la
 * chaîne accrocherait un préfixe d'agrégateur ou un dossier qui porte ce nom
 * sans qu'aucun modèle Gemini ne soit en jeu (revue passe 1 de la PR #180).
 * `gemma-…` reste dehors, comme il doit : ce n'est pas la même inférence.
 */
export function isGeminiModel(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  const bare = modelId.trim().toLowerCase();
  if (!bare) return false;
  const tail = bare.includes('/') ? (bare.split('/').pop() ?? '') : bare;
  return tail.startsWith('gemini-');
}
