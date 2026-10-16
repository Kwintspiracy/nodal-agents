#!/usr/bin/env node
// fetch-vc-runtime.mjs — download the pinned Microsoft VC++ runtime package and
// write its three DLLs to apps/cli/vc-runtime/x64 (0.9.7).
//
//   node scripts/fetch-vc-runtime.mjs           # write the files
//   node scripts/fetch-vc-runtime.mjs --check   # compare with the committed files
//
// The source, its SHA-256 and each DLL's SHA-256 are pinned in
// scripts/lib/vc-runtime-source.mjs. The files are committed, so building the
// pack and running the dev stack need no network; this script is how they
// were produced and how anyone re-derives the same bytes.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VC_RUNTIME_SOURCE, extractVcRuntime, sha256 } from './lib/vc-runtime-source.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(repoRoot, 'apps/cli/vc-runtime/x64');
const check = process.argv.includes('--check');

const res = await fetch(VC_RUNTIME_SOURCE.url);
if (!res.ok) {
  console.error(`❌ ${VC_RUNTIME_SOURCE.url} → HTTP ${res.status}`);
  process.exit(1);
}
const dlls = extractVcRuntime(new Uint8Array(await res.arrayBuffer()));

let differs = 0;
for (const [name, bytes] of Object.entries(dlls)) {
  const target = join(outDir, name);
  if (check) {
    const same = existsSync(target) && sha256(readFileSync(target)) === sha256(bytes);
    console.log(`${same ? '✔' : '❌'} ${name} ${sha256(bytes)}`);
    if (!same) differs++;
  } else {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(target, bytes);
    console.log(`✔ ${name} ${sha256(bytes)} → ${target}`);
  }
}
if (differs > 0) {
  console.error(`❌ ${differs} committed file(s) differ from ${VC_RUNTIME_SOURCE.package}`);
  process.exit(1);
}
