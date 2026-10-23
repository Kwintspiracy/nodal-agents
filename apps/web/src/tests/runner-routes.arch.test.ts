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
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSourceFiles } from '@nodal-agents/test-kit';

const webRoot = join(fileURLToPath(import.meta.url), '..', '..', '..');
const runnerSrc = join(webRoot, '..', 'runner', 'src');

function sourceFiles(dir: string): string[] {
  return listSourceFiles(dir, {
    skipDirs: ['tests', '__tests__'],
    extensions: ['.ts', '.tsx'],
  }).filter((p) => !/\.test\.tsx?$/.test(p));
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
