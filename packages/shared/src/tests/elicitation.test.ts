// elicitation.test.ts — ce qu'un serveur MCP demande à une personne pendant un
// de ses appels (0145), lu par trois fonctions pures que le runner, la route,
// le web et (bientôt) les canaux partagent. Chacune refuse ce qu'elle ne sait
// pas lire, avec sa raison, au lieu de le deviner (invariant #4).

import { describe, it, expect } from 'vitest';
import {
  parseElicitationSchema,
  validateElicitationContent,
  readElicitationAttachments,
  ELICITATION_ATTACHMENT_MAX_BYTES,
  readElicitationActions,
  readElicitationToolInput,
  elicitationActionLabels,
  ELICITATION_ACTION_LABEL_MAX,
  ELICITATION_TEXT_MAX,
} from '../elicitation';

const FORM = {
  type: 'object',
  properties: {
    color: { type: 'string', title: 'Color', enum: ['color', 'grayscale'] },
    copies: { type: 'integer', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', default: true },
    tray: { type: 'string', oneOf: [{ const: 't1', title: 'Tray 1' }] },
    email: { type: 'string', format: 'email' },
    pages: { type: 'array', items: { enum: ['1', '2', '3'] }, maxItems: 2 },
  },
  required: ['color', 'copies'],
};

// 1×1 PNG, et les premiers octets d'un JPEG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const JPEG_HEAD = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).toString('base64');

describe('parseElicitationSchema @cap:approuver-une-action/moteur', () => {
  it('lit chaque sorte de champ du protocole, avec titres, bornes et défauts', () => {
    const parsed = parseElicitationSchema(FORM);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.fields.map((f) => [f.key, f.kind, f.required])).toEqual([
      ['color', 'choice', true],
      ['copies', 'number', true],
      ['duplex', 'boolean', false],
      ['tray', 'choice', false],
      ['email', 'text', false],
      ['pages', 'multi', false],
    ]);
    expect(parsed.fields[1]).toMatchObject({ integer: true, minimum: 1, maximum: 5 });
    expect(parsed.fields[2]).toMatchObject({ default: true });
    expect(parsed.fields[3]).toMatchObject({ options: [{ value: 't1', label: 'Tray 1' }] });
  });

  it('refuse un champ qu’il ne sait pas dessiner, avec la raison', () => {
    expect(
      parseElicitationSchema({ type: 'object', properties: { x: { type: 'object' } } }),
    ).toEqual({ ok: false, reason: 'property "x" has an unsupported type "object"' });
    expect(parseElicitationSchema({ type: 'object', properties: {}, required: ['ghost'] })).toEqual(
      { ok: false, reason: 'required property "ghost" is not declared' },
    );
  });

  // Revue Codex passe 1 de #660 : un formulaire accepté ici est dessiné et
  // attend une personne ; s'il n'admet aucune réponse que validateElicitation-
  // Content accepte, personne ne pourra jamais l'envoyer. Refusé au serveur,
  // avec la raison, pour chaque sorte de champ — jamais seulement le texte.
  it('refuse un champ qui n’admet aucune réponse valide, quelle que soit sa sorte', () => {
    const one = (prop: Record<string, unknown>) =>
      parseElicitationSchema({ type: 'object', properties: { f: prop } });
    expect(one({ type: 'string', minLength: 3000 })).toEqual({
      ok: false,
      reason: `property "f" asks for at least 3000 characters, above the ${ELICITATION_TEXT_MAX} an answer may hold`,
    });
    expect(one({ type: 'string', minLength: 10, maxLength: 5 })).toEqual({
      ok: false,
      reason: 'property "f" has minLength 10 above maxLength 5',
    });
    expect(one({ type: 'integer', minimum: 1.2, maximum: 1.8 })).toEqual({
      ok: false,
      reason: 'property "f" admits no whole number between 1.2 and 1.8',
    });
    expect(one({ type: 'array', items: { enum: ['a', 'b'] }, minItems: 3 })).toEqual({
      ok: false,
      reason: 'property "f" asks for at least 3 choices out of 2',
    });
    expect(
      one({ type: 'array', items: { enum: ['a', 'b', 'c'] }, minItems: 2, maxItems: 1 }),
    ).toEqual({
      ok: false,
      reason: 'property "f" has minItems 2 above maxItems 1',
    });
    // Ce qui reste possible passe : la borne du schéma plus basse que la nôtre.
    expect(one({ type: 'string', minLength: 3, maxLength: 5000 }).ok).toBe(true);
    expect(one({ type: 'integer', minimum: 1.2, maximum: 2.8 }).ok).toBe(true);
  });
});

