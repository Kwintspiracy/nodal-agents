// embedded-postgres-binaries.ts — la base embarquée est-elle réellement
// installée ? (issue #247)
//
// Les npm récents refusent d'exécuter les scripts d'installation d'un paquet
// que la personne n'a pas approuvé :
//
//   npm warn allow-scripts 4 packages have install scripts not yet covered by
//   allowScripts:
//   npm warn allow-scripts   @embedded-postgres/windows-x64@18.3.0-beta.17
//   ...
//   npm warn allow-scripts Run npm approve-scripts <pkg> to allow.
//
// Sur les quatre paquets listés à l'installation de `nodal-agents`, un seul
// compte : `@embedded-postgres/<plateforme>` prépare les binaires Postgres que
// Nodal démarre. Quand son script est sauté, `up` n'a rien à démarrer — et
// l'erreur qui sort aujourd'hui vient du postmaster, trois couches plus bas,
// sans jamais nommer la porte qui a mordu.
//
// CE QUE LE SCRIPT FAIT VRAIMENT, lu dans le paquet PUBLIÉ plutôt que supposé.
// Son `postinstall` est `node scripts/hydrate-symlinks.js`, qui relit
// `native/pg-symlinks.json` et recrée les liens qu'un tarball npm ne peut pas
// transporter. Les binaires, eux, sont DANS le tarball. Mesuré sur le registre,
// `npm pack <paquet>@18.3.0-beta.17 --dry-run --json` :
//
//   @embedded-postgres/windows-x64 : 1502 fichiers, 109 Mo décompressés, dont
//     native/bin/postgres.exe (10 230 272 o), native/bin/pg_ctl.exe (130 560 o),
//     native/bin/initdb.exe (243 712 o) et 95 fichiers sous native/lib.
//     native/pg-symlinks.json y pèse 2 OCTETS — c'est `[]`.
//   @embedded-postgres/linux-x64 : le même manifeste y pèse 1100 octets.
//
// Donc :
//
//   · macOS et Linux : le manifeste porte 17 et 14 liens (libpq, libcrypto,
//     libicu…). Script sauté = liens absents = le postmaster ne charge pas ses
//     bibliothèques. La porte npm se voit.
//   · Windows : le manifeste est VIDE et les exécutables sont livrés. Le script
//     n'y crée RIEN, donc la porte npm n'y casse rien et n'y laisse aucune
//     trace. On ne peut pas l'y détecter, et prétendre le contraire serait un
//     diagnostic inventé (invariant #4). Si `up` échoue quand même sur Windows
//     après un `npm warn allow-scripts`, la cause est ailleurs : il faut la
//     sortie réelle de la commande, pas cette hypothèse.
//
// D'où deux constats distincts, jamais fusionnés : des liens promis et absents
// (la porte, avec certitude), et des binaires absents (installation
// incomplète, cause à vérifier). Les deux nomment le paquet et la commande.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Un lien que `hydrate-symlinks.js` recrée, tel que le manifeste l'écrit. */
export interface SymlinkEntry {
  /** Le fichier réel, relatif à la racine du paquet. */
  readonly source: string;
  /** Le lien à créer, relatif à la racine du paquet. C'est lui qui manque. */
  readonly target: string;
}

/** Les trois exécutables que `@embedded-postgres/<plateforme>` expose. */
export interface PlatformBinaries {
  readonly pg_ctl: string;
  readonly initdb: string;
  readonly postgres: string;
}

export type BinariesFault =
  /** Aucun paquet `@embedded-postgres` ne couvre ce couple plateforme/arch. */
  | 'UNSUPPORTED_PLATFORM'
  /** Le paquet lui-même est introuvable : l'installation n'a pas abouti. */
  | 'PACKAGE_MISSING'
  /** Le paquet est là, un binaire manque. */
  | 'BINARIES_MISSING'
  /** Le paquet est là, les binaires aussi, les liens promis manquent. */
  | 'HYDRATION_SKIPPED';

export type BinariesVerdict =
  | { readonly ok: true; readonly packageName: string }
  | {
      readonly ok: false;
      readonly reason: BinariesFault;
      /** Null seulement pour une plateforme sans paquet. */
      readonly packageName: string | null;
      /** Ce qui manque, chemins absolus, dans l'ordre où on les a cherchés. */
      readonly missing: readonly string[];
      /** Ce que la personne lit. En anglais, comme toute la copie produit. */
      readonly message: string;
    };

