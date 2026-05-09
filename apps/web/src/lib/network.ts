import 'server-only';

import { networkInterfaces } from 'node:os';

/**
 * IPv4 addresses bound to non-loopback, non-internal interfaces.
 * On a typical home install, this yields one entry like "192.168.1.42".
 * Empty array if the host has no LAN interface (rare — disconnected machine).
 *
 * Used by the Settings → Network section to surface the URL the user can
 * type on a phone or another machine on the same Wi-Fi.
 */
export function getLanAddresses(): string[] {
  const ifaces = networkInterfaces();
  const out: string[] = [];
  for (const list of Object.values(ifaces)) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.family === 'IPv4' && !iface.internal) {
        out.push(iface.address);
      }
    }
  }
  return out;
}
