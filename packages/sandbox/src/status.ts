// status.ts — le bac à sable est-il là, et sinon pourquoi.
//
// Sondé UNE fois par processus, à la première commande (ou au démarrage du
// runner, qui l'appelle pour que la raison apparaisse dans son journal dès
// le boot). La réponse est mise en cache : elle ne change pas tant que le
// processus vit.
//
// INDISPONIBLE ne veut jamais dire « silencieux » (invariant #4) : la raison
// est journalisée UNE fois, avec un code stable, et `getSandboxStatus()` la
// rend à qui la demande — c'est ce que le bandeau permanent de la décision
// D2 lira. Les commandes tournent alors comme avant ce bac à sable (la
// transition D2 : bandeau + double confirmation du Yolo viennent avec
// l'écran).

import { nodalDeniedEndpoints } from './policy';
import { startNodalProxy } from './proxy';
import { mxcBackend } from './windows-mxc';
import type { SandboxBackend, SandboxStatus } from './types';

/**
 * Le backend de ce système, ou `null` quand aucun n'existe encore. `env` :
 * l'environnement d'où se lisent les ports de l'instance de Nodal que le
 * réseau confiné ne doit pas joindre (`nodalDeniedEndpoints`), lu à
 * l'ouverture du premier conteneur.
 */
function platformBackend(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): SandboxBackend | null {
  if (platform === 'win32')
    return mxcBackend(undefined, undefined, undefined, () =>
      startNodalProxy(nodalDeniedEndpoints(env)),
    );
  // macOS (Seatbelt direct) et Linux (Landlock) : PR suivantes de #628.
  return null;
}

/** Ce que le moteur shell consomme : le statut, et le backend quand il est là. */
export interface Sandbox {
  status(): Promise<SandboxStatus>;
  readonly backend: SandboxBackend | null;
}

type Log = (code: string, fields: Record<string, unknown>) => void;
const defaultLog: Log = (code, fields) => {
  console.warn(`[sandbox] ${code}`, fields);
};

/**
 * Construit un bac à sable autour d'un backend. Exporté pour les tests (un
 * backend indisponible, un backend qui refuse de démarrer) ; le reste du
 * dépôt passe par `defaultSandbox()`.
 */
export function createSandbox(
  backend: SandboxBackend | null,
  opts: { platform?: NodeJS.Platform; log?: Log } = {},
): Sandbox {
  const log = opts.log ?? defaultLog;
  const platform = opts.platform ?? process.platform;
  let cached: Promise<SandboxStatus> | undefined;
  const status = (): Promise<SandboxStatus> =>
    (cached ??= (async (): Promise<SandboxStatus> => {
      const s: SandboxStatus = backend
        ? await backend.probe()
        : {
            state: 'unavailable',
            code: 'SANDBOX_NOT_IMPLEMENTED',
            reason: `no sandbox backend for platform ${platform} yet`,
          };
      if (s.state === 'available') {
        log('SANDBOX_ACTIVE', { backend: s.backend, ...(s.limits ? { limits: s.limits } : {}) });
      } else {
        log('SANDBOX_UNAVAILABLE', { code: s.code, reason: s.reason, platform });
      }
      return s;
    })());
  return { status, backend };
}

let processSandbox: Sandbox | undefined;

/** Le bac à sable de CE processus — un seul, sondé une fois. */
export function defaultSandbox(): Sandbox {
  return (processSandbox ??= createSandbox(platformBackend(process.platform, process.env)));
}

/**
 * Le bac à sable que le runner d'une AUTRE instance ouvrirait : le même
 * backend que `defaultSandbox`, les ports de Nodal lus dans `env` (PORT,
 * WEB_PORT, DATABASE_URL de cette instance) au lieu de l'environnement de ce
 * processus. Le banc y compte les imprimantes qu'une commande de l'instance de
 * sa campagne peut joindre (#794). Un appel, un bac à sable : l'appelant le
 * garde le temps qu'il lui faut.
 */
export function instanceSandbox(
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
): Sandbox {
  return createSandbox(platformBackend(platform, env), { platform });
}

/**
 * Le statut du bac à sable de ce processus : `available`, ou `unavailable`
 * AVEC son code et sa raison. Le point de lecture du bandeau (D2).
 */
export function getSandboxStatus(): Promise<SandboxStatus> {
  return defaultSandbox().status();
}