/**
 * Le paquet de binaires qu'il faut sur CETTE machine.
 *
 * La table est recopiée de `embedded-postgres/dist/binary.js` (18.3.0-beta.17),
 * qui fait exactement ce `switch` pour choisir son import. La recopier plutôt
 * que d'appeler ce module laisse la réponse disponible sans charger quoi que ce
 * soit — c'est ce qui permet de NOMMER le paquet même quand il est absent.
 */
export function embeddedPostgresPackageName(platform: string, arch: string): string | null {
  const scope = '@embedded-postgres/';
  if (platform === 'darwin') {
    if (arch === 'arm64') return `${scope}darwin-arm64`;
    if (arch === 'x64') return `${scope}darwin-x64`;
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'arm64') return `${scope}linux-arm64`;
    if (arch === 'arm') return `${scope}linux-arm`;
    if (arch === 'ia32') return `${scope}linux-ia32`;
    if (arch === 'ppc64') return `${scope}linux-ppc64`;
    if (arch === 'x64') return `${scope}linux-x64`;
    return null;
  }
  if (platform === 'win32') {
    return arch === 'x64' ? `${scope}windows-x64` : null;
  }
  return null;
}

/** Ce qu'une lecture du disque a trouvé. Tout est injecté, rien n'est deviné. */
export interface BinariesReading {
  /** Le paquet attendu, ou null quand la plateforme n'en a aucun. */
  readonly packageName: string | null;
  /** Les trois chemins que le paquet expose, ou null s'il est introuvable. */
  readonly binaries: PlatformBinaries | null;
  /** La racine du paquet, ou null s'il est introuvable. */
  readonly packageDir: string | null;
  /**
   * Le manifeste des liens, ou null quand il n'a pas pu être lu. Illisible est
   * traité comme vide : sur Windows il l'est déjà, et refuser de démarrer sur
   * un fichier qu'un paquet futur pourrait ne plus écrire serait un faux rouge.
   */
  readonly symlinks: readonly SymlinkEntry[] | null;
  /** `existsSync` en production ; une table en test. */
  readonly exists: (path: string) => boolean;
}

/**
 * « 1 library link … was », « 14 library links … were ». Le pluriel est écrit
 * plutôt que subi : la phrase est ce que la personne lit, et une faute d'accord
 * dans un message d'installation donne l'air d'une erreur de plus.
 */
function count(n: number, singular: string, plural: string): string {
  return `${String(n)} ${n === 1 ? singular : plural}`;
}

/** Les deux commandes à taper, identiques dans les deux constats. */
function remedy(packageName: string): string {
  return `  npm approve-scripts ${packageName}\n  npm install -g nodal-agents@latest`;
}

/**
 * Le verdict, sans aucune entrée/sortie : c'est la règle qui est testée.
 */
export function inspectEmbeddedPostgres(reading: BinariesReading): BinariesVerdict {
  const { packageName, binaries, packageDir, exists } = reading;

  if (packageName === null) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_PLATFORM',
      packageName: null,
      missing: [],
      // AUCUN geste de contournement n'est proposé, parce qu'il n'en existe
      // aucun : `buildDatabaseUrl` construit toujours l'URL de la base
      // embarquée, `up` n'a pas de mode « Postgres externe », et inventer un
      // réglage serait pire que de ne rien dire (constat de revue, passe 1).
      message:
        'Nodal has no embedded Postgres build for this platform, so it cannot start its database here.\n' +
        'Supported: macOS (arm64, x64), Linux (x64, arm64, arm, ia32, ppc64), Windows (x64).\n' +
        'If you need this one, please open an issue: https://github.com/Kwintspiracy/nodal-agents/issues',
    };
  }

  if (binaries === null || packageDir === null) {
    return {
      ok: false,
      reason: 'PACKAGE_MISSING',
      packageName,
      missing: [],
      message:
        `Embedded Postgres cannot start: ${packageName} is not installed, so Nodal has no database binaries.\n` +
        'Install again, and if npm printed an allow-scripts warning, approve that one package first:\n\n' +
        remedy(packageName) +
        '\n\nIt prepares the database binaries and nothing else. The other packages npm lists can stay unapproved.',
    };
  }

  const missingBinaries = [binaries.pg_ctl, binaries.initdb, binaries.postgres].filter(
    (path) => !exists(path),
  );
  if (missingBinaries.length > 0) {
    return {
      ok: false,
      reason: 'BINARIES_MISSING',
      packageName,
      missing: missingBinaries,
      message:
        `Embedded Postgres cannot start: ${count(missingBinaries.length, 'of its binaries is', 'of its binaries are')} missing from ${packageName}.\n` +
        `Missing: ${missingBinaries.join(', ')}\n` +
        'The install did not finish. Install again, and if npm printed an allow-scripts warning, approve that one package first:\n\n' +
        remedy(packageName) +
        '\n\nIt prepares the database binaries and nothing else. The other packages npm lists can stay unapproved.',
    };
  }

  const missingLinks = (reading.symlinks ?? [])
    .map((entry) => join(packageDir, entry.target))
    .filter((path) => !exists(path));
  if (missingLinks.length > 0) {
    return {
      ok: false,
      reason: 'HYDRATION_SKIPPED',
      packageName,
      missing: missingLinks,
      message:
        `npm's install-script gate skipped ${packageName}, so ${count(missingLinks.length, 'library link the database needs was', 'library links the database needs were')} never created.\n` +
        'Approve that one package and install again:\n\n' +
        remedy(packageName) +
        '\n\nIt prepares the database binaries and nothing else. The other packages npm lists can stay unapproved.',
    };
  }

  return { ok: true, packageName };
}

