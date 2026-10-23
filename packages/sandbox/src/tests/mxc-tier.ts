// mxc-tier.ts — le palier d'isolation que MXC annonce sur CETTE machine, lu une
// fois pour les suites Windows (windows-mxc, sandbox-proxy-windows,
// deny-data-dir).
//
// `getPlatformSupport()` lance `wxc-exec --probe` (5 s au plus) puis GARDE sa
// réponse pour la vie du module. Si la sonde échoue ou dépasse son délai (une
// machine chargée), le SDK laisse `isolationTier` absent, sans le dire : le
// palier est alors INDÉTERMINÉ, et le produit le dit tel quel
// (`isolationTier=unknown`, SANDBOX_PLATFORM_UNSUPPORTED). CI Windows, run
// 39796089254, 1re tentative : trois suites ont attendu `isolationTier=undefined`
// (le `String(undefined)` du test) là où le produit répondait `unknown`.
//
// Un palier indéterminé n'est pas « un palier autre que base-container » : les
// preuves sur une vraie machine se sautent sur tout palier qui n'est pas
// `base-container`, et prendre l'inconnu pour un autre palier ferait passer le
// paquet au vert sans qu'aucun conteneur s'ouvre (revue de #859, passe 2 ;
// invariant #4). Sous Windows, ce module LÈVE à l'import quand le palier est
// illisible : toute suite qui en dépend échoue, avec ce que le SDK a dit.
//
// Une suite qui exige un palier le nomme dans son titre (`runIf`) et se saute
// dessus, nommément; une suite qui affirme le verdict du produit pour CE
// palier affirme `tierLabel`, le mot que le produit écrit pour lui.

import type { IsolationTier } from '@microsoft/mxc-sdk/v1';
import { unreadableTierError } from '@nodal-agents/test-kit';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const isWindows = process.platform === 'win32';

/** Ce que la réponse du SDK doit porter pour qu'un palier en sorte. */
export interface TierSupport {
  isSupported: boolean;
  reason?: string;
  isolationTier?: IsolationTier;
}

/** Le palier d'une réponse du SDK ; une réponse sans palier LÈVE, elle ne devient pas `undefined`. */
export function tierOf(support: TierSupport): IsolationTier {
  if (support.isolationTier === undefined) {
    throw unreadableTierError(
      `isSupported=${String(support.isSupported)}, reason=${JSON.stringify(support.reason ?? '')}` +
        ' (wxc-exec --probe failed or timed out; the SDK keeps that answer for the life of the process)',
    );
  }
  return support.isolationTier;
}

/** Le palier que le SDK annonce MAINTENANT (sa réponse en cache, ou sa sonde si le cache est vide). */
export async function readMxcTier(): Promise<IsolationTier> {
  return tierOf((await import('@microsoft/mxc-sdk/v1')).getPlatformSupport());
}

/** Le palier de CETTE machine ; `undefined` hors Windows seulement. Un palier illisible lève à l'import. */
export const tier: IsolationTier | undefined = isWindows ? await readMxcTier() : undefined;

/** Ce que le produit écrit après `isolationTier=` pour un palier absent (windows-mxc.ts, la sonde). */
export const tierLabel = (t: string | undefined): string => t ?? 'unknown';

/**
 * Rend la sonde native du SDK illisible (comme `wxc-exec --probe` qui dépasse
 * son délai) et vide son cache ; rend la fonction qui remet la vraie sonde. Les
 * crochets de test du SDK (`_setProbeRunner`, `_resetPlatformSupportCache`) ne
 * sont pas dans son index public : on les prend dans son fichier, qui est le
 * même module que celui du produit. Seul endroit du dépôt qui les touche.
 */
export async function forceUnreadableProbe(): Promise<() => void> {
  const dir = dirname(createRequire(import.meta.url).resolve('@microsoft/mxc-sdk/package.json'));
  const platform = (await import(pathToFileURL(join(dir, 'dist', 'v1', 'platform.js')).href)) as {
    _setProbeRunner: (runner?: () => string) => void;
    _resetPlatformSupportCache: () => void;
  };
  platform._resetPlatformSupportCache();
  platform._setProbeRunner(() => {
    throw new Error('wxc-exec --probe: timed out after 5000 ms');
  });
  return () => {
    // Le SDK reprend sa vraie sonde, et la sienne seule.
    platform._setProbeRunner(undefined);
    platform._resetPlatformSupportCache();
  };
}
