// Complete apps/web/node_modules with the external dependencies of every
// workspace package it can reach.
//
// Why this exists: `pnpm install` crashes on this machine (Node 26.4.0), so the
// workspace links are made by hand. apps/web's own node_modules is therefore
// missing the external deps that Next needs to resolve at page-data collection
// time, and the build fails one module at a time.
//
// This only touches node_modules — nothing versioned.

import {
  readFileSync,
  existsSync,
  mkdirSync,
  symlinkSync,
  readdirSync,
  realpathSync,
} from 'node:fs';
import { join, dirname } from 'node:path';

const ROOT = 'D:/APPS/NodalAI';
const WEB_NM = join(ROOT, 'apps/web/node_modules');

/** Every workspace package directory. */
const pkgDirs = [];
for (const base of ['packages', 'apps', 'packages/adapters']) {
  const dir = join(ROOT, base);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (existsSync(join(p, 'package.json'))) pkgDirs.push(p);
  }
}

/** name -> a directory where it is really installed. */
const found = new Map();
for (const dir of pkgDirs) {
  const nm = join(dir, 'node_modules');
  if (!existsSync(nm)) continue;
  for (const entry of readdirSync(nm)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      const scoped = join(nm, entry);
      if (!existsSync(scoped)) continue;
      for (const sub of readdirSync(scoped)) {
        const full = `${entry}/${sub}`;
        if (!found.has(full)) found.set(full, join(scoped, sub));
      }
    } else if (!found.has(entry)) {
      found.set(entry, join(nm, entry));
    }
  }
}

/** Union of the declared dependencies of every workspace package. */
const wanted = new Set();
for (const dir of pkgDirs) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  for (const name of Object.keys(pkg.dependencies ?? {})) {
    if (!name.startsWith('@nodal-agents/')) wanted.add(name);
  }
}

let linked = 0;
const missing = [];
for (const name of [...wanted].sort()) {
  const dst = join(WEB_NM, name);
  if (existsSync(dst)) continue;
  const src = found.get(name);
  if (!src) {
    missing.push(name);
    continue;
  }
  let target;
  try {
    target = realpathSync(src);
  } catch {
    target = src;
  }
  mkdirSync(dirname(dst), { recursive: true });
  try {
    symlinkSync(target, dst, 'junction');
    linked++;
  } catch (err) {
    missing.push(`${name} (${err.code})`);
  }
}

console.log(`liens crees : ${linked}`);
if (missing.length) console.log(`introuvables : ${missing.join(', ')}`);
