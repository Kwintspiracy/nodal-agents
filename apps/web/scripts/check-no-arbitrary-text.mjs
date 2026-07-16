// check-no-arbitrary-text.mjs — bans hardcoded `text-[Npx]` Tailwind sizes.
//
// "Conformité design par la machine" (feedback_design_conformance_by_machine):
// typography is a CSS ramp (see globals.css, "Type ramp" + "Legacy fractional"
// sections), never a magic number scattered in JSX. An ESLint `no-restricted-syntax`
// rule can't reliably catch this — the offending string lives in JSX literals,
// template literals, plain string constants (`const TD = '...'`), and clsx
// arrays alike, so a plain source scan across every file is the only check
// that doesn't miss a shape. Exit 1 on any hit (CI-able, chained after `eslint`
// in the `lint` script).
//
// Escape hatch: none. If a size genuinely isn't in the ramp yet, add a
// `text-legacy-*` utility to globals.css instead of reaching for `text-[Npx]`.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const PATTERN = /text-\[[0-9.]+px\]/g;
const EXTS = new Set(['.ts', '.tsx']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full, out);
    } else if (EXTS.has(extname(entry)) && !entry.endsWith('.figma.tsx')) {
      out.push(full);
    }
  }
  return out;
}

/** Strips `/* … *‍/` and `// …` comments so documentation mentions of
 *  `text-[Npx]` (a few files reference the old class in prose) don't false-positive.
 *  Line-based and deliberately simple — good enough for this repo's style. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

export function findViolations(source) {
  const stripped = stripComments(source);
  const lines = stripped.split('\n');
  const hits = [];
  lines.forEach((line, i) => {
    const matches = line.match(PATTERN);
    if (matches) hits.push({ line: i + 1, matches });
  });
  return hits;
}

function main() {
  const files = walk(SRC_DIR);
  let total = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const hits = findViolations(source);
    if (hits.length === 0) continue;
    const rel = file.slice(SRC_DIR.length + 1);
    for (const { line, matches } of hits) {
      console.log(`  ✖ ${rel}:${line}  ${matches.join(', ')}`);
      total += matches.length;
    }
  }
  if (total > 0) {
    console.log(
      `\n✖ ${total} taille(s) arbitraire(s) text-[Npx] trouvée(s). Utilise la ramp text-* (globals.css, "Type ramp" / "Legacy fractional") au lieu d'une taille en dur.`,
    );
    process.exit(1);
  }
  console.log('✔ Aucune taille text-[Npx] arbitraire.');
}

if (process.argv[1]?.endsWith('check-no-arbitrary-text.mjs')) {
  main();
}
