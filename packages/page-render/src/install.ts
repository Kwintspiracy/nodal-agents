// install.ts — installer le moteur de rendu de pages, UNE fois, et dire où il
// en est (#1082).
//
// Décision du propriétaire (15-16/11/2026) : Nodal livre son propre moteur de
// rendu, `chrome-headless-shell` (Chrome for Testing sans fenêtre), téléchargé
// une fois au premier démarrage, comme Hermes-Agent installe son navigateur à
// l'installation, avec un moyen de le refuser. Ce module est le SEUL code qui
// installe, retire ou décrit ce moteur : le démarrage (`nodal-agents up`), la
// commande `nodal-agents renderer install`, la CI et les tests l'appellent
// tous, jamais une copie.
//
// OÙ. Sous le dossier de Nodal (`<NODALAI_HOME>/renderer`, ou
// `NODALAI_RENDERER_DIR`), jamais dans les dossiers du navigateur de la
// personne. Les commandes confinées des agents ne le lisent pas : c'est une
// entrée du dossier de Nodal, refusée au bac à sable comme les autres.
//
//   renderer/cache/…      le build, rangé par `@puppeteer/browsers`
//   renderer/installed.json  écrit APRÈS une installation vérifiée : le seul
//                         témoin qu'un build est utilisable
//   renderer/state.json   la dernière tentative : en cours (avec le pid et la
//                         progression), échouée (avec la raison), ou refusée
//                         (le réglage qui l'a refusée)
//   renderer/install.lock un seul installateur à la fois (création exclusive)
//
// ÉCHEC FORT (invariant #4) : hors ligne, une erreur de téléchargement ou de
// disque, une plateforme sans build — l'installation lève une erreur qui dit
// pourquoi, et l'écrit dans `state.json` ; l'outil de rendu la relit et la
// répète à l'agent, avec la commande pour installer plus tard. Jamais de repli
// sur le navigateur installé sur la machine.
//
// Ce module n'importe PAS `puppeteer-core` : le CLI le charge pour installer,
// sans le pilote.

import {
  Browser,
  BrowserPlatform,
  computeExecutablePath,
  detectBrowserPlatform,
  getInstalledBrowsers,
  install,
  uninstall,
} from '@puppeteer/browsers';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { nodalHome } from '@nodal-agents/shared/nodal-home';
import { RENDERER_ARCHIVE_SHA256, RENDERER_BUILD_ID } from './pin';

export { RENDERER_ARCHIVE_SHA256, RENDERER_BUILD_ID } from './pin';

/** La commande qui installe le moteur plus tard : dite dans chaque refus. */
export const RENDERER_INSTALL_COMMAND = 'nodal-agents renderer install';

/** La variable qui envoie le moteur ailleurs que sous le dossier de Nodal. */
export const RENDERER_DIR_ENV = 'NODALAI_RENDERER_DIR';

/**
 * Le dossier du moteur de rendu de CETTE instance : `NODALAI_RENDERER_DIR`
 * quand elle est posée (un moteur partagé par plusieurs dossiers de Nodal :
 * les campagnes du banc, la CI), sinon `<NODALAI_HOME>/renderer`. Une valeur
 * vide ou relative est refusée, comme pour les autres chemins de Nodal.
 *
 * Pas une entrée de `NODAL_HOME_OVERRIDES` : cette table est écrite dans le
 * registre des instances, que chaque version lit au format strict ; une
 * entrée de plus y ferait refuser le registre par les versions d'avant qui
 * tournent sur la même machine. Le moteur n'est pas une donnée à protéger
 * (c'est un programme publié par Google) : il n'a rien à y faire.
 */
export function rendererDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const raw = env[RENDERER_DIR_ENV];
  if (raw === undefined) return join(nodalHome(env), 'renderer');
  if (
    raw.trim() === '' ||
    !isAbsolute(raw) ||
    (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(raw))
  ) {
    throw new RendererInstallError(
      `${RENDERER_DIR_ENV} must be an absolute path, got "${raw}". Unset it to keep the page renderer under Nodal's folder.`,
    );
  }
  return resolve(raw);
}

