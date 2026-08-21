// pin-runtime-deps.test.mjs — the guard that would have stopped 0.8.1 from
// reaching npm with a caret on `next` next to a PRE-BUILT web bundle.
//
// Assertions are on real results: versions resolved out of THIS workspace's
// actual node_modules, and the real shape of the pinned dependency map. No call
// counts, no mocks at the resolution boundary — resolution IS what is under test.
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installedVersion,
  pinToInstalledVersions,
  formatUnresolved,
} from '../lib/pin-runtime-deps.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The version a workspace manifest declares, for cross-checking. */
function declaredIn(manifestPath, name) {
  const pkg = JSON.parse(readFileSync(resolve(repoRoot, manifestPath), 'utf-8'));
  return pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? null;
}

describe('installedVersion', () => {
  it('resolves a dependency declared by a nested workspace package (pnpm layout)', () => {
    // `next` lives under apps/web, not at the repo root — the root-only lookup
    // that a naive implementation would do finds nothing here.
    const version = installedVersion('next', repoRoot);
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
    // Must be a concrete version, never the declared range.
    expect(version).not.toContain('^');
    expect(version).not.toContain('~');
  });

  it('resolves a package whose exports map hides ./package.json', () => {
    // Exercises the entry-point + walk-up branch rather than the direct
    // manifest read. `ai` (Vercel AI SDK) ships a restrictive exports map.
    const version = installedVersion('ai', repoRoot);
    expect(version).toBeTruthy();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('returns the version satisfying the declared range, not the range itself', () => {
    const declared = declaredIn('apps/web/package.json', 'next');
    expect(declared).toBeTruthy();
    const resolved = installedVersion('next', repoRoot);
    // Same major, concrete patch. If these ever diverge, the pack would ship a
    // bundle built against one version and a manifest naming another.
    expect(resolved.split('.')[0]).toBe(declared.replace(/^[\^~]/, '').split('.')[0]);
  });

  it('returns null for a package that is not installed', () => {
    expect(installedVersion('nodal-agents-no-such-package-xyz', repoRoot)).toBeNull();
  });
});

describe('pinToInstalledVersions', () => {
  it('rewrites every range to an exact version', () => {
    const { pinned, unresolved } = pinToInstalledVersions(
      { next: '^16.2.6', zod: '^4.4.3', hono: '^4.12.18' },
      repoRoot,
    );
    expect(unresolved).toEqual([]);
    for (const [name, version] of Object.entries(pinned)) {
      expect(version, `${name} must be pinned`).toMatch(/^\d+\.\d+\.\d+/);
      expect(version, `${name} must not keep a range`).not.toMatch(/[\^~><*]|\s-\s/);
    }
  });

  it('preserves an already-exact pin unchanged', () => {
    // baileys is pinned exactly on purpose: ^6.7.23 resolves to a chronologically
    // older 6.17.x carrying a message-spoofing CVE.
    const { pinned } = pinToInstalledVersions({ '@whiskeysockets/baileys': '6.7.23' }, repoRoot);
    expect(pinned['@whiskeysockets/baileys']).toBe('6.7.23');
  });

  it('reports an unresolvable dependency instead of silently keeping its range', () => {
    const { pinned, unresolved } = pinToInstalledVersions(
      { next: '^16.2.6', 'nodal-agents-no-such-package-xyz': '^1.0.0' },
      repoRoot,
    );
    expect(unresolved).toEqual(['nodal-agents-no-such-package-xyz']);
    // The caller (build-pack.mjs) fails the build on a non-empty list — the
    // value left behind here must never be mistaken for a successful pin.
    expect(pinned['nodal-agents-no-such-package-xyz']).toBe('^1.0.0');
  });

  it('does not mutate the input map', () => {
    const input = { next: '^16.2.6' };
    pinToInstalledVersions(input, repoRoot);
    expect(input.next).toBe('^16.2.6');
  });
});

describe('formatUnresolved', () => {
  it('is empty when nothing is unresolved', () => {
    expect(formatUnresolved([])).toBe('');
  });

  it('names every unresolved package and points at the remedy', () => {
    const text = formatUnresolved(['alpha', 'beta']);
    expect(text).toContain('alpha');
    expect(text).toContain('beta');
    expect(text).toContain('pnpm install');
    expect(text).toContain('SUPPLY-001');
  });
});

describe('regression: the 0.8.1 defect itself', () => {
  it('never emits a caret range for next, the dep the pre-built bundle is compiled against', () => {
    // 0.8.1 shipped `"next": "^16.2.6"` beside a standalone bundle built for
    // 16.2.6 exactly. When next@16.3.0 landed, every fresh `npm install -g`
    // resolved to it and the dashboard crashed on boot with
    // `TypeError: Cannot read properties of undefined (reading 'validationLevel')`.
    const { pinned } = pinToInstalledVersions({ next: '^16.2.6' }, repoRoot);
    expect(pinned.next).not.toMatch(/^[\^~]/);
    expect(pinned.next).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