describe('validateElicitationContent @cap:approuver-une-action/moteur', () => {
  it('rend le contenu valide tel quel', () => {
    expect(
      validateElicitationContent(FORM, { color: 'grayscale', copies: 2, pages: ['1', '3'] }),
    ).toEqual({ ok: true, content: { color: 'grayscale', copies: 2, pages: ['1', '3'] } });
  });

  it('dit chaque problème, champ par champ, et ne corrige rien', () => {
    const r = validateElicitationContent(FORM, {
      color: 'sepia',
      copies: 2.5,
      email: 'nope',
      pages: ['1', '2', '3'],
      extra: 1,
    });
    expect(r).toEqual({
      ok: false,
      errors: [
        { field: 'extra', reason: 'is not a field of this form' },
        { field: 'color', reason: 'is not one of the offered choices' },
        { field: 'copies', reason: 'must be a whole number' },
        { field: 'email', reason: 'is not an email address' },
        { field: 'pages', reason: 'allows at most 2 choices' },
      ],
    });
  });

  it('un champ obligatoire absent est refusé', () => {
    expect(validateElicitationContent(FORM, { color: 'color' })).toEqual({
      ok: false,
      errors: [{ field: 'copies', reason: 'is required' }],
    });
  });
});

describe('readElicitationAttachments @cap:approuver-une-action/moteur', () => {
  const meta = (items: unknown) => ({ 'nodal/attachments': items });

  it('garde les images valides, écarte les autres avec leur raison', () => {
    const r = readElicitationAttachments(
      meta([
        { mimeType: 'image/png', data: PNG, caption: 'Page 1' },
        { mimeType: 'text/html', data: 'PGI+aGk8L2I+' },
        { mimeType: 'image/png', data: JPEG_HEAD },
        { mimeType: 'image/jpeg', data: 'not base64!' },
        { mimeType: 'image/jpeg', data: JPEG_HEAD },
      ]),
    );
    expect(r.attachments.map((a) => [a.mimeType, a.caption, a.byteSize])).toEqual([
      ['image/png', 'Page 1', 70],
      ['image/jpeg', null, 12],
    ]);
    expect(r.rejected).toEqual([
      { index: 1, reason: 'mimeType "text/html" is not an accepted image type' },
      { index: 2, reason: 'data does not start like a image/png file' },
      { index: 3, reason: 'data is not base64' },
    ]);
  });

  it('plafonne la taille et le nombre', () => {
    const big = 'A'.repeat(Math.ceil(((ELICITATION_ATTACHMENT_MAX_BYTES + 3) * 4) / 3 / 4) * 4);
    const r = readElicitationAttachments(
      meta([
        { mimeType: 'image/png', data: big },
        ...Array.from({ length: 5 }, () => ({ mimeType: 'image/png', data: PNG })),
      ]),
    );
    expect(r.attachments).toHaveLength(4);
    expect(r.rejected.map((x) => x.index)).toEqual([0, 5]);
    expect(r.rejected[0]!.reason).toMatch(/above the 5242880-byte limit/);
    expect(r.rejected[1]!.reason).toBe('more than 4 images');
  });

  it('sans pièce jointe, rien ; une clé qui n’est pas une liste est dite', () => {
    expect(readElicitationAttachments(undefined)).toEqual({ attachments: [], rejected: [] });
    expect(readElicitationAttachments(meta('x')).rejected).toEqual([
      { index: -1, reason: 'nodal/attachments is not an array' },
    ]);
  });
});

