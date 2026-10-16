// runner-routes.arch.test.ts — every runner endpoint the dashboard calls is a
// route the runner actually serves.
//
// Pourquoi ce fichier existe : jusqu'au 16/10/2026, les deux actions
// d'appairage WhatsApp appelaient `/api/whatsapp-pairing`, alors que le runner
// sert `/api/whatsapp/pairing`. Chaque appairage depuis le tableau de bord
// prenait un 404, et les tests de l'action vérifiaient l'URL contre… la même
// faute : ils comparaient le web à lui-même, jamais au runner.
//
// La garde lit les deux côtés dans les SOURCES : chaque `${…RUNNER_URL}/…`
// du web (segments `${…}` lus comme paramètres), contre chaque
// `app.<méthode>('/…')` du runner (segments `:x` lus comme paramètres).

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const webRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const runnerSrc = join(webRoot, '..', 'runner', 'src');

const SKIP_DIRS = new Set(['node_modules', '.next', 'tests', '__tests__', 'test-results']);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** `/api/jobs/${x}/file-diff` and `/api/jobs/:jobId/file-diff` → the same key. */
const normalize = (path: string) =>
  path.replace(/\$\{[^}]*\}/g, ':param').replace(/:[A-Za-z_]\w*/g, ':param');

function webRunnerCalls(): { path: string; where: string }[] {
  const calls: { path: string; where: string }[] = [];
  for (const file of sourceFiles(join(webRoot, 'src'))) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/RUNNER_URL\}(\/[^`?]*)/g)) {
      const line = text.slice(0, m.index).split('\n').length;
      calls.push({ path: normalize(m[1]!), where: `${relative(webRoot, file)}:${line}` });
    }
  }
  return calls;
}

function runnerRoutes(): Set<string> {
  const routes = new Set<string>();
  for (const file of sourceFiles(runnerSrc)) {
    const text = readFileSync(file, 'utf-8');
    for (const m of text.matchAll(/\bapp\.(?:get|post|put|patch|delete|all)\(\s*'([^']+)'/g)) {
      routes.add(normalize(m[1]!));
    }
  }
  return routes;
}

describe('dashboard → runner routes @cap:parler-par-canal-externe/moteur', () => {
  it('every runner endpoint the web calls is served by the runner', () => {
    const calls = webRunnerCalls();
    const routes = runnerRoutes();

    // Not vacuous: both scans see the endpoints this guard was written for.
    expect(calls.map((c) => c.path)).toContain('/api/whatsapp/pairing');
    expect(calls.map((c) => c.path)).toContain('/api/skills/install');
    expect(routes.has('/api/whatsapp/pairing')).toBe(true);

    const unknown = calls.filter((c) => !routes.has(c.path)).map((c) => `${c.where} → ${c.path}`);
    expect(unknown, 'the runner serves no such route').toEqual([]);
  });
});
