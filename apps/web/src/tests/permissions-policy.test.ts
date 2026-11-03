// permissions-policy.test.ts — le tableau de bord a le droit d'ouvrir SON micro (#942).
//
// L'en-tête `Permissions-Policy` portait `microphone=()` : le micro refusé à
// tout document, le tableau de bord compris. Chrome bloquait `getUserMedia`
// avant même de poser la question à la personne, et le push-to-talk du chat
// ne pouvait rien entendre. La règle juste : permis à l'origine du tableau de
// bord (`self`), à aucun cadre d'une autre origine ; caméra et position
// restent fermées. Lu sur la VRAIE configuration de Next, telle qu'elle sert
// les en-têtes.

import { describe, it, expect } from 'vitest';
import type { NextConfig } from 'next';

// Chargée à l'exécution, par un chemin que `tsc` ne suit pas : `next.config.ts`
// est hors du programme typé de l'app (tsconfig `include`), et ses types de
// webpack ne sont pas une dépendance du web.
const CONFIG_PATH = '../../next.config.ts';

describe('the dashboard may open its own microphone (#942) @cap:parler-a-un-agent/ecran', () => {
  it('Permissions-Policy allows the microphone to self only, camera and location stay closed', async () => {
    const mod = (await import(/* @vite-ignore */ CONFIG_PATH)) as {
      default: (phase: string) => NextConfig;
    };
    const config = mod.default('phase-production-server');
    const rules = (await config.headers?.()) ?? [];
    const policies = rules.flatMap((r) =>
      r.headers.filter((h) => h.key === 'Permissions-Policy').map((h) => [r.source, h.value]),
    );
    expect(policies).toEqual([['/:path*', 'camera=(), microphone=(self), geolocation=()']]);
  });
});
