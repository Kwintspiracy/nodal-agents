// git-dependency-specs.mjs — find every dependency in an INSTALLED tree that npm
// can only fetch by running git.
//
// 0.9.6 (16/10/2026): `npm install -g nodal-agents` failed on every machine
// without git — `npm error syscall spawn git`. @whiskeysockets/baileys 6.7.23
// declares `"libsignal": "git+https://github.com/whiskeysockets/libsignal-node"`,
// so npm has to spawn git to resolve it. The CI never saw it: its runners have
// git, and an install that succeeds says nothing about what it needed.
//
// npm no longer writes `_resolved` into an installed package.json, and a global
// install keeps no lockfile, so the trace left on disk is the SPEC itself: the
// `dependencies` / `optionalDependencies` value of the package that asked for it.
// An optional git dependency counts too — without git npm drops it in silence,
// and the feature behind it is gone with no error.

import { lstatSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DEPENDENCY_FIELDS = ['dependencies', 'optionalDependencies'];

/**
 * True when npm resolves `spec` through git: a git URL (`git://`, `git+https://`,
 * `git+ssh://`…), a hosted shortcut (`github:`, `gitlab:`, `bitbucket:`, `gist:`),
 * an http(s) URL to a `.git` repository, or the bare `owner/repo` GitHub shorthand.
 * @param {unknown} spec
 */
export function isGitSpec(spec) {
  if (typeof spec !== 'string') return false;
  const s = spec.trim();
  if (/^git(\+[a-z]+)?:\/\//i.test(s)) return true;
  if (/^(github|gitlab|bitbucket|gist):/i.test(s)) return true;
  if (/^https?:\/\/[^#]+\.git(#.*)?$/i.test(s)) return true;
  // `owner/repo` or `owner/repo#ref`. A range, a tag, `file:`/`npm:` specs and
  // local paths (`./x`, `/x`, `C:\x`) never match: they carry no slash, a colon,
  // or a leading `.`/`/`/`~`.
  return /^[a-z0-9][\w.-]*\/[\w.-]+(#\S*)?$/i.test(s);
}

/** Package directories directly under one `node_modules` (scopes expanded). */
function packageDirs(nodeModulesDir) {
  const dirs = [];
  for (const entry of readdirSync(nodeModulesDir)) {
    if (entry.startsWith('.')) continue;
    const full = join(nodeModulesDir, entry);
    if (!lstatSync(full).isDirectory()) continue;
    if (entry.startsWith('@')) {
      for (const scoped of readdirSync(full)) {
        const scopedFull = join(full, scoped);
        if (lstatSync(scopedFull).isDirectory()) dirs.push(scopedFull);
      }
    } else {
      dirs.push(full);
    }
  }
  return dirs;
}

/**
 * Every git-resolved dependency spec declared by a package installed under
 * `nodeModulesDir`, nested `node_modules` included.
 * @param {string} nodeModulesDir
 * @returns {{ pkg: string, dir: string, field: string, dep: string, spec: string }[]}
 */
export function findGitDependencySpecs(nodeModulesDir) {
  if (!existsSync(nodeModulesDir)) {
    throw new Error(`no node_modules at ${nodeModulesDir}: nothing was installed to scan`);
  }
  const found = [];
  const pending = [nodeModulesDir];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const dir of packageDirs(current)) {
      const manifest = join(dir, 'package.json');
      if (existsSync(manifest)) {
        const pkg = JSON.parse(readFileSync(manifest, 'utf-8'));
        for (const field of DEPENDENCY_FIELDS) {
          for (const [dep, spec] of Object.entries(pkg[field] ?? {})) {
            if (isGitSpec(spec)) {
              found.push({ pkg: `${pkg.name}@${pkg.version}`, dir, field, dep, spec });
            }
          }
        }
      }
      const nested = join(dir, 'node_modules');
      if (existsSync(nested)) pending.push(nested);
    }
  }
  return found;
}

/** Human report, or '' when nothing was found. */
export function formatGitDependencySpecs(found) {
  if (found.length === 0) return '';
  const lines = found.map((f) => `  ${f.pkg} → ${f.field}.${f.dep} = "${f.spec}"`);
  return (
    `${found.length} dependenc${found.length === 1 ? 'y needs' : 'ies need'} git to install ` +
    `(npm fails with "spawn git ENOENT" on a machine without it):\n${lines.join('\n')}`
  );
}
