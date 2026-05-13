// architecture.test.ts — invariants 1, 2, 3
// These tests grep the src/ directory for violations.
//
// Invariant 1: no hardcoded agent slugs
// Invariant 2: no hardcoded user-facing strings
// Invariant 3: no agent-specific band-aid catches

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

// ─── File collector ────────────────────────────────────────────────────────────

function collectTsFiles(dir: string): string[] {
  const files: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current)) {
      const fullPath = join(current, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory() && entry !== 'node_modules' && entry !== 'dist') {
        walk(fullPath);
      } else if (stat.isFile() && entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
        files.push(fullPath);
      }
    }
  }

  walk(dir);
  return files;
}

const SRC_DIR = resolve(import.meta.dirname ?? __dirname, '../');
const sourceFiles = collectTsFiles(SRC_DIR);

function readAll(): string {
  return sourceFiles.map((f) => readFileSync(f, 'utf-8')).join('\n');
}

// ─── Invariant 1: no hardcoded agent slugs ────────────────────────────────────

describe('invariant 1: no hardcoded agent slugs', () => {
  // These are the known agent slugs from the legacy codebase.
  // None should appear as string literals in the runner source.
  const KNOWN_SLUGS = [
    'ender',
    'pavel',
    'boris',
    'jennie',
    'sherlock',
    'displacer',
    'configurator',
    'memory-guardian',
  ];

  it('source files contain no hardcoded agent slugs', () => {
    const allSource = readAll();

    const violations: string[] = [];
    for (const slug of KNOWN_SLUGS) {
      // Match the slug as a string literal (quoted) but not in comments or test files
      const pattern = new RegExp(`["'\`]${slug}["'\`]`, 'i');
      if (pattern.test(allSource)) {
        violations.push(slug);
      }
    }

    expect(violations).toHaveLength(0);
  });
});

// ─── Invariant 2: no hardcoded user-facing strings ───────────────────────────

describe('invariant 2: no hardcoded user-facing strings in source', () => {
  // Patterns that indicate user-facing strings injected by the runner
  const USER_FACING_PATTERNS = [
    /["'`]Sorry[,\s]/i,
    /["'`]Désolé/i,
    /["'`]Voici /i,
    /["'`]Hello[,!\s]/i,
    /["'`]I couldn't/i,
    /["'`]Je n'ai pas pu/i,
    /["'`]Please try again/i,
    /["'`]I ran into an error/i,
    /["'`]Your request/i,
    /["'`]I'm unable/i,
    /["'`]I am unable/i,
    // Allow "Approved" and "Rejected" as status markers (inside square brackets)
    // These are structural markers, not user-facing prose
  ];

  for (const pattern of USER_FACING_PATTERNS) {
    it(`no match for ${pattern.source}`, () => {
      const allSource = readAll();
      expect(allSource).not.toMatch(pattern);
    });
  }
});

// ─── Invariant 3: no agent-specific band-aid catches ─────────────────────────

describe('invariant 3: no agent-specific catches in source', () => {
  // Patterns that indicate an agent-specific workaround in runner code
  const AGENT_SPECIFIC_PATTERNS = [
    // Catching by agent name/slug in error handling
    /catch.*ender/i,
    /catch.*pavel/i,
    /catch.*boris/i,
    // Hard-coded slug checks in error handling branches
    /if.*slug.*===.*["'`]/,
    /if.*agent.*slug.*===.*["'`]/,
  ];

  for (const pattern of AGENT_SPECIFIC_PATTERNS) {
    it(`no agent-specific catch matching ${pattern.source}`, () => {
      const allSource = readAll();
      expect(allSource).not.toMatch(pattern);
    });
  }
});

// ─── Architecture: no direct pg/postgres/drizzle-orm imports ─────────────────

describe('architecture: runner does not import db drivers directly', () => {
  it('source files do not import postgres directly (only via @nodal-agents/db)', () => {
    const violations = sourceFiles.filter((f) => {
      const content = readFileSync(f, 'utf-8');
      // Allow imports of @nodal-agents/db — ban direct 'postgres', 'drizzle-orm'
      return (
        content.includes("from 'postgres'") ||
        content.includes('from "postgres"') ||
        content.includes("from 'drizzle-orm'") ||
        content.includes('from "drizzle-orm"')
      );
    });

    expect(violations).toHaveLength(0);
  });
});
