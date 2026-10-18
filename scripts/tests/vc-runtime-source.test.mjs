// vc-runtime-source.test.mjs — the VC++ runtime DLLs the pack ships are the
// pinned bytes of Microsoft's package, and nothing else gets through.
//
// Offline: the committed files are hashed against the pins; the extraction is
// proved on zips built here. `node scripts/fetch-vc-runtime.mjs --check` is the
// online half (downloads the package, re-derives the bytes, compares).
//
// Run from the repo root: pnpm test:scripts

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VC_RUNTIME_SOURCE, extractVcRuntime, sha256 } from '../lib/vc-runtime-source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { zipSync } = createRequire(resolve(repoRoot, 'packages/tools/package.json'))('fflate');

/** A package holding `files` under the pinned folder, and a source pinned to it. */
function fakePackage(files) {
  const entries = {};
  for (const [name, text] of Object.entries(files)) {
    entries[VC_RUNTIME_SOURCE.folder + name] = Buffer.from(text);
  }
  entries['Contents/VC/Redist/MSVC/14.44.35112/debug_nonredist/x64/vcruntime140d.dll'] =
    Buffer.from('debug runtime: not redistributable, never extracted');
  const vsix = zipSync(entries);
  const source = {
    ...VC_RUNTIME_SOURCE,
    sha256: sha256(vsix),
    files: Object.fromEntries(Object.entries(files).map(([n, t]) => [n, sha256(Buffer.from(t))])),
  };
  return { vsix, source };
}

describe('the VC++ runtime the pack ships', () => {
  it('the committed DLLs are the pinned bytes of the Microsoft package', () => {
    for (const [name, pin] of Object.entries(VC_RUNTIME_SOURCE.files)) {
      const bytes = readFileSync(join(repoRoot, 'apps/cli/vc-runtime/x64', name));
      expect(sha256(bytes), name).toBe(pin);
    }
  });

  it('extracts exactly the three pinned DLLs from the package', () => {
    const { vsix, source } = fakePackage({
      'msvcp140.dll': 'p',
      'vcruntime140.dll': 'v',
      'vcruntime140_1.dll': 'v1',
    });

    const out = extractVcRuntime(vsix, source);

    expect(Object.keys(out).sort()).toEqual([
      'msvcp140.dll',
      'vcruntime140.dll',
      'vcruntime140_1.dll',
    ]);
    expect(out['vcruntime140_1.dll'].toString()).toBe('v1');
  });

  it('refuses a package whose SHA-256 is not the pinned one', () => {
    const { vsix, source } = fakePackage({ 'msvcp140.dll': 'p' });
    expect(() => extractVcRuntime(vsix, { ...source, sha256: '0'.repeat(64) })).toThrow(
      /SHA-256 [0-9a-f]{64}, expected 0{64}/,
    );
  });

  it('refuses a DLL whose SHA-256 is not the pinned one', () => {
    const { vsix, source } = fakePackage({ 'msvcp140.dll': 'p' });
    const pinned = { ...source, files: { 'msvcp140.dll': sha256(Buffer.from('other bytes')) } };
    expect(() => extractVcRuntime(vsix, pinned)).toThrow(/^msvcp140\.dll: SHA-256/);
  });

  it('refuses a package that lacks one of the DLLs', () => {
    const { vsix, source } = fakePackage({ 'msvcp140.dll': 'p' });
    const wantsMore = { ...source, files: { ...source.files, 'vcruntime140.dll': null } };
    expect(() => extractVcRuntime(vsix, wantsMore)).toThrow(/vcruntime140\.dll not found/);
  });
});
