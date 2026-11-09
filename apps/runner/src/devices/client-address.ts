// devices/client-address.ts — the address a request came from (#946).
//
// Read from the socket (`@hono/node-server` puts the Node request on
// `c.env.incoming`), never from a header: `X-Forwarded-For` is whatever the
// caller writes, and the per-address limit of the pairing route would be a
// limit on nothing. An IPv4 caller on a dual-stack socket arrives as
// `::ffff:a.b.c.d`; it is shown as `a.b.c.d`.

import type { Context } from 'hono';

export function clientAddress(c: Context): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const raw = env?.incoming?.socket?.remoteAddress;
  if (!raw) return null;
  return raw.startsWith('::ffff:') ? raw.slice('::ffff:'.length) : raw;
}
