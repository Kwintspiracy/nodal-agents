// lib/bench-studio/guard.ts — une page ou une route de Bench Studio sert-elle cette requête ?
//
// Bench Studio (`pnpm bench:studio`, scripts/bench-studio.mjs) est l'outil
// LOCAL du propriétaire, et il lance des essais : ses routes ne servent QUE
// derrière le filtre de son serveur, qui n'écoute que sur 127.0.0.1, refuse
// toute adresse, tout Host et toute origine qui ne sont pas les siens, et pose
// sur chaque requête admise un jeton tiré au démarrage. Ici, les mêmes
// conditions, tenues une seconde fois par les routes elles-mêmes :
//   - le mode studio (NODAL_BENCH_STUDIO=1) ET le jeton du filtre : un
//     `next dev` lancé à la main en mode studio, même lié au réseau, n'a pas
//     le jeton, tout est refusé ;
//   - une requête qui change quelque chose (autre que GET/HEAD) porte en plus
//     le jeton anti-CSRF que la PAGE a reçu du studio (`x-bench-studio-csrf`).
//     Le filtre ne le pose jamais : une autre page du navigateur ne peut pas
//     l'envoyer sans un pré-vol CORS que le studio n'accorde pas.

import { timingSafeEqual } from 'node:crypto';

export const STUDIO_ENV = 'NODAL_BENCH_STUDIO';
export const STUDIO_GATE_ENV = 'NODAL_BENCH_STUDIO_GATE';
export const STUDIO_GATE_HEADER = 'x-bench-studio-gate';
export const STUDIO_CSRF_ENV = 'NODAL_BENCH_STUDIO_CSRF';
export const STUDIO_CSRF_HEADER = 'x-bench-studio-csrf';

export type StudioRefusal =
  | 'studio_off'
  | 'studio_no_gate'
  | 'studio_not_behind_filter'
  | 'studio_no_csrf_token';

const SAFE_METHODS = new Set(['GET', 'HEAD']);

function same(sent: string | null, want: string): boolean {
  const a = Buffer.from(sent ?? '');
  const b = Buffer.from(want);
  return want.length >= 32 && a.length === b.length && timingSafeEqual(a, b);
}

/** null : la requête est servie ; sinon, pourquoi pas. */
export function studioRefusal(
  env: Readonly<Record<string, string | undefined>>,
  req: { gateHeader: string | null; method: string; csrfHeader: string | null },
): StudioRefusal | null {
  if (env[STUDIO_ENV] !== '1') return 'studio_off';
  const gate = env[STUDIO_GATE_ENV] ?? '';
  if (gate.length < 32) return 'studio_no_gate';
  if (!same(req.gateHeader, gate)) return 'studio_not_behind_filter';
  if (
    !SAFE_METHODS.has(req.method.toUpperCase()) &&
    !same(req.csrfHeader, env[STUDIO_CSRF_ENV] ?? '')
  )
    return 'studio_no_csrf_token';
  return null;
}