/** Les plateformes pour lesquelles Google publie un `chrome-headless-shell`. */
const SUPPORTED: ReadonlySet<BrowserPlatform> = new Set([
  BrowserPlatform.WIN64,
  BrowserPlatform.WIN32,
  BrowserPlatform.MAC,
  BrowserPlatform.MAC_ARM,
  BrowserPlatform.LINUX,
]);

const BROWSER = Browser.CHROMEHEADLESSSHELL;

/** Le témoin d'une installation vérifiée. */
interface InstalledRecord {
  buildId: string;
  platform: string;
  executablePath: string;
  installedAt: string;
}

/** La dernière tentative, telle que `state.json` la garde. */
type StateRecord =
  | {
      status: 'installing';
      pid: number;
      buildId: string;
      startedAt: string;
      downloadedBytes?: number;
      totalBytes?: number;
    }
  | { status: 'failed'; buildId: string; reason: string; at: string }
  | { status: 'off'; how: string; at: string };

/** Ce que le moteur est, sur cette machine, pour le build épinglé. */
export type RendererStatus =
  | { kind: 'ready'; buildId: string; executablePath: string }
  | {
      kind: 'installing';
      pid: number;
      startedAt: string;
      downloadedBytes?: number;
      totalBytes?: number;
    }
  | { kind: 'failed'; reason: string; at: string }
  | { kind: 'off'; how: string; at: string }
  | { kind: 'missing'; detail: string };

/** Une installation qui n'a pas abouti ; le message dit pourquoi. */
export class RendererInstallError extends Error {
  readonly code = 'RENDERER_INSTALL_FAILED';
  constructor(message: string) {
    super(message);
    this.name = 'RendererInstallError';
  }
}

function paths(dir: string) {
  return {
    cache: join(dir, 'cache'),
    installed: join(dir, 'installed.json'),
    state: join(dir, 'state.json'),
    lock: join(dir, 'install.lock'),
  };
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // Un fichier illisible n'est pas « absent » : il est dit tel quel.
    throw new RendererInstallError(
      `${path} cannot be read (${err instanceof Error ? err.message : String(err)}). ` +
        `Remove it, then run \`${RENDERER_INSTALL_COMMAND}\`.`,
    );
  }
}

/** Écrit `value` par un temporaire renommé : un lecteur ne voit jamais un JSON coupé. */
async function writeJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, path);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Une erreur en UNE ligne : elle est écrite dans l'état, et répétée à l'agent. */
function errorText(err: unknown): string {
  let text = String(err);
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    text =
      code !== undefined && !err.message.includes(code) ? `${code}: ${err.message}` : err.message;
  }
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

/** La plateforme de cette machine pour `chrome-headless-shell`, ou la raison de son absence. */
export function rendererPlatform(
  detected: BrowserPlatform | undefined = detectBrowserPlatform(),
): { ok: true; platform: BrowserPlatform } | { ok: false; reason: string } {
  if (detected === undefined || !SUPPORTED.has(detected)) {
    return {
      ok: false,
      reason:
        `Google publishes no chrome-headless-shell build for this platform ` +
        `(${process.platform}/${process.arch}${detected ? `, ${detected}` : ''}). ` +
        'Builds exist for Windows, macOS (Intel and Apple silicon) and Linux x64.',
    };
  }
  return { ok: true, platform: detected };
}

/**
 * Ce que le moteur est pour le build épinglé (`buildId`), lu sur le disque.
 * Ne lève que sur un fichier d'état illisible, nommé.
 */
