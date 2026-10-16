// vc-runtime-source.mjs — where the Visual C++ runtime the pack ships comes
// from, pinned, and how its three DLLs are taken out of it.
//
// The source is Microsoft's own Visual Studio package for the VC++ 14.44
// redistributable runtime (Microsoft.VC143.CRT), listed in the Visual Studio
// 2022 release channel manifest (https://aka.ms/vs/17/release/channel →
// VisualStudio.vsman, product 17.14.42, read 16/10/2026). A .vsix is a zip.
// Everything is pinned and checked: the package's SHA-256 as the manifest
// gives it, then each DLL's SHA-256. Anyone running
// `node scripts/fetch-vc-runtime.mjs` gets the same bytes, or a loud failure.

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const VC_RUNTIME_SOURCE = {
  package: 'Microsoft.VC.14.44.17.14.CRT.Redist.X64.base',
  version: '14.44.35211',
  url:
    'https://download.visualstudio.microsoft.com/download/pr/45d3b8dd-bced-4b37-9974-142f748d710c/' +
    '4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5/' +
    'Microsoft.VC.14.44.17.14.CRT.Redist.X64.base.vsix',
  sha256: '4aaf54db0bfc9435f7c3660e1a00237a4b556042bfeea64bde44c2e0194e6ee5',
  /** The folder inside the package that holds the app-local runtime. */
  folder: 'Contents/VC/Redist/MSVC/14.44.35112/x64/Microsoft.VC143.CRT/',
  /** Each DLL the pack ships, with its SHA-256 once extracted. */
  files: {
    'msvcp140.dll': '0f885b509a685d2bbfa652fed26b5fb31d88fbdab0a978c641d1c7b8aa460aa9',
    'vcruntime140.dll': 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066',
    'vcruntime140_1.dll': '1f2d41c4aa5db0bc33ebf7b66d72943a817d7ce6cbe880502a9403823633093f',
  },
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** fflate, from the workspace package that depends on it. */
function loadUnzip() {
  return createRequire(resolve(repoRoot, 'packages/tools/package.json'))('fflate').unzipSync;
}

/**
 * The three DLLs out of the package bytes, each checked against its pin.
 * Throws, naming what differs, on any mismatch: a wrong byte is never shipped.
 * @param {Uint8Array} vsix
 * @param {typeof VC_RUNTIME_SOURCE} source
 * @returns {Record<string, Buffer>}
 */
export function extractVcRuntime(vsix, source = VC_RUNTIME_SOURCE) {
  const got = sha256(vsix);
  if (got !== source.sha256) {
    throw new Error(`${source.package}: SHA-256 ${got}, expected ${source.sha256}`);
  }
  const wanted = Object.keys(source.files);
  const entries = loadUnzip()(vsix, {
    filter: (f) =>
      wanted.some((name) => f.name.toLowerCase() === (source.folder + name).toLowerCase()),
  });
  const out = {};
  for (const name of wanted) {
    const key = Object.keys(entries).find(
      (k) => k.toLowerCase() === (source.folder + name).toLowerCase(),
    );
    if (!key)
      throw new Error(`${source.package}: ${source.folder}${name} not found in the package`);
    const bytes = Buffer.from(entries[key]);
    const pin = source.files[name];
    if (sha256(bytes) !== pin) {
      throw new Error(`${name}: SHA-256 ${sha256(bytes)}, expected ${pin}`);
    }
    out[name] = bytes;
  }
  return out;
}
