// answer-notes.test.ts — answer() carries the person's own words (#1099).
//
// Asserted on what Nodal RECEIVES: the body of `POST /api/approve`, as raw text
// (a request with no words must be byte for byte what it was before this
// option existed) and as parsed JSON, and on the client's own refusal, which
// must happen before any request leaves.
//
// Mutations verified (each turns at least one case red):
//   - `notes` not put in the body → "the words travel as notes";
//   - whitespace sent as words → "whitespace is no words";
//   - the bound check removed → "refuses a longer text before any request";
//   - the bound off by one (>= instead of >) → "the bound itself goes through";
//   - the bound not the shared one (a second number) → "one bound";
//   - the options-shape check removed → "the third argument is an options object or nothing".

import { afterEach, describe, expect, it } from 'vitest';
import {
  CARD_NOTES_MAX,
  DEVICE_ANSWER_OPTION_KEYS,
  DEVICE_GESTURES,
  DeviceAnswerOptionsSchema,
} from '@nodal-agents/shared';
import { connect, DEVICE_CARD_NOTES_MAX, NodalDeviceError } from '../nodal-device.ts';
import { fakeNodal, liveStream } from './fake-nodal.ts';

const BASE = 'http://nodal.test:3001/';
const DEVICE = '9b1f3c1e-6a43-4f53-9a43-1f2d3c4b5a69';
const ENTITY = '2c1d0e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f';
const AGENT = '7e6d5c4b-3a29-4180-9f8e-7d6c5b4a3928';
const CONV = '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c1d';
const CARD = '1f2e3d4c-5b6a-4798-8a7b-6c5d4e3f2a1b';
const TOKEN = `ndv_${'A'.repeat(43)}`;
const session = { deviceId: DEVICE, token: TOKEN, conversationId: CONV };

/** The three kinds of card a device answers, as their choices read on the card. */
const KINDS = {
  approval: {
    approve: { label: '✅ Approve', decision: 'approve' as const },
    reject: { label: '❌ Reject', decision: 'reject' as const },
  },
  question: {
    approve: { label: 'Tray 2', decision: 'approve' as const, answer: 'Tray 2' },
    reject: { label: 'Decline', decision: 'reject' as const },
  },
  'server question': {
    approve: { label: 'Confirm', decision: 'approve' as const, answer: 'Confirm' },
    reject: { label: 'Cancel', decision: 'reject' as const },
  },
};

const open: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
});

/** A device on a scripted Nodal that records every `POST /api/approve` as raw text. */
function device(approveStatus = 200, approveBody: unknown = { ok: true }) {
  const live = liveStream();
  const nodal = fakeNodal({
    'GET /api/devices/:id/events': () => live.response,
    'POST /api/devices/:id/conversation': () =>
      Response.json({ entityId: ENTITY, agentId: AGENT, conversationId: CONV }),
    'POST /api/approve': () => Response.json(approveBody, { status: approveStatus }),
  });
  const raw: string[] = [];
  const fetchSpy = ((input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(typeof input === 'string' ? input : input.toString()).pathname;
    if (path === '/api/approve' && typeof init?.body === 'string') raw.push(init.body);
    return nodal.fetch(input, init);
  }) as typeof fetch;
  const d = connect(BASE, session, { fetch: fetchSpy, hearAnnouncements: false });
  open.push(d);
  return {
    d,
    raw,
    approves: () => nodal.requests.filter((r) => r.path === '/api/approve'),
  };
}