export async function readRendererStatus(
  opts: { dir?: string; buildId?: string; platform?: BrowserPlatform } = {},
): Promise<RendererStatus> {
  const dir = opts.dir ?? rendererDir();
  const buildId = opts.buildId ?? RENDERER_BUILD_ID;
  const p = paths(dir);
  const installed = await readJson<InstalledRecord>(p.installed);
  if (installed !== null && installed.buildId === buildId) {
    if (existsSync(installed.executablePath)) {
      return { kind: 'ready', buildId, executablePath: installed.executablePath };
    }
    return {
      kind: 'failed',
      reason: `the installed files are missing (${installed.executablePath} does not exist)`,
      at: installed.installedAt,
    };
  }
  const state = await readJson<StateRecord>(p.state);
  if (state?.status === 'installing') {
    if (isAlive(state.pid)) {
      return {
        kind: 'installing',
        pid: state.pid,
        startedAt: state.startedAt,
        ...(state.downloadedBytes !== undefined ? { downloadedBytes: state.downloadedBytes } : {}),
        ...(state.totalBytes !== undefined ? { totalBytes: state.totalBytes } : {}),
      };
    }
    return {
      kind: 'failed',
      reason: `the install started at ${state.startedAt} was interrupted (process ${state.pid} ended before it finished)`,
      at: state.startedAt,
    };
  }
  if (state?.status === 'failed' && state.buildId === buildId) {
    return { kind: 'failed', reason: state.reason, at: state.at };
  }
  if (state?.status === 'off') return { kind: 'off', how: state.how, at: state.at };
  if (installed !== null) {
    return {
      kind: 'missing',
      detail:
        `build ${installed.buildId} is installed and this version of Nodal renders with ` +
        `${buildId}; the next start installs it`,
    };
  }
  return { kind: 'missing', detail: 'no install has run on this machine yet' };
}

/**
 * Note qu'au démarrage l'installation a été refusée par un réglage (`how` le
 * nomme), pour que l'outil le dise. Ne touche à rien d'installé : un moteur
 * déjà là reste utilisable.
 */
export async function recordInstallTurnedOff(how: string, opts: { dir?: string } = {}) {
  const dir = opts.dir ?? rendererDir();
  await mkdir(dir, { recursive: true });
  const current = await readJson<StateRecord>(paths(dir).state);
  if (current?.status === 'installing' && isAlive(current.pid)) return;
  await writeJson(paths(dir).state, {
    status: 'off',
    how,
    at: new Date().toISOString(),
  } satisfies StateRecord);
}

export interface InstallRendererOptions {
  /** Le dossier du moteur ; par défaut celui de l'instance (`rendererDir`). */
  dir?: string;
  /** Le build à installer ; par défaut l'épinglé. Les tests en changent. */
  buildId?: string;
  /** L'hôte des builds (`@puppeteer/browsers`) ; par défaut celui de Google. */
  baseUrl?: string;
  /** La plateforme ; par défaut celle de la machine. */
  platform?: BrowserPlatform;
  /**
   * L'empreinte SHA-256 attendue de l'archive. Par défaut, celle que
   * `RENDERER_ARCHIVE_SHA256` épingle pour le build épinglé ; un autre build
   * (les tests) doit donner la sienne : rien ne s'installe sans empreinte.
   */
  sha256?: string;
  /** Appelé pendant le téléchargement. */
  onProgress?: (p: { downloadedBytes: number; totalBytes: number }) => void;
}

export type InstallRendererOutcome =
  | {
      kind: 'installed' | 'already-installed';
      buildId: string;
      executablePath: string;
      /** Les builds retirés parce qu'ils n'étaient plus l'épinglé. */
      removed: string[];
    }
  | { kind: 'busy'; pid: number; startedAt: string };

/** Prend le verrou de l'installateur, ou rend le pid qui le tient. */
async function takeLock(lock: string): Promise<{ ok: true } | { ok: false; pid: number }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return { ok: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const held = Number((await readFile(lock, 'utf8').catch(() => '')).trim());
      if (Number.isInteger(held) && held > 0 && held !== process.pid && isAlive(held)) {
        return { ok: false, pid: held };
      }
      // Un verrou laissé par un installateur mort : retiré, puis repris.
      await rm(lock, { force: true });
    }
  }
  throw new RendererInstallError(`${lock} could not be taken: another installer keeps creating it`);
}

/** Retire chaque build installé qui n'est pas `keep`. Rend leurs numéros. */
async function removeOtherBuilds(cache: string, keep: string): Promise<string[]> {
  if (!existsSync(cache)) return [];
  const removed: string[] = [];
  for (const b of await getInstalledBrowsers({ cacheDir: cache })) {
    if (b.browser !== BROWSER || b.buildId === keep) continue;
    await uninstall({
      browser: BROWSER,
      buildId: b.buildId,
      platform: b.platform,
      cacheDir: cache,
    });
    removed.push(b.buildId);
  }
  return removed;
}

