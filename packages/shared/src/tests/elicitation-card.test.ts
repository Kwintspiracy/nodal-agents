// elicitation-card.test.ts — la question d'un serveur MCP (0145) répondue DEPUIS
// UN CANAL : la carte (texte + boutons), la grammaire de ses boutons, le
// brouillon qu'un geste modifie, et la valeur tapée en réponse au message.
// Fonctions pures, partagées par les trois canaux à boutons.

import { describe, it, expect } from 'vitest';
import { parseElicitationSchema, type ElicitationField } from '../elicitation';
import {
  ELICITATION_CALLBACK_PREFIX,
  elicitationCallbackData,
  parseElicitationCallbackData,
  initialElicitationDraft,
  applyElicitationOp,
  applyTypedElicitationValue,
  elicitationDraftRevision,
  renderElicitationCard,
} from '../elicitation-card';

const FORM = {
  type: 'object',
  properties: {
    color: {
      type: 'string',
      title: 'Color',
      enum: ['color', 'grayscale'],
      enumNames: ['Full color', 'Grayscale'],
    },
    copies: { type: 'integer', title: 'Copies', minimum: 1, maximum: 5 },
    duplex: { type: 'boolean', title: 'Two-sided' },
    note: { type: 'string', title: 'Note' },
    pages: { type: 'array', title: 'Pages', items: { enum: ['1', '2'] } },
  },
  required: ['color', 'copies'],
};

function fields(): ElicitationField[] {
  const parsed = parseElicitationSchema(FORM);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.fields;
}

const ID = '0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b';

describe('la grammaire des boutons @cap:approuver-une-action/moteur', () => {
  it('tient sous les 64 octets de Telegram et se relit', () => {
    const ops = [
      { op: 'choice', field: 12, option: 34 },
      { op: 'bool', field: 2, value: true },
      { op: 'multi', field: 99, option: 99, value: false },
      { op: 'type', field: 1 },
      { op: 'send', revision: 'abcdef12' },
      { op: 'decline' },
    ] as const;
    for (const op of ops) {
      const data = elicitationCallbackData(ID, op);
      expect(data.startsWith(`${ELICITATION_CALLBACK_PREFIX}:${ID}:`)).toBe(true);
      expect(new TextEncoder().encode(data).length).toBeLessThanOrEqual(64);
      expect(parseElicitationCallbackData(data)).toEqual({ approvalRequestId: ID, op });
    }
  });

  it('refuse ce qui n’est pas à elle', () => {
    expect(parseElicitationCallbackData(`apr:${ID}:a`)).toBeNull();
    expect(parseElicitationCallbackData(`eli:not-a-uuid:d`)).toBeNull();
    expect(parseElicitationCallbackData(`eli:${ID}:c.1`)).toBeNull();
    expect(parseElicitationCallbackData(`eli:${ID}:b.1.2`)).toBeNull();
    expect(parseElicitationCallbackData(undefined)).toBeNull();
  });
});

describe('le brouillon @cap:approuver-une-action/moteur', () => {
  it('part des défauts du serveur ; un interrupteur a toujours un état', () => {
    expect(initialElicitationDraft(fields())).toEqual({
      values: { duplex: false },
      awaiting: null,
    });
  });

  it('un geste pose une valeur EXPLICITE (rejouer un vieux bouton ne bascule rien)', () => {
    const f = fields();
    let d = initialElicitationDraft(f);
    d = applyElicitationOp(f, d, { op: 'choice', field: 0, option: 1 }).draft;
    d = applyElicitationOp(f, d, { op: 'bool', field: 2, value: true }).draft;
    d = applyElicitationOp(f, d, { op: 'bool', field: 2, value: true }).draft;
    d = applyElicitationOp(f, d, { op: 'multi', field: 4, option: 1, value: true }).draft;
    expect(d.values).toEqual({ color: 'grayscale', duplex: true, pages: ['2'] });
  });

  it('un bouton qui ne désigne aucun champ ou option est refusé, avec la raison', () => {
    const f = fields();
    const d = initialElicitationDraft(f);
    expect(applyElicitationOp(f, d, { op: 'choice', field: 0, option: 7 })).toEqual({
      ok: false,
      draft: d,
      reason: 'this choice no longer exists',
    });
    expect(applyElicitationOp(f, d, { op: 'bool', field: 0, value: true }).ok).toBe(false);
  });

  it('✏️ met un champ en attente de la valeur tapée', () => {
    const f = fields();
    const r = applyElicitationOp(f, initialElicitationDraft(f), { op: 'type', field: 1 });
    expect(r).toMatchObject({ ok: true, draft: { awaiting: 'copies' } });
  });
});

