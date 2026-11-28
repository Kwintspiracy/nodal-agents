// outbound-responses.test.ts — every answer of the runner leaves through the
// outbound seam: a JSON body masked as a structured value, any other text as a
// text; an event stream is left to its events (each built by `sseEvent`, which
// takes only an outbound value), bytes are not text, and the one named
// exemption leaves as it is.

import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { REDACTED_TEXT } from '@nodal-agents/shared';
import { fakeSecret } from '@nodal-agents/test-kit';
import { answerAsIs, outboundResponses } from '../../routes/outbound-responses.ts';
import { sseEvent } from '../../routes/sse.ts';
import { outboundValue } from '@nodal-agents/shared';

const KEY = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');
const DEVICE_TOKEN = fakeSecret('nodalDevice', 'A'.repeat(43));

function app(): Hono {
  const a = new Hono();
  a.use('*', outboundResponses);
  a.get('/json', (c) => c.json({ reply: `I used ${KEY}`, nested: [{ apiKey: 'plain' }] }, 201));
  a.get('/text', (c) => c.text(`token ${KEY}`));
  a.get('/error', (c) => c.json({ error: 'push_failed', detail: `refused ${KEY}` }, 502));
  a.get(
    '/bytes',
    () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Type': 'image/png' } }),
  );
  a.get(
    '/stream',
    () =>
      new Response(sseEvent('done', outboundValue({ reply: `I used ${KEY}` })), {
        headers: { 'Content-Type': 'text/event-stream' },
      }),
  );
  a.get('/pairing', (c) => answerAsIs(c, { token: DEVICE_TOKEN }, 200, 'pairing-credential'));
  a.get('/agent-says-token', (c) => c.json({ reply: `here: ${DEVICE_TOKEN}` }));
  return a;
}

describe('the runner answers through the outbound seam @cap:parler-a-un-agent/moteur', () => {
  it('a JSON answer: every string masked by shape, every secret field by name, status kept', async () => {
    const res = await app().request('/json');
    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({
      reply: `I used ${REDACTED_TEXT}`,
      nested: [{ apiKey: REDACTED_TEXT }],
    });
  });

  it('an error answer is masked like any other (an error can quote what it failed on)', async () => {
    const res = await app().request('/error');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'push_failed', detail: `refused ${REDACTED_TEXT}` });
  });

  it('a text answer', async () => {
    const res = await app().request('/text');
    expect(await res.text()).toBe(`token ${REDACTED_TEXT}`);
  });

  it('bytes are left as they are', async () => {
    const res = await app().request('/bytes');
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('an event stream is masked event by event, where it is written', async () => {
    const res = await app().request('/stream');
    const body = await res.text();
    expect(body).not.toContain(KEY);
    expect(body).toContain(REDACTED_TEXT);
  });

  it('the pairing secret reaches the device being paired, and only there', async () => {
    const paired = await app().request('/pairing');
    expect(await paired.json()).toEqual({ token: DEVICE_TOKEN });
    // The same value in what an agent says is masked.
    const said = await app().request('/agent-says-token');
    expect(await said.json()).toEqual({ reply: `here: ${REDACTED_TEXT}` });
  });

  it('an exemption that is not named is refused', () => {
    const a = new Hono();
    a.get('/x', (c) => answerAsIs(c, {}, 200, 'not-a-reason' as 'pairing-credential'));
    return expect(Promise.resolve(a.request('/x')).then((r) => r.status)).resolves.toBe(500);
  });
});