/**
 * Installe le build épinglé s'il ne l'est pas, retire les autres, et écrit le
 * témoin. Un autre installateur en cours : rend `busy`, sans attendre. Lève
 * `RendererInstallError` (la raison est aussi écrite dans `state.json`).
 */
export async function installRenderer(
  opts: InstallRendererOptions = {},
): Promise<InstallRendererOutcome> {
  const dir = opts.dir ?? rendererDir();
  const buildId = opts.buildId ?? RENDERER_BUILD_ID;
  const p = paths(dir);
  const fail = async (reason: string): Promise<never> => {
    await writeJson(p.state, {
      status: 'failed',
      buildId,
      reason,
      at: new Date().toISOString(),
    } satisfies StateRecord).catch(() => undefined);
    throw new RendererInstallError(reason);
  };

  try {
    await mkdir(p.cache, { recursive: true });
  } catch (err) {
    throw new RendererInstallError(`${dir} cannot be created (${errorText(err)})`);
  }
  const resolved = rendererPlatform(opts.platform ?? detectBrowserPlatform());
  if (!resolved.ok) return fail(resolved.reason);
  const sha256 =
    opts.sha256 ??
    (buildId === RENDERER_BUILD_ID ? RENDERER_ARCHIVE_SHA256[resolved.platform] : undefined);
  if (sha256 === undefined) {
    return fail(
      `no SHA-256 is pinned for chrome-headless-shell ${buildId} on ${resolved.platform}`,
    );
  }

  const lock = await takeLock(p.lock);
  if (!lock.ok) {
    const state = await readJson<StateRecord>(p.state);
    return {
      kind: 'busy',
      pid: lock.pid,
      startedAt: state?.status === 'installing' ? state.startedAt : 'unknown',
    };
  }
  try {
    const current = await readJson<InstalledRecord>(p.installed);
    if (current?.buildId === buildId && existsSync(current.executablePath)) {
      const removed = await removeOtherBuilds(p.cache, buildId);
      return {
        kind: 'already-installed',
        buildId,
        executablePath: current.executablePath,
        removed,
      };
    }
    const startedAt = new Date().toISOString();
    const state: Extract<StateRecord, { status: 'installing' }> = {
      status: 'installing',
      pid: process.pid,
      buildId,
      startedAt,
    };
    await writeJson(p.state, state);
    // Un dossier de ce build SANS témoin est un dépaquetage interrompu : il est
    // retiré, sans quoi `install` le prendrait pour une installation finie.
    const target = { browser: BROWSER, buildId, platform: resolved.platform, cacheDir: p.cache };
    await uninstall(target).catch(() => undefined);
    await rm(p.installed, { force: true });

    let lastWrite = 0;
    let executablePath: string;
    try {
      const done = await install({
        ...target,
        ...(opts.baseUrl !== undefined ? { baseUrl: opts.baseUrl } : {}),
        expectedHash: sha256,
        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
          opts.onProgress?.({ downloadedBytes, totalBytes });
          const now = Date.now();
          if (now - lastWrite < 1000 && downloadedBytes < totalBytes) return;
          lastWrite = now;
          void writeJson(p.state, { ...state, downloadedBytes, totalBytes }).catch(() => undefined);
        },
      });
      executablePath = done.executablePath;
    } catch (err) {
      await uninstall(target).catch(() => undefined);
      return await fail(
        `downloading chrome-headless-shell ${buildId} for ${resolved.platform} failed (${errorText(err)})`,
      );
    }
    const expected = computeExecutablePath(target);
    if (!existsSync(executablePath) || executablePath !== expected) {
      return await fail(
        `chrome-headless-shell ${buildId} was unpacked, but its program is not at ${expected}`,
      );
    }
    const removed = await removeOtherBuilds(p.cache, buildId).catch(async (err: unknown) =>
      fail(`removing the previous build failed (${errorText(err)})`),
    );
    await writeJson(p.installed, {
      buildId,
      platform: resolved.platform,
      executablePath,
      installedAt: new Date().toISOString(),
    } satisfies InstalledRecord);
    await rm(p.state, { force: true });
    return { kind: 'installed', buildId, executablePath, removed };
  } finally {
    await rm(p.lock, { force: true });
  }
}