describe('answer(): the person’s words go with the answer @cap:approuver-une-action/moteur', () => {
  for (const [kind, choices] of Object.entries(KINDS)) {
    for (const side of ['approve', 'reject'] as const) {
      it(`${kind}, ${side === 'approve' ? 'approved' : 'refused'}: the words travel as notes, beside the choice`, async () => {
        const { d, approves } = device();
        const choice = choices[side];
        await d.answer(CARD, choice, { notes: 'Make it shorter, and keep the title.' });
        expect(approves()).toHaveLength(1);
        expect(approves()[0]!.method).toBe(DEVICE_GESTURES.answer[0].method);
        expect(approves()[0]!.body).toEqual({
          approvalRequestId: CARD,
          decision: choice.decision,
          ...('answer' in choice ? { answer: choice.answer } : {}),
          notes: 'Make it shorter, and keep the title.',
        });
      });
    }
  }

  it('the person’s text goes as written: not trimmed, not rewritten', async () => {
    const { d, approves } = device();
    const words = '  « keep »\n\tthe   spacing  ';
    await d.answer(CARD, KINDS.approval.approve, { notes: words });
    expect((approves()[0]!.body as { notes: string }).notes).toBe(words);
  });

  it('no words: the body is byte for byte the one sent without options', async () => {
    const baseline = device();
    await baseline.d.answer(CARD, KINDS.question.approve);
    await baseline.d.answer(CARD, KINDS.approval.reject);
    expect(baseline.raw).toEqual([
      JSON.stringify({ approvalRequestId: CARD, decision: 'approve', answer: 'Tray 2' }),
      JSON.stringify({ approvalRequestId: CARD, decision: 'reject' }),
    ]);
    for (const none of [{}, { notes: undefined }, { notes: '' }]) {
      const again = device();
      await again.d.answer(CARD, KINDS.question.approve, none);
      await again.d.answer(CARD, KINDS.approval.reject, none);
      expect(again.raw).toEqual(baseline.raw);
    }
  });

  it('whitespace is no words: nothing is sent for it, not even an empty notes', async () => {
    const baseline = device();
    await baseline.d.answer(CARD, KINDS.approval.approve);
    const spaces = device();
    for (const blank of [' ', '   ', '\n', '\t \r\n', ' ', ' ']) {
      await spaces.d.answer(CARD, KINDS.approval.approve, { notes: blank });
    }
    expect(spaces.raw).toEqual(Array(6).fill(baseline.raw[0]));
  });

  it('one bound: the client’s is the platform’s, and the number says 5000', () => {
    expect(DEVICE_CARD_NOTES_MAX).toBe(CARD_NOTES_MAX);
    expect(CARD_NOTES_MAX).toBe(5000);
  });

  it('the bound itself goes through; one character more is refused before any request', async () => {
    const { d, approves } = device();
    await d.answer(CARD, KINDS.approval.reject, { notes: 'x'.repeat(DEVICE_CARD_NOTES_MAX) });
    expect(approves()).toHaveLength(1);
    expect((approves()[0]!.body as { notes: string }).notes).toHaveLength(DEVICE_CARD_NOTES_MAX);

    const err = await d
      .answer(CARD, KINDS.approval.reject, { notes: 'x'.repeat(DEVICE_CARD_NOTES_MAX + 1) })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodalDeviceError);
    expect((err as NodalDeviceError).code).toBe('invalid_argument');
    // The error says the bound, and how far over the text is.
    expect((err as NodalDeviceError).message).toContain(String(DEVICE_CARD_NOTES_MAX));
    expect((err as NodalDeviceError).message).toContain(String(DEVICE_CARD_NOTES_MAX + 1));
    // Nothing left: still the one request of the line above.
    expect(approves()).toHaveLength(1);
  });

  it('a long text of whitespace only is no words, so no bound is exceeded', async () => {
    const { d, approves } = device();
    await d.answer(CARD, KINDS.approval.approve, { notes: ' '.repeat(DEVICE_CARD_NOTES_MAX * 2) });
    expect(approves()).toHaveLength(1);
    expect(approves()[0]!.body).toEqual({ approvalRequestId: CARD, decision: 'approve' });
  });

  it('the third argument is an options object or nothing: any other shape is refused before a request, never read as no words', async () => {
    class Opts {
      notes = 'a reason';
    }
    const refused: Array<[string, unknown]> = [
      ['a string', 'Use the second tray, in grey.'],
      ['an empty string', ''],
      ['a number', 42],
      ['a boolean', true],
      ['an array', [{ notes: 'a reason' }]],
      ['a function', () => ({ notes: 'a reason' })],
      ['a mistyped key', { Notes: 'a reason' }],
      ['an unknown key beside notes', { notes: 'a reason', note: 'x' }],
      ['an unknown key alone', { reason: 'a reason' }],
      ['a class instance', new Opts()],
    ];
    for (const [shape, value] of refused) {
      const { d, approves } = device();
      const err = await d
        .answer(CARD, KINDS.approval.approve, value as { notes?: string })
        .catch((e: unknown) => e);
      expect(err, shape).toBeInstanceOf(NodalDeviceError);
      expect((err as NodalDeviceError).code, shape).toBe('invalid_argument');
      expect(approves(), shape).toEqual([]);
    }
    // The message says what was expected.
    const { d } = device();
    const err = await d
      .answer(CARD, KINDS.approval.approve, 'words' as unknown as { notes?: string })
      .catch((e: unknown) => e);
    expect((err as NodalDeviceError).message).toContain('{ notes:');
    const typo = await d
      .answer(CARD, KINDS.approval.approve, { Notes: 'x' } as unknown as { notes?: string })
      .catch((e: unknown) => e);
    expect((typo as NodalDeviceError).message).toContain('Notes');
  });

  it('the accepted shapes send what they sent: undefined, null, {}, notes undefined, an object with a null prototype', async () => {
    const baseline = device();
    await baseline.d.answer(CARD, KINDS.question.approve);
    for (const ok of [
      undefined,
      null,
      {},
      { notes: undefined },
      Object.assign(Object.create(null) as object, { notes: '' }),
    ]) {
      const again = device();
      await again.d.answer(CARD, KINDS.question.approve, ok as { notes?: string } | undefined);
      expect(again.raw).toEqual(baseline.raw);
    }
    const nullProto = device();
    await nullProto.d.answer(
      CARD,
      KINDS.approval.approve,
      Object.assign(Object.create(null) as object, { notes: 'words' }),
    );
    expect(nullProto.approves()[0]!.body).toEqual({
      approvalRequestId: CARD,
      decision: 'approve',
      notes: 'words',
    });
  });

  it('the client’s list of option keys is the protocol schema’s', () => {
    expect([...DEVICE_ANSWER_OPTION_KEYS].sort()).toEqual(
      Object.keys(DeviceAnswerOptionsSchema.shape).sort(),
    );
  });

  it('words that are not a text are refused here, never dropped', async () => {
    const { d, approves } = device();
    const err = await d
      .answer(CARD, KINDS.approval.approve, { notes: 42 as unknown as string })
      .catch((e: unknown) => e);
    expect((err as NodalDeviceError).code).toBe('invalid_argument');
    expect(approves()).toHaveLength(0);
  });

  it('what Nodal refuses comes back as it said it: request_failed with its own code', async () => {
    const { d } = device(400, { error: 'notes_too_long' });
    const err = await d
      .answer(CARD, KINDS.approval.approve, { notes: 'a reason' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NodalDeviceError);
    expect(err).toMatchObject({
      code: 'request_failed',
      status: 400,
      serverCode: 'notes_too_long',
    });
  });
});
