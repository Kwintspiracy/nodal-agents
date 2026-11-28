// secret-mask-stream.test.ts — the stream form of the secret masker is the
// whole-text masker, delivered in pieces.
//
// The contract is a property, and this file is that property: for any text
// and any way of cutting it into chunks, what the stream masker emits, put end
// to end, equals the whole-text masker applied to the whole text. Every cut
// position is tried, then random multi-point splits with a fixed seed.
//
// No credential-shaped literal lives in this file: every such value is
// assembled at run time by the test kit (`fake-secrets.ts`), from pieces no
// scanner reads as a credential.

import { describe, expect, it } from 'vitest';
import {
  fakeAssignment,
  fakeBearer,
  fakeCredentialUrl,
  fakeJwt,
  fakePrivateKeyBlock,
  fakeSecret,
} from '@nodal-agents/test-kit';
import { createStreamRedactor, redactSecretsInText } from '../index';

/** What the stream masker releases for these chunks, end to end. */
function streamed(chunks: readonly string[]): string {
  const r = createStreamRedactor();
  return chunks.map((c) => r.push(c)).join('') + r.flush();
}

/** A small deterministic PRNG (mulberry32): the same splits on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomSplit(text: string, rand: () => number): string[] {
  const chunks: string[] = [];
  let at = 0;
  while (at < text.length) {
    const len = 1 + Math.floor(rand() * 12);
    chunks.push(text.slice(at, at + len));
    at += len;
  }
  return chunks;
}

const B64 = 'MIIEowIBAAKCAQEAx9Lq3rT0pZbVnW2s8cYk4hJmQ7uR1eF6gH0oPqLmNvBcXyZ';
const PEM = fakePrivateKeyBlock('RSA', `${B64}\n${B64}\n${B64.slice(0, 40)}==`);
const PGP = fakePrivateKeyBlock('PGP', `\nlQOYBGV${B64}\n=AbCd`, ' BLOCK');
const JWT = fakeJwt();
const ANTHROPIC = fakeSecret(
  'anthropic',
  'Xy7Qp0Lm3Nb8Vc2Zt6Rk1Wj9Hs4Gd5Fa0Ee7Uu3Ii8Oo2Pp6Qq1Rr5Ss9Tt',
);
const GITHUB = fakeSecret('github', 'Ab3Cd5Ef7Gh9Ij1Kl3Mn5Op7Qr9St1Uv3Wx5Yz');
const SLACK = fakeSecret('slackBot', `102938475610-564738291012-${'AbCdEfGhIjKlMnOpQrStUvWx'}`);
const AWS = fakeSecret('aws', 'Q3EXAMPLE7XYZ2W4');

/** Each line is one text the property is checked on. */
const CORPUS: ReadonlyArray<readonly [string, string]> = [
  ['private key block, alone', PEM],
  ['private key block inside prose', `Here is the key you asked for:\n${PEM}\nKeep it safe.`],
  ['PGP private key block', `export:\n${PGP}\ndone`],
  ['bearer token inside quotes', JSON.stringify({ Authorization: fakeBearer(JWT) })],
  ['bearer token after a backtick', `run \`Bearer ${JWT}\` then stop`],
  ['token at the start', `${ANTHROPIC} is the key`],
  ['token at the end', `the key is ${ANTHROPIC}`],
  ['two tokens in a row', `${GITHUB} ${SLACK}`],
  ['two tokens with no space', `${GITHUB},${AWS}`],
  ['token inside JSON', `{"config":{"provider":"x","key":"${ANTHROPIC}","n":3}}`],
  [
    'command line with a header and a credential URL',
    `curl -H 'Authorization: Bearer ${JWT}' ${fakeCredentialUrl('https', 'admin', 'S3cretPass', 'db.example.internal/x')}`,
  ],
  [
    'env file',
    `PORT=3000\n${fakeAssignment('DB_PASSWORD', 'hunter2-long')}\n${fakeAssignment('OPENAI_API_KEY', ANTHROPIC)}\n`,
  ],
  ['text with no spaces', `鍵は${ANTHROPIC}です。これは秘密なので共有しないでください。`],
  [
    'a certificate is not a private key',
    '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ\n-----END CERTIFICATE-----\nthen prose',
  ],
  ['ordinary text', 'Le job 09935f36-74ec-4d3f est terminé. commit b2d0577, 42 fichiers.'],
  [
    'long text',
    `${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20)}${PEM}\n${'Sed do eiusmod. '.repeat(10)}${SLACK}`,
  ],
];

describe('stream masker = whole-text masker, whatever the chunks @cap:suivre-execution/moteur', () => {
  for (const [label, text] of CORPUS) {
    it(`${label}: every single cut gives the whole-text result`, () => {
      const whole = redactSecretsInText(text);
      for (let i = 0; i <= text.length; i++) {
        const out = streamed([text.slice(0, i), text.slice(i)]);
        if (out !== whole) {
          // The first failing cut, named, rather than a 10 kB diff.
          expect({ cut: i, out }).toEqual({ cut: i, out: whole });
        }
      }
    });

    it(`${label}: random multi-point splits give the whole-text result`, () => {
      const whole = redactSecretsInText(text);
      const rand = prng(label.length * 7919);
      for (let n = 0; n < 200; n++) {
        const chunks = randomSplit(text, rand);
        expect(streamed(chunks)).toBe(whole);
      }
      // One character at a time, the finest split there is.
      expect(streamed([...text])).toBe(whole);
    });
  }

  it('the body of a private key never comes out, however the key is cut', () => {
    for (let i = 0; i <= PEM.length; i++) {
      const out = streamed([PEM.slice(0, i), PEM.slice(i)]);
      expect(out).not.toContain(B64);
    }
  });
});

describe('stream masker releases what cannot become a secret @cap:suivre-execution/moteur', () => {
  it('a text written without spaces flows chunk by chunk, with nothing held', () => {
    const text = 'これは日本語の文章で、単語の間に空白がありません。'.repeat(16);
    const r = createStreamRedactor();
    let released = '';
    for (let i = 0; i < text.length; i += 3) {
      released += r.push(text.slice(i, i + 3));
      expect(released).toBe(text.slice(0, Math.min(i + 3, text.length)));
    }
    expect(r.flush()).toBe('');
  });

  it('a "-----BEGIN" that opens no private key does not hold the rest of the reply', () => {
    const r = createStreamRedactor();
    let released = r.push('A certificate starts with -----BEGIN CERTIFICATE----- and then ');
    released += r.push('the reply goes on for a long while, line after line. ');
    expect(released).toContain('the reply goes on for a long while, line after');
  });
});
