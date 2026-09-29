// @nodal-agents/llm — which URLs are on the user's machine or network
//
// One definition, read by the turn clocks (a local model is slow, not dead:
// no silence clock) and by the provider transport (a local model is reached
// directly, never through the environment's proxy, #608).

/**
 * True when the URL's host is on the user's machine or network: loopback, a
 * private or link-local address, a bare name (no public host is dotless: it
 * resolves through a search domain, a hosts file or a compose service), or a
 * name under a suffix reserved for local use: `.local` (RFC 6762, mDNS),
 * `.home.arpa` (RFC 8375), `.internal` (ICANN, 2024, private use).
 * `.lan` and `.home` are common on home routers but reserved by no one;
 * they are left to NO_PROXY.
 */
export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  host = host.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (host.endsWith('.local') || host.endsWith('.localhost')) return true;
  if (host.endsWith('.home.arpa') || host.endsWith('.internal')) return true;
  // A bare name, not an IPv6 literal (those carry colons).
  if (host !== '' && !host.includes('.') && !host.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10).
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host)) return true;
  return false;
}
