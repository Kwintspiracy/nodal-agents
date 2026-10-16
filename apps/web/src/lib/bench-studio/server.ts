// lib/bench-studio/server.ts — les gardes de Bench Studio, côté page et côté route.

import 'server-only';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createStudioRuntime, type StudioRuntime } from '@nodal-agents/bench/studio';
import { STUDIO_CSRF_ENV, STUDIO_CSRF_HEADER, STUDIO_GATE_HEADER, studioRefusal } from './guard';

/** Une page du studio : hors du studio, elle n'existe pas. */
export async function assertStudioPage(): Promise<void> {
  const h = await headers();
  const why = studioRefusal(process.env, {
    gateHeader: h.get(STUDIO_GATE_HEADER),
    method: 'GET',
    csrfHeader: null,
  });
  if (why !== null) notFound();
}

/** Une route du studio : null quand elle sert, sinon la réponse de refus. */
export function studioRouteRefusal(req: Request): Response | null {
  const why = studioRefusal(process.env, {
    gateHeader: req.headers.get(STUDIO_GATE_HEADER),
    method: req.method,
    csrfHeader: req.headers.get(STUDIO_CSRF_HEADER),
  });
  if (why === null) return null;
  return Response.json({ error: why }, { status: why === 'studio_no_csrf_token' ? 403 : 404 });
}

/**
 * Le jeton anti-CSRF que les pages du studio renvoient sur chaque requête qui
 * change quelque chose. Seule une page du studio, rendue derrière le filtre,
 * le reçoit ; une page d'un autre site ne peut pas la lire.
 */
export function studioCsrfToken(): string {
  const token = process.env[STUDIO_CSRF_ENV] ?? '';
  if (token.length < 32)
    throw new Error(
      `studio_no_csrf_token: ${STUDIO_CSRF_ENV} is not set; start with pnpm bench:studio`,
    );
  return token;
}

/**
 * L'unique runtime du processus : les lancements en cours y vivent. Gardé sur
 * globalThis parce que le serveur de dev réévalue les modules d'une route à
 * l'autre ; deux instances perdraient le fil d'un lancement.
 */
export function studioRuntime(): StudioRuntime {
  const g = globalThis as typeof globalThis & { __nodalBenchStudio?: StudioRuntime };
  g.__nodalBenchStudio ??= createStudioRuntime();
  return g.__nodalBenchStudio;
}

/** Une erreur du banc, rendue telle quelle : son code et son message, jamais avalés. */
export function studioError(e: unknown, status = 400): Response {
  return Response.json({ error: String(e instanceof Error ? e.message : e) }, { status });
}
