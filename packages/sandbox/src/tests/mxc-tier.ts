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
// (le `String(undefined)` du test) là où le produit répondait `unknown`; la 2e
// tentative, sur la même image, a lu `appcontainer-dacl`.
//
// Une suite qui exige un palier le nomme dans son titre (`runIf`) et se saute
// dessus, nommément; une suite qui affirme le verdict du produit pour CE
// palier affirme `tierLabel`, le mot que le produit écrit pour lui.

import type { IsolationTier } from '@microsoft/mxc-sdk/v1';

const isWindows = process.platform === 'win32';

/** Le palier annoncé ; `undefined` hors Windows, et quand la sonde du SDK n'a rien répondu. */
export const tier: IsolationTier | undefined = isWindows
  ? (await import('@microsoft/mxc-sdk/v1')).getPlatformSupport().isolationTier
  : undefined;

/** Ce que le produit écrit après `isolationTier=` pour ce palier (windows-mxc.ts, la sonde). */
export const tierLabel = (t: string | undefined): string => t ?? 'unknown';
