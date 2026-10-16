// lib/bench-studio/server.ts — les gardes de Bench Studio, côté page et côté route.

import 'server-only';
import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createStudioRuntime, type StudioRuntime } from '@nodal-agents/bench/studio';
import { STUDIO_GATE_HEADER, studioRefusal } from './guard';

/** Une page du studio : hors du studio, elle n'existe pas. */
export async function assertStudioPage(): Promise<void> {
  const h = await headers();
  if (studioRefusal(process.env, h.get(STUDIO_GATE_HEADER)) !== null) notFound();
}

/** Une route du studio : null quand elle sert, sinon la réponse de refus. */
export function studioRouteRefusal(req: Request): Response | null {
  const why = studioRefusal(process.env, req.headers.get(STUDIO_GATE_HEADER));
  return why === null ? null : Response.json({ error: why }, { status: 404 });
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