/**
 * Lire le manifeste des liens. Absent, vide ou illisible donnent tous la liste
 * vide : sur Windows il vaut `[]` par construction.
 */
export function readSymlinkManifest(packageDir: string): readonly SymlinkEntry[] {
  try {
    const raw = readFileSync(join(packageDir, 'native', 'pg-symlinks.json'), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is SymlinkEntry =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { source?: unknown }).source === 'string' &&
        typeof (entry as { target?: unknown }).target === 'string',
    );
  } catch {
    return [];
  }
}

/**
 * Les trois chemins du paquet de plateforme, lus par le paquet lui-même.
 *
 * Même chemin que `resolvePgCtl` dans postgres.ts, et pour la même raison :
 * `embedded-postgres` n'exporte que `./dist/index.js`, donc `binary.js` se
 * charge PAR CHEMIN, à côté de l'entrée résolue. C'est ce module qui importe
 * `@embedded-postgres/<plateforme>` depuis SA propre position — indispensable
 * ici, où le paquet est une dépendance optionnelle que le dépôt pnpm ne hisse
 * pas jusqu'à `apps/cli/node_modules`.
 */
export async function loadPlatformBinaries(): Promise<PlatformBinaries | null> {
  try {
    const { createRequire } = await import('node:module');
    const { pathToFileURL } = await import('node:url');
    const require = createRequire(import.meta.url);
    const entry = require.resolve('embedded-postgres');
    const module = (await import(pathToFileURL(join(dirname(entry), 'binary.js')).href)) as {
      default?: () => Promise<Partial<PlatformBinaries>>;
    };
    const binaries = await module.default?.();
    if (
      binaries === undefined ||
      typeof binaries.pg_ctl !== 'string' ||
      typeof binaries.initdb !== 'string' ||
      typeof binaries.postgres !== 'string'
    ) {
      return null;
    }
    return { pg_ctl: binaries.pg_ctl, initdb: binaries.initdb, postgres: binaries.postgres };
  } catch {
    return null;
  }
}

/**
 * La racine du paquet de plateforme, déduite d'un de ses binaires.
 *
 * `<racine>/native/bin/pg_ctl[.exe]` : trois niveaux au-dessus. Déduite plutôt
 * que résolue par spécificateur parce que le paquet n'expose que `dist/index.js`
 * — `require.resolve('@embedded-postgres/windows-x64/package.json')` échoue sur
 * son champ `exports`.
 */
export function platformPackageDir(binaries: PlatformBinaries): string {
  return dirname(dirname(dirname(binaries.pg_ctl)));
}

/**
 * Le constat complet, disque compris. Appelé par `up` avant tout le reste.
 */
export async function probeEmbeddedPostgres(): Promise<BinariesVerdict> {
  const packageName = embeddedPostgresPackageName(process.platform, process.arch);
  if (packageName === null) {
    return inspectEmbeddedPostgres({
      packageName: null,
      binaries: null,
      packageDir: null,
      symlinks: null,
      exists: existsSync,
    });
  }
  const binaries = await loadPlatformBinaries();
  const packageDir = binaries === null ? null : platformPackageDir(binaries);
  return inspectEmbeddedPostgres({
    packageName,
    binaries,
    packageDir,
    symlinks: packageDir === null ? null : readSymlinkManifest(packageDir),
    exists: existsSync,
  });
}

/**
 * Le refus, en erreur, pour sortir par le chemin que `index.ts` a déjà (code de
 * sortie non nul). Nommée pour qu'un appelant la distingue d'une panne réelle.
 */
export class EmbeddedPostgresUnavailableError extends Error {
  readonly reason: BinariesFault;
  constructor(reason: BinariesFault, message: string) {
    super(message);
    this.name = 'EmbeddedPostgresUnavailableError';
    this.reason = reason;
  }
}
