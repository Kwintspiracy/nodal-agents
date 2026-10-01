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
