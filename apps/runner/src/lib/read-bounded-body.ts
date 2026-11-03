// lib/read-bounded-body.ts — read an incoming request body, never past a cap.
//
// `c.req.arrayBuffer()` and `c.req.json()` buffer the WHOLE body before anyone
// can look at its size. A `Content-Length` check in front of them is advisory
// only: a `Transfer-Encoding: chunked` request has none, so a 500 MB body is
// allocated in full before the route gets to refuse it (review of PR #958,
// pass 1). This reader counts the bytes AS THEY ARRIVE and cancels the stream
// the moment the count passes the cap: what is held in memory is never more
// than the cap plus the one network chunk that crossed it.
//
// Two routes read a body this way: the voice turn's audio chunks
// (routes/voice-turn.ts) and the inbound webhooks (routes/webhook.ts), which
// carried their own copy of this loop.

export type BoundedBody = { ok: true; bytes: Uint8Array } | { ok: false; reason: 'too_large' };

export async function readBoundedBody(req: Request, maxBytes: number): Promise<BoundedBody> {
  // An early refusal when the client states the size: nothing is read at all.
  const declaredLength = req.headers.get('content-length');
  if (declaredLength !== null) {
    const declared = Number(declaredLength);
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: 'too_large' };
  }

  const reader = req.body?.getReader();
  if (!reader) return { ok: true, bytes: new Uint8Array(0) };

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return { ok: false, reason: 'too_large' };
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, bytes };
}
