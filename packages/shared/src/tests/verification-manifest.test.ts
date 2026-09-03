import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  canonicalJson,
  hashVerificationManifest,
  sha256Hex,
  SHELL_POLICY_VERSION,
  ENV_ALLOWLIST_VERSION,
  type VerificationManifest,
} from '../verification-manifest';
import { VerifyCommandsSchema, VerifyCommandSchema } from '../types/verification';

const base: VerificationManifest = {
  verifierConfig: [
    { command: 'pnpm typecheck', timeoutSeconds: 120 },
    { command: 'pnpm test', timeoutSeconds: 600 },
  ],
  invariants: [],
  canonicalKey: 'c:/dev/app',
  cwd: 'C:/Dev/App',
  shellPolicyVersion: SHELL_POLICY_VERSION,
  envAllowlistVersion: ENV_ALLOWLIST_VERSION,
};

describe('sha256Hex — parité avec node:crypto', () => {
  it('rend la même empreinte que node:crypto sur des entrées variées', () => {
    const inputs = [
      '',
      'abc',
      'a'.repeat(55), // frontière du padding : 55 octets + 0x80 + 8 = 64
      'a'.repeat(56), // force un second bloc
      'a'.repeat(64),
      'a'.repeat(1000),
      'clé « accentuée » — €, 日本語, 🧪', // UTF-8 multi-octets
      canonicalJson(base),
    ];
    for (const s of inputs) {
      expect(sha256Hex(s)).toBe(createHash('sha256').update(s, 'utf8').digest('hex'));
    }
  });

  it('vecteur FIPS : sha256("abc")', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('canonicalJson', () => {
  it('trie les clés récursivement et n’émet aucun espace', () => {
    const a = canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 'x' } });
    const b = canonicalJson({ a: { c: 'x', d: [1, { y: 2, z: 1 }] }, b: 1 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"c":"x","d":[1,{"y":2,"z":1}]},"b":1}');
  });

  it('préserve l’ordre des tableaux — c’est l’ordre des commandes', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('refuse undefined et les nombres non finis — un champ absent n’est pas vide', () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalJson({ a: Number.NaN })).toThrow(/non-finite/);
  });
});

describe('hashVerificationManifest', () => {
  it('hash stable : même manifeste, clés dans un autre ordre ⇒ même hash, préfixe v1:, 3+64 caractères', () => {
    const reordered: VerificationManifest = {
      envAllowlistVersion: base.envAllowlistVersion,
      cwd: base.cwd,
      invariants: base.invariants,
      shellPolicyVersion: base.shellPolicyVersion,
      canonicalKey: base.canonicalKey,
      verifierConfig: [
        { timeoutSeconds: 120, command: 'pnpm typecheck' },
        { timeoutSeconds: 600, command: 'pnpm test' },
      ],
    };
    const h = hashVerificationManifest(base);
    expect(hashVerificationManifest(reordered)).toBe(h);
    expect(h).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  it('ordre des commandes : permuter deux entrées ⇒ hash différent', () => {
    const swapped: VerificationManifest = {
      ...base,
      verifierConfig: [
        { command: 'pnpm test', timeoutSeconds: 600 },
        { command: 'pnpm typecheck', timeoutSeconds: 120 },
      ],
    };
    expect(hashVerificationManifest(swapped)).not.toBe(hashVerificationManifest(base));
  });

  it('invariants toujours présents dans la chaîne hashée, même vides', () => {
    // La chaîne canonique porte `"invariants":[]` — pas un champ omis.
    const canonical = canonicalJson({
      verifierConfig: base.verifierConfig,
      invariants: base.invariants,
      canonicalKey: base.canonicalKey,
      cwd: base.cwd,
      shellPolicyVersion: base.shellPolicyVersion,
      envAllowlistVersion: base.envAllowlistVersion,
    });
    expect(canonical).toContain('"invariants":[]');
    const withInvariant = hashVerificationManifest({ ...base, invariants: [{ rule: 'x' }] });
    expect(withInvariant).not.toBe(hashVerificationManifest(base));
  });

  it('versions : changer shellPolicyVersion ou envAllowlistVersion ⇒ hash différent', () => {
    const h = hashVerificationManifest(base);
    expect(hashVerificationManifest({ ...base, shellPolicyVersion: 2 })).not.toBe(h);
    expect(hashVerificationManifest({ ...base, envAllowlistVersion: 2 })).not.toBe(h);
  });

  it('cible et répertoire comptent aussi', () => {
    const h = hashVerificationManifest(base);
    expect(hashVerificationManifest({ ...base, canonicalKey: 'c:/dev/other' })).not.toBe(h);
    expect(hashVerificationManifest({ ...base, cwd: 'C:/Dev/App/sub' })).not.toBe(h);
  });
});

describe('VerifyCommandsSchema (v5-A : 1 à 5 entrées)', () => {
  const cmd = (i: number) => ({ command: `cmd ${i}`, timeoutSeconds: 10 });

  it('accepte 1 et 5 entrées', () => {
    expect(VerifyCommandsSchema.safeParse([cmd(1)]).success).toBe(true);
    expect(VerifyCommandsSchema.safeParse([1, 2, 3, 4, 5].map(cmd)).success).toBe(true);
  });

  it('refuse 0 et 6 entrées', () => {
    expect(VerifyCommandsSchema.safeParse([]).success).toBe(false);
    expect(VerifyCommandsSchema.safeParse([1, 2, 3, 4, 5, 6].map(cmd)).success).toBe(false);
  });

  it('refuse un timeout non entier, nul ou hors borne, et une commande vide', () => {
    expect(VerifyCommandSchema.safeParse({ command: 'x', timeoutSeconds: 1.5 }).success).toBe(
      false,
    );
    expect(VerifyCommandSchema.safeParse({ command: 'x', timeoutSeconds: 0 }).success).toBe(false);
    expect(VerifyCommandSchema.safeParse({ command: 'x', timeoutSeconds: 3601 }).success).toBe(
      false,
    );
    expect(VerifyCommandSchema.safeParse({ command: '   ', timeoutSeconds: 10 }).success).toBe(
      false,
    );
  });
});
