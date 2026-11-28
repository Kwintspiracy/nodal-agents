// routes/outbound-responses.ts — every answer of the runner leaves through the seam.
//
// The runner answers the dashboard, a paired device, any module (#947). What
// it answers can carry what an agent wrote (a chat reply, a request's input
// on a card, an error), so EVERY answer is masked here, once, by the outbound
// functions of `@nodal-agents/shared`: a JSON body as a structured value, any
// other text as a text. Installed on the app before any route (`createApp`),
// so a route added tomorrow is masked without knowing it.
//
// What this does not read:
//   - an event stream (`text/event-stream`): each of its events is built by
//     `sseEvent` (routes/sse.ts), which takes only an outbound value, so the
//     stream is masked event by event where it is written;
//   - bytes (an image, a sound): not text.
//
// An answer that must leave unmasked says so with `answerAsIs` and a reason of
// `OUTBOUND_EXEMPTIONS`: never a default, never an omission.

import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import {
  outboundAsIs,
  outboundText,
  outboundValue,
  type OutboundExemption,
} from '@nodal-agents/shared';

const EXEMPT = new WeakSet<Request>();

/**
 * Answer `body` as JSON, unmasked on purpose, for the reason named. The one way
 * a route of the runner sends a value it must not mask.
 */
export function answerAsIs(
  c: Context,
  body: unknown,
  status: ContentfulStatusCode,
  exemption: OutboundExemption,
): Response {
  EXEMPT.add(c.req.raw);
  return c.json(outboundAsIs(body, exemption) as object, status);
}

const isJson = (type: string): boolean => /\bjson\b/i.test(type);
const isText = (type: string): boolean =>
  /^text\//i.test(type) && !/^text\/event-stream/i.test(type);

/** The middleware: masks the body of every textual answer. */
export const outboundResponses: MiddlewareHandler = async (c, next) => {
  await next();
  if (EXEMPT.has(c.req.raw)) return;
  const res = c.res;
  if (res.body === null) return;
  const type = res.headers.get('content-type') ?? '';
  if (!isJson(type) && !isText(type)) return;
  const raw = await res.text();
  let body: string;
  if (isJson(type)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A body that says JSON and is not: masked as the text it is.
      parsed = undefined;
    }
    body = parsed === undefined ? outboundText(raw) : JSON.stringify(outboundValue(parsed));
  } else {
    body = outboundText(raw);
  }
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  c.res = new Response(body, { status: res.status, statusText: res.statusText, headers });
};