describe('readElicitationActions — les libellés que le serveur donne à ses boutons @cap:approuver-une-action/moteur', () => {
  const meta = (actions: unknown) => ({ 'nodal/actions': actions });

  it('lit les deux libellés, nettoyés de tout ce qui n’est pas du texte affichable', () => {
    expect(readElicitationActions(meta({ accept: '  Print\n', decline: 'Not\u202Enow' }))).toEqual({
      actions: { accept: 'Print', decline: 'Notnow' },
      rejected: [],
    });
  });

  it('sans clé, aucun libellé : les boutons gardent les leurs', () => {
    expect(readElicitationActions(undefined)).toEqual({
      actions: { accept: null, decline: null },
      rejected: [],
    });
    expect(elicitationActionLabels(null)).toEqual({ accept: '✅ Confirm', decline: 'Decline' });
  });

  it('un libellé invalide est écarté AVEC sa raison, l’autre est gardé', () => {
    const r = readElicitationActions(
      meta({ accept: 'P'.repeat(ELICITATION_ACTION_LABEL_MAX + 1), decline: 42 }),
    );
    expect(r.actions).toEqual({ accept: null, decline: null });
    expect(r.rejected).toEqual([
      { action: 'accept', reason: `is longer than ${ELICITATION_ACTION_LABEL_MAX} characters` },
      { action: 'decline', reason: 'is not text' },
    ]);
    expect(readElicitationActions(meta('Print')).rejected).toEqual([
      { action: null, reason: 'nodal/actions is not an object' },
    ]);
    expect(readElicitationActions(meta({ accept: ' \u0000 ' })).rejected).toEqual([
      { action: 'accept', reason: 'is empty' },
    ]);
  });

  it('la ligne garde les libellés ; relus, ils repassent la même règle', () => {
    const input = readElicitationToolInput({
      server: 'printer',
      message: 'Print?',
      requestedSchema: { type: 'object', properties: {} },
      actions: { accept: 'Print', decline: 'x'.repeat(99) },
    });
    expect(input?.actions).toEqual({ accept: 'Print', decline: null });
    expect(elicitationActionLabels(input?.actions)).toEqual({
      accept: 'Print',
      decline: 'Decline',
    });
  });
});

// Revue Codex passe 2 de #660 : `Date.parse` corrige `2024-02-30` en mars et
// lit `2024-01-01T12:00` en heure locale. Le serveur, lui, valide RFC 3339 :
// une réponse acceptée ici puis refusée là-bas serait perdue après coup.
describe('les dates d’un formulaire, au sens strict @cap:approuver-une-action/moteur', () => {
  const DATES = {
    type: 'object',
    properties: {
      day: { type: 'string', format: 'date' },
      at: { type: 'string', format: 'date-time' },
    },
  };
  const errorsOf = (content: Record<string, unknown>) => {
    const r = validateElicitationContent(DATES, content);
    return r.ok ? [] : r.errors.map((e) => `${e.field}: ${e.reason}`);
  };

  it('une date du calendrier, rien d’autre', () => {
    expect(errorsOf({ day: '2024-02-29' })).toEqual([]);
    expect(errorsOf({ day: '2024-02-30' })).toEqual(['day: is not a date (YYYY-MM-DD)']);
    expect(errorsOf({ day: '2023-02-29' })).toEqual(['day: is not a date (YYYY-MM-DD)']);
    expect(errorsOf({ day: '2024-13-01' })).toEqual(['day: is not a date (YYYY-MM-DD)']);
  });

  it('une date-heure RFC 3339, avec son fuseau', () => {
    expect(errorsOf({ at: '2024-01-01T12:00:00Z' })).toEqual([]);
    expect(errorsOf({ at: '2024-01-01t12:00:00.250+08:00' })).toEqual([]);
    expect(errorsOf({ at: '2024-01-01T12:00' })).toEqual(['at: is not a date-time']);
    expect(errorsOf({ at: '2024-01-01T12:00:00' })).toEqual(['at: is not a date-time']);
    expect(errorsOf({ at: '2024-02-30T12:00:00Z' })).toEqual(['at: is not a date-time']);
    expect(errorsOf({ at: '2024-01-01T24:00:00Z' })).toEqual(['at: is not a date-time']);
  });
});

// Revue Codex passe 3 de #660 : une propriété de formulaire est une chaîne
// quelconque. `out["__proto__"] = v` appelle l'accesseur hérité au lieu de
// créer le champ : la réponse le perdait, et un formulaire qui l'exige ne
// pouvait plus être envoyé.
describe('un champ nommé __proto__ est un champ @cap:approuver-une-action/moteur', () => {
  it('validé, il est gardé comme propriété propre de la réponse', () => {
    const form = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"]}',
    );
    const content = JSON.parse('{"__proto__":"keep me"}');
    const r = validateElicitationContent(form, content);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.prototype.hasOwnProperty.call(r.content, '__proto__')).toBe(true);
    expect(JSON.stringify(r.content)).toBe('{"__proto__":"keep me"}');
    expect(Object.getPrototypeOf(r.content)).toBe(Object.prototype);
  });
});
