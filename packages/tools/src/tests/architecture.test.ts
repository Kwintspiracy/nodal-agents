// architecture.test.ts — Invariant 1: no hardcoded agent metadata in this package
// Greps src/ for known agent slugs — must be zero matches.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Agent slugs from the KwintAgents platform — must NEVER appear in this package
const FORBIDDEN_AGENT_SLUGS = [
  'ender',
  'pavel',
  'boris',
  'jennie',
  'stanley',
  'sherlock',
  'cortex',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve the src/ directory (one level up from tests/)
const SRC_DIR = resolve(__dirname, '..');

/**
 * Recursively collect all .ts files under a directory,
 * excluding node_modules and the tests directory itself
 * (tests may reference agent names in fixture/comment context).
 */
function collectTsFiles(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (entry === 'node_modules' || entry === 'tests') continue;
      collectTsFiles(full, files);
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }
  return files;
}

describe('architecture invariant 1 — no hardcoded agent metadata', () => {
  it('src/ contains zero references to known agent slugs', () => {
    const srcFiles = collectTsFiles(SRC_DIR);
    expect(srcFiles.length).toBeGreaterThan(0); // sanity: we collected files

    const violations: { file: string; slug: string; line: number; text: string }[] = [];

    for (const filePath of srcFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        // Case-insensitive search, whole-word boundary to avoid false positives
        // e.g. 'ender' matching 'extender' — use word boundary regex
        for (const slug of FORBIDDEN_AGENT_SLUGS) {
          const regex = new RegExp(`\\b${slug}\\b`, 'i');
          if (regex.test(line)) {
            violations.push({
              file: filePath.replace(SRC_DIR, '').replace(/\\/g, '/'),
              slug,
              line: i + 1,
              text: line.trim(),
            });
          }
        }
      }
    }

    if (violations.length > 0) {
      const report = violations
        .map((v) => `  ${v.file}:${v.line} — found "${v.slug}": ${v.text}`)
        .join('\n');
      expect.fail(`Invariant 1 violated: hardcoded agent slugs found in src/:\n${report}`);
    }

    expect(violations).toHaveLength(0);
  });

  it('no hardcoded user-facing strings (no "Sorry" or "Désolé" patterns)', () => {
    const srcFiles = collectTsFiles(SRC_DIR);
    const FORBIDDEN_PATTERNS = [/\bSorry\b/, /\bDésolé\b/, /\bVoici votre résultat\b/];

    const violations: string[] = [];
    for (const filePath of srcFiles) {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';
        for (const pattern of FORBIDDEN_PATTERNS) {
          if (pattern.test(line)) {
            violations.push(`${filePath}:${i + 1}: ${line.trim()}`);
          }
        }
      }
    }

    expect(violations).toHaveLength(0);
  });
});
