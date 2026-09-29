// _tls-fixture.ts — a self-signed certificate for `localhost`, built in the
// test with node:crypto alone (#608).
//
// HTTP/2 over TLS is what `fetch` negotiates with the hosted providers (ALPN
// `h2`), so a local provider stand-in must speak TLS too: over plain http no
// client ever negotiates h2 and the shared-connection hazard cannot appear.
// The certificate is a minimal X.509 v3 (ECDSA P-256, SAN localhost and
// 127.0.0.1) encoded by hand in DER, so no openssl binary and no dependency.

import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';

function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([tag]), derLength(body.length), body]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, ...parts);

function oid(dotted: string): Buffer {
  const n = dotted.split('.').map(Number);
  const out = [40 * (n[0] ?? 0) + (n[1] ?? 0)];
  for (const v of n.slice(2)) {
    const b = [v & 0x7f];
    let x = v >> 7;
    while (x > 0) {
      b.unshift((x & 0x7f) | 0x80);
      x >>= 7;
    }
    out.push(...b);
  }
  return tlv(0x06, Buffer.from(out));
}

const utcTime = (d: Date): Buffer =>
  tlv(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));

/** A key and a self-signed certificate valid for `localhost` and 127.0.0.1, for one day. */
export function selfSignedLocalhostCert(): { key: string; cert: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const spki = publicKey.export({ type: 'spki', format: 'der' });
  const name = seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from('localhost')))));
  const ecdsaWithSha256 = seq(oid('1.2.840.10045.4.3.2'));
  const subjectAltName = seq(
    oid('2.5.29.17'),
    tlv(0x04, seq(tlv(0x82, Buffer.from('localhost')), tlv(0x87, Buffer.from([127, 0, 0, 1])))),
  );
  const now = Date.now();
  const tbs = seq(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
    ecdsaWithSha256,
    name,
    seq(utcTime(new Date(now - 60_000)), utcTime(new Date(now + 86_400_000))),
    name,
    spki,
    tlv(0xa3, seq(subjectAltName)),
  );
  const signature = sign('sha256', tbs, privateKey);
  const der = seq(tbs, ecdsaWithSha256, tlv(0x03, Buffer.concat([Buffer.from([0]), signature])));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  return {
    key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    cert: `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----\n`,
  };
}
