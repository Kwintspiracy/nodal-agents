// lib/bench-studio/guard.ts — une page ou une route de Bench Studio sert-elle cette requête ?
//
// Bench Studio (`pnpm bench:studio`, scripts/bench-studio.mjs) est l'outil
// LOCAL du propriétaire, et il lance des essais : ses routes ne servent QUE
// derrière le filtre de son serveur, qui n'écoute que sur 127.0.0.1, refuse
// toute adresse et tout Host qui ne sont pas cette machine, et pose sur chaque
// requête admise un jeton tiré au démarrage. Ici, deux conditions, jamais une :
// le mode studio (NODAL_BENCH_STUDIO=1) ET ce jeton. Un `next dev` lancé à la
// main en mode studio, même lié au réseau, n'a pas le jeton : tout est refusé.

import { timingSafeEqual } from 'node:crypto';

export const STUDIO_ENV = 'NODAL_BENCH_STUDIO';
export const STUDIO_GATE_ENV = 'NODAL_BENCH_STUDIO_GATE';
export const STUDIO_GATE_HEADER = 'x-bench-studio-gate';

export type StudioRefusal = 'studio_off' | 'studio_no_gate' | 'studio_not_behind_filter';

/** null : la requête est servie ; sinon, pourquoi pas. */
export function studioRefusal(
  env: Readonly<Record<string, string | undefined>>,
  gateHeader: string | null,
): StudioRefusal | null {
  if (env[STUDIO_ENV] !== '1') return 'studio_off';
  const gate = env[STUDIO_GATE_ENV] ?? '';
  if (gate.length < 32) return 'studio_no_gate';
  const a = Buffer.from(gateHeader ?? '');
  const b = Buffer.from(gate);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'studio_not_behind_filter';
  return null;
}
