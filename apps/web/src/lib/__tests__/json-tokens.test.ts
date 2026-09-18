// json-tokens.test.ts — ce que le découpage NOMME, jeton par jeton.
//
// Les assertions portent sur la suite rendue, pas sur un compte : une clé mal
// nommée `string` passerait un test qui compte les jetons, et repeindrait la
// moitié du bloc.

import { describe, it, expect } from 'vitest';
import { tokenizeJson, prettyJson, PRETTY_JSON_MAX_CHARS, type JsonToken } from '../json-tokens';

/** Les jetons qui portent une couleur — les blancs ne disent rien. */
const meaty = (tokens: JsonToken[]): JsonToken[] => tokens.filter((t) => t.kind !== 'space');

describe('tokenizeJson', () => {
  it('rend la suite EXACTE des jetons, blancs compris', () => {
    expect(tokenizeJson('{\n  "limit": 10\n}')).toEqual([
      { kind: 'bracket', text: '{' },
      { kind: 'space', text: '\n  ' },
      { kind: 'key', text: '"limit"' },
      { kind: 'punct', text: ':' },
      { kind: 'space', text: ' ' },
      { kind: 'number', text: '10' },
      { kind: 'space', text: '\n' },
      { kind: 'bracket', text: '}' },
    ]);
  });

  it('nomme chaque sorte de valeur d’un objet mis en forme', () => {
    const pretty = prettyJson(
      '{"limit": 10, "query": "typecheck", "ok": true, "none": null, "list": [1, "a"]}',
    );
    expect(pretty).not.toBeNull();
    expect(meaty(tokenizeJson(pretty as string))).toEqual([
      { kind: 'bracket', text: '{' },
      { kind: 'key', text: '"limit"' },
      { kind: 'punct', text: ':' },
      { kind: 'number', text: '10' },
      { kind: 'punct', text: ',' },
      { kind: 'key', text: '"query"' },
      { kind: 'punct', text: ':' },
      { kind: 'string', text: '"typecheck"' },
      { kind: 'punct', text: ',' },
      { kind: 'key', text: '"ok"' },
      { kind: 'punct', text: ':' },
      { kind: 'keyword', text: 'true' },
      { kind: 'punct', text: ',' },
      { kind: 'key', text: '"none"' },
      { kind: 'punct', text: ':' },
      { kind: 'keyword', text: 'null' },
      { kind: 'punct', text: ',' },
      { kind: 'key', text: '"list"' },
      { kind: 'punct', text: ':' },
      { kind: 'bracket', text: '[' },
      { kind: 'number', text: '1' },
      { kind: 'punct', text: ',' },
      { kind: 'string', text: '"a"' },
      { kind: 'bracket', text: ']' },
      { kind: 'bracket', text: '}' },
    ]);
  });

  it('une chaîne qui CONTIENT un « : » n’est pas prise pour une clé', () => {
    const pretty = prettyJson('{"at":"12:30", "why":"rate limit: retry"}') as string;
    expect(meaty(tokenizeJson(pretty))).toEqual([
      { kind: 'bracket', text: '{' },
      { kind: 'key', text: '"at"' },
      { kind: 'punct', text: ':' },
      { kind: 'string', text: '"12:30"' },
      { kind: 'punct', text: ',' },
      { kind: 'key', text: '"why"' },
      { kind: 'punct', text: ':' },
      { kind: 'string', text: '"rate limit: retry"' },
      { kind: 'bracket', text: '}' },
    ]);
  });

  it('un guillemet échappé ne ferme pas la chaîne', () => {
    const pretty = prettyJson('{"said":"he said \\"go\\": twice"}') as string;
    expect(meaty(tokenizeJson(pretty))).toEqual([
      { kind: 'bracket', text: '{' },
      { kind: 'key', text: '"said"' },
      { kind: 'punct', text: ':' },
      { kind: 'string', text: '"he said \\"go\\": twice"' },
      { kind: 'bracket', text: '}' },
    ]);
  });

  it('lit les nombres négatifs et les exponentielles comme UN jeton', () => {
    expect(meaty(tokenizeJson('[-1.5, 2e10]'))).toEqual([
      { kind: 'bracket', text: '[' },
      { kind: 'number', text: '-1.5' },
      { kind: 'punct', text: ',' },
      { kind: 'number', text: '2e10' },
      { kind: 'bracket', text: ']' },
    ]);
  });

  it('un texte qui n’est pas du JSON revient ENTIER, en un jeton sans couleur', () => {
    const text = 'ENOENT: no such file or directory';
    expect(tokenizeJson(text)).toEqual([{ kind: 'space', text }]);
  });

  it('un JSON tronqué revient entier lui aussi — rien n’est perdu en route', () => {
    const text = '{\n  "query": "type';
    expect(tokenizeJson(text)).toEqual([{ kind: 'space', text }]);
    expect(
      tokenizeJson(text)
        .map((t) => t.text)
        .join(''),
    ).toBe(text);
  });

  it('un texte vide ne rend aucun jeton', () => {
    expect(tokenizeJson('')).toEqual([]);
  });
});

describe('prettyJson', () => {
  it('met en forme sur deux espaces', () => {
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}');
  });

  it('rend null sur ce qui n’est pas du JSON', () => {
    expect(prettyJson('pas du json')).toBeNull();
    expect(prettyJson('')).toBeNull();
    expect(prettyJson('{"a":')).toBeNull();
  });

  it('ne met pas en forme une sortie plus longue que la borne : le brut reste lisible', () => {
    const big = JSON.stringify({ items: Array.from({ length: 4000 }, (_, i) => `item-${i}`) });
    expect(big.length).toBeGreaterThan(PRETTY_JSON_MAX_CHARS);
    expect(prettyJson(big)).toBeNull();
    const small = JSON.stringify({ items: Array.from({ length: 10 }, (_, i) => `item-${i}`) });
    expect(prettyJson(small)).not.toBeNull();
  });
});