describe('la valeur tapée en réponse @cap:approuver-une-action/moteur', () => {
  it('lit un nombre dans ses bornes, et libère l’attente', () => {
    const f = fields();
    const d = { values: { duplex: false }, awaiting: 'copies' };
    expect(applyTypedElicitationValue(f, d, ' 3 ')).toEqual({
      ok: true,
      draft: { values: { duplex: false, copies: 3 }, awaiting: null },
      field: 'Copies',
    });
  });

  it('refuse une valeur hors bornes ou illisible, et garde l’attente', () => {
    const f = fields();
    const d = { values: {}, awaiting: 'copies' };
    expect(applyTypedElicitationValue(f, d, '9')).toEqual({
      ok: false,
      draft: d,
      reason: 'Copies must be at most 5',
    });
    expect(applyTypedElicitationValue(f, d, 'three')).toMatchObject({
      ok: false,
      reason: 'Copies must be a number',
    });
  });

  it('un texte libre est gardé tel quel ; sans champ en attente, rien n’est lu', () => {
    const f = fields();
    expect(
      applyTypedElicitationValue(f, { values: {}, awaiting: 'note' }, 'Staple it'),
    ).toMatchObject({
      ok: true,
      draft: { values: { note: 'Staple it' } },
    });
    expect(applyTypedElicitationValue(f, { values: {}, awaiting: null }, '3')).toMatchObject({
      ok: false,
      reason: 'no field is waiting for a typed value',
    });
  });
});

describe('la carte @cap:approuver-une-action/moteur', () => {
  it('cite la question, montre les valeurs, et porte un bouton par geste', () => {
    const f = fields();
    const draft = { values: { color: 'grayscale', duplex: false }, awaiting: null };
    const card = renderElicitationCard({
      approvalRequestId: ID,
      server: 'printer',
      message: 'How should "report.pdf" be printed?',
      fields: f,
      draft,
      imageCount: 1,
    });
    if (!card.ok) throw new Error(card.reason);
    expect(card.text).toContain('The MCP server "printer" asks:');
    expect(card.text).toContain('« How should "report.pdf" be printed? »');
    expect(card.text).toContain('Color: Grayscale');
    expect(card.text).toContain('Copies: — (required)');
    expect(card.text).toContain('Two-sided: No');
    const labels = card.buttons.map((row) => row.map((b) => b.label));
    // Le bouton d'accord EN TÊTE, visible sans défilement ; les réglages
    // dessous. Sans libellé du serveur : « ✅ Confirm » / « Decline ».
    expect(labels).toEqual([
      ['✅ Confirm', 'Decline'],
      ['Color: Full color', '✓ Color: Grayscale'],
      ['Two-sided: Yes', '✓ Two-sided: No'],
      ['☐ Pages: 1', '☐ Pages: 2'],
      ['✏️ Copies', '✏️ Note'],
    ]);
    expect(labels.flat()).not.toContain('✅ Send');
    expect(card.text).toContain('then tap ✅ Confirm.');
    const send = card.buttons[0]![0]!;
    expect(parseElicitationCallbackData(send.callbackData)).toEqual({
      approvalRequestId: ID,
      op: { op: 'send', revision: elicitationDraftRevision(draft.values) },
    });
  });

  it('les boutons portent les libellés que le serveur leur donne', () => {
    const card = renderElicitationCard({
      approvalRequestId: ID,
      server: 'printer',
      message: 'Print it?',
      fields: fields(),
      draft: { values: {}, awaiting: null },
      imageCount: 0,
      actions: { accept: 'Print', decline: null },
    });
    if (!card.ok) throw new Error(card.reason);
    expect(card.buttons[0]!.map((b) => b.label)).toEqual(['Print', 'Decline']);
    expect(card.text).toContain('then tap Print.');
  });

  it('dit quel champ attend une réponse tapée, et comment la donner', () => {
    const f = fields();
    const card = renderElicitationCard({
      approvalRequestId: ID,
      server: 'printer',
      message: 'How?',
      fields: f,
      draft: { values: {}, awaiting: 'copies' },
      imageCount: 0,
    });
    if (!card.ok) throw new Error(card.reason);
    expect(card.text).toContain(
      '✏️ Reply to this message with Copies: a whole number from 1 to 5.',
    );
  });

  it('une carte que le canal ne peut pas porter est refusée, avec la raison', () => {
    const card = renderElicitationCard({
      approvalRequestId: ID,
      server: 'printer',
      message: 'How?',
      fields: fields(),
      draft: { values: {}, awaiting: null },
      imageCount: 0,
      limits: { maxRows: 3, maxPerRow: 5 },
    });
    expect(card).toEqual({
      ok: false,
      reason: 'the form needs 5 rows of buttons and this channel shows at most 3',
    });
  });

  it('la révision change avec les valeurs, pas avec leur ordre', () => {
    expect(elicitationDraftRevision({ a: 1, b: true })).toBe(
      elicitationDraftRevision({ b: true, a: 1 }),
    );
    expect(elicitationDraftRevision({ a: 1 })).not.toBe(elicitationDraftRevision({ a: 2 }));
    expect(elicitationDraftRevision({})).toMatch(/^[0-9a-f]{8}$/);
  });
});
