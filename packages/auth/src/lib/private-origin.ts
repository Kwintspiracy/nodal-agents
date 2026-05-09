// Recognises Origin header values that point to a host on the local machine
// or a private LAN (RFC1918). Used to decide which Origin headers to add to
// better-auth's `trustedOrigins`, so that signing in from a phone on the same
// WiFi works without re-configuring the server every time DHCP swaps IPs.
//
// Public IPs and unparseable strings are always rejected, so a malicious site
// on the open internet cannot trick the browser into mounting a CSRF.

const PRIVATE_IPV4 = [
  /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/,
  /^192\.168\.\d{1,3}\.\d{1,3}$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/,
];

export function isPrivateOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // URL.hostname strips the enclosing brackets from IPv6 in Node, so we get
  // bare "::1". Defensive: accept both bracketed and bare forms.
  const host = url.hostname.toLowerCase();
  if (host === 'localhost') return true;
  if (host === '::1' || host === '[::1]') return true;
  return PRIVATE_IPV4.some((re) => re.test(host));
}
