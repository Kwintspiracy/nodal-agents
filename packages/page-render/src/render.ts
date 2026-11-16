// render.ts — une page HTML en PDF, par le moteur de rendu de Nodal (#1082).
//
// RIEN N'APPARAÎT À L'ÉCRAN. `chrome-headless-shell` n'a pas de fenêtre : il
// n'a aucun code d'interface. Il est lancé avec SON profil, temporaire (retiré
// après l'appel), le rapport de plantage coupé, jamais le navigateur ni le
// profil de la personne. Le bac à sable de Chrome reste ACTIF : une plateforme
// qui ne peut pas le faire tourner (Linux en root, un Ubuntu qui restreint les
// espaces de noms) fait échouer l'appel en le disant, jamais un
// `--no-sandbox` posé en silence.
//
// UN PROCESSUS PAR APPEL, pas un navigateur partagé. Un rendu est rare (une
// poignée par tâche) et un lancement coûte quelques centaines de
// millisecondes ; un navigateur gardé vivant entre deux appels partagerait son
// cache et ses cookies entre agents et entre jobs, et serait un processus qui
// survit à l'appel. Chaque appel a donc son navigateur, son profil, son proxy,
// et une borne de temps ; à la fin, réussite, erreur ou dépassement, le
// navigateur est fermé, puis tué par son pid (`killProcessTree`) s'il vit
// encore, et l'appel vérifie que ce pid n'existe plus. Le runner tue à son
// arrêt ce qui tournerait encore (`closeAllRenderers`), et la sortie du
// processus aussi (`process.on('exit')`).
//
// LE RUNNER LANCE LE MOTEUR LUI-MÊME, pas par `run_command`. Ce qu'il ouvre
// est écrit par un agent : c'est le contenu le moins sûr qui soit. Il ne
// passe donc par aucune commande (aucune liste de commandes, aucune
// approbation de shell, aucun accès au système de la commande), et ce que la
// page peut atteindre est borné ICI, pour chaque requête :
//   - les fichiers : la page est servie depuis une origine qui n'existe pas
//     (`https://nodal-page.invalid/<chemin>`), dont CHAQUE requête est
//     interceptée et servie par `readLocal`, le périmètre de lecture de
//     l'appelant (celui de `file_read`). Chrome ne lit jamais le disque
//     lui-même : une adresse `file://` est refusée par Chrome depuis une
//     origine https, et notée comme non chargée ;
//   - le réseau : tout passe par le proxy de Nodal en mode `publicOnly`
//     (packages/sandbox/src/proxy.ts), qui ne joint que l'internet public —
//     jamais cette machine (le runner et le tableau de bord écoutent sur la
//     boucle locale), jamais une adresse privée, même par un nom qui s'y
//     résout. La boucle locale passe aussi par lui (`<-loopback>`), et Chrome
//     ne résout aucun nom lui-même (`--host-resolver-rules`). Une requête
//     http(s) est en plus classée avant de partir, pour que le résultat dise
//     ce qui n'a pas été chargé et pourquoi ;
//   - tout autre schéma est refusé.
// Le JavaScript de la page s'exécute (une mise en page peut en dépendre),
// dans le bac à sable de Chrome, sans rien de plus que ce qui précède.

import { mkdtemp, rm } from 'node:fs/promises';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, posix, win32 } from 'node:path';
import puppeteer, {
  type Browser,
  type HTTPRequest,
  type Page,
  type PDFOptions,
} from 'puppeteer-core';
import {
  isProcessAlive,
  isPublicAddress,
  killProcessTree,
  localAddresses,
  startNodalProxy,
  type NodalProxy,
} from '@nodal-agents/sandbox';
import { fitToPages, type ScaledRender } from './fit';
import { readPdfFacts, type PaperFacts, type PaperName } from './pdf-facts';

/**
 * L'échelle la plus petite à laquelle l'outil réduit une page pour la faire
 * tenir. 0,6 : le corps de texte par défaut d'une page web (16 px, soit 12 pt
 * à l'impression) y devient 7,2 pt, au-dessus des 6 pt que l'imprimerie tient
 * pour la plus petite taille lisible ; un texte de 12 px y fait 5,4 pt, déjà
 * la limite. Plus bas, un texte courant ne se lit plus : l'appel échoue alors
 * en disant combien de pages la page fait à cette échelle, et c'est à l'agent
 * (ou à la personne) de couper. Chrome accepte de 0,1 à 2.
 */
export const MIN_READABLE_SCALE = 0.6;

/** La borne de temps d'un appel entier : lancement, chargement et tous les rendus. */
export const RENDER_TIME_LIMIT_MS = 90_000;

/** Ce que la page charge au plus, par fichier local (le plafond de `file_read`). */
export const MAX_LOCAL_RESOURCE_BYTES = 50 * 1024 * 1024;

/** L'origine, inexistante, depuis laquelle la page et ses fichiers sont servis. */
export const PAGE_ORIGIN = 'https://nodal-page.invalid';

/** Les marges quand ni l'appel ni le CSS de la page n'en donnent (celles de l'impression de Chrome). */
const DEFAULT_MARGIN_MM = 10;

export interface Margins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Le papier demandé. Tout champ absent laisse décider le CSS `@page` de la page, puis A4. */
export interface PaperOptions {
  format?: PaperName;
  orientation?: 'portrait' | 'landscape';
  marginsMm?: Margins;
}

/** Ce que `readLocal` rend : les octets, ou la raison du refus. */
export type LocalRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: string };

export interface RenderPdfRequest {
  /** Le programme du moteur (`readRendererStatus` → `ready`). */
  executablePath: string;
  /** Le chemin ABSOLU de la page, déjà résolu par l'appelant. */
  source: string;
  /** Lit un fichier local par le périmètre de l'appelant. La page elle-même y passe aussi. */
  readLocal: (absPath: string) => Promise<LocalRead>;
  /** Le nombre de pages au plus ; absent : un rendu à l'échelle 1. */
  maxPages?: number;
  paper?: PaperOptions;
  timeoutMs?: number;
  minScale?: number;
}

/** Une ressource que la page demandait et qui n'a pas été chargée. */
export interface NotLoaded {
  url: string;
  reason: string;
}

export interface RenderPdfResult {
  pdf: Uint8Array;
  pages: number;
  scale: number;
  /** Les pages à l'échelle 1, pour dire ce que la réduction a gagné. */
  pagesAtFullScale: number;
  paper: PaperFacts;
  mixedSizes: boolean;
  notLoaded: NotLoaded[];
  /** Combien de rendus la recherche a faits. */
  renders: number;
  /** Le pid du navigateur de cet appel, mort à la sortie. */
  pid: number;
  /** Le profil temporaire de cet appel, retiré à la sortie. */
  profileDir: string;
}

export type PageRenderErrorCode =
  | 'DOES_NOT_FIT'
  | 'TIMEOUT'
  | 'SANDBOX_UNAVAILABLE'
  | 'MISSING_LIBRARY'
  | 'LAUNCH_FAILED'
  | 'PAGE_FAILED'
  | 'PROCESS_SURVIVED';

/** Un rendu qui n'a pas abouti ; le message dit pourquoi, et quoi faire. */
export class PageRenderError extends Error {
  constructor(
    readonly code: PageRenderErrorCode,
    message: string,
    readonly details: {
      pagesAtMinScale?: number;
      pagesAtFullScale?: number;
      /** Le pid du navigateur de l'appel, quand il a démarré : mort quand l'erreur arrive. */
      pid?: number;
      /** Le profil temporaire de l'appel : retiré quand l'erreur arrive. */
      profileDir?: string;
    } = {},
  ) {
    super(message);
    this.name = 'PageRenderError';
  }
}

// ─── Les navigateurs vivants ────────────────────────────────────────────────

const live = new Map<number, ChildProcess>();
let exitHooked = false;

/** Tue `pid` et son arbre SANS attendre : le seul geste possible dans `process.on('exit')`. */
function killNow(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* déjà mort */
    }
  }
}

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  process.once('exit', () => {
    for (const pid of live.keys()) killNow(pid);
  });
}

/** Les pids des navigateurs de rendu en cours dans ce processus. */
export function liveRendererPids(): number[] {
  return [...live.keys()];
}

/** Tue chaque navigateur de rendu encore en cours (l'arrêt du runner). */
export async function closeAllRenderers(): Promise<void> {
  await Promise.all(
    [...live.entries()].map(async ([pid, child]) => {
      await killProcessTree(pid, {
        backstop: () => child.kill('SIGKILL'),
        context: { what: 'page-renderer' },
      });
      live.delete(pid);
    }),
  );
}

async function waitGone(pid: number, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (isProcessAlive(pid)) {
    if (Date.now() > until) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
  return true;
}

// ─── Chemins ↔ adresses de l'origine de la page ─────────────────────────────

/** L'adresse, sur l'origine de la page, du fichier `absPath`. */
export function urlForPath(absPath: string, platform: NodeJS.Platform = process.platform): string {
  const slashed = platform === 'win32' ? absPath.replaceAll('\\', '/') : absPath;
  const segments = slashed.split('/').map((s) => encodeURIComponent(s));
  const joined = segments.join('/');
  return `${PAGE_ORIGIN}${joined.startsWith('/') ? '' : '/'}${joined}`;
}

/** Le fichier qu'une adresse de l'origine de la page désigne. */
export function pathForUrl(url: string, platform: NodeJS.Platform = process.platform): string {
  const { pathname } = new URL(url);
  const decoded = pathname
    .split('/')
    .map((s) => decodeURIComponent(s))
    .join('/');
  if (platform !== 'win32') return posix.normalize(decoded);
  // `/D:/a/b` → `D:\a\b` ; `///srv/share/x` (UNC) → `\\srv\share\x`.
  const bare = /^\/[A-Za-z]:\//.test(decoded)
    ? decoded.slice(1)
    : decoded.replace(/^\/(?=\/\/)/, '');
  return win32.normalize(bare);
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xhtml': 'application/xhtml+xml',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
};

/**
 * Le type d'un fichier servi. Une page HTML qui ne déclare pas son jeu de
 * caractères est servie en UTF-8 : c'est ce que les outils de fichier de Nodal
 * écrivent, et ce que Chrome ne devinerait pas toujours (accents).
 */
function contentTypeFor(path: string, bytes: Uint8Array): string {
  const type = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
  if (type !== 'text/html' && type !== 'text/css' && type !== 'text/plain') return type;
  const head = Buffer.from(bytes.subarray(0, 2048)).toString('latin1').toLowerCase();
  return head.includes('charset') ? type : `${type}; charset=utf-8`;
}

// ─── Le réseau ──────────────────────────────────────────────────────────────

/** Une requête http(s) peut-elle partir ? Le même classement que le proxy, dit à l'avance. */
async function networkVerdict(url: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return { ok: false, reason: 'not a valid address' };
  }
  let addrs: string[];
  if (isIP(host) !== 0) addrs = [host];
  else {
    try {
      addrs = (await lookup(host, { all: true })).map((r) => r.address);
    } catch {
      return { ok: false, reason: `the name ${host} does not resolve` };
    }
  }
  const locals = localAddresses();
  const blocked = addrs.find((a) => !isPublicAddress(a, locals));
  if (blocked !== undefined) {
    return {
      ok: false,
      reason: `${host} is a local or private address (${blocked}); the page renderer only loads the public internet`,
    };
  }
  return { ok: true };
}

// ─── Le lancement ───────────────────────────────────────────────────────────

/**
 * Ce que le lancement a dit, rendu en une erreur qui nomme la cause : une
 * bibliothèque système manquante (Linux), un bac à sable impossible, ou le
 * texte de Chrome tel quel.
 */
function launchFailure(err: unknown, chromeStderr = ''): PageRenderError {
  const text = `${err instanceof Error ? err.message : String(err)}\n${chromeStderr}`;
  const lib = /error while loading shared libraries: ([^\s:]+)/.exec(text);
  if (lib) {
    return new PageRenderError(
      'MISSING_LIBRARY',
      `Nodal's page renderer cannot start: the system library ${lib[1]} is missing. ` +
        'Install the package that provides it with the system package manager, then call again.',
    );
  }
  if (/No usable sandbox|setuid sandbox|namespace/i.test(text)) {
    return new PageRenderError(
      'SANDBOX_UNAVAILABLE',
      "Nodal's page renderer cannot start Chrome's sandbox on this system (" +
        firstLine(text) +
        '). On Ubuntu 23.10 and later, unprivileged user namespaces are restricted by AppArmor: ' +
        'allow them for this program, or set kernel.apparmor_restrict_unprivileged_userns=0. ' +
        'Nodal never turns the sandbox off.',
    );
  }
  const said = firstLine(chromeStderr);
  return new PageRenderError(
    'LAUNCH_FAILED',
    `Nodal's page renderer did not start: ${firstLine(err instanceof Error ? err.message : String(err))}` +
      (said.length > 0 ? ` (Chrome said: ${said})` : ''),
  );
}

/** La borne du lancement de diagnostic. */
const DIAGNOSIS_MS = 10_000;

/**
 * Ce que Chrome dit LUI-MÊME quand il meurt au lancement. Piloté par un tube,
 * il ne laisse à puppeteer que « Target closed » : la cause (le bac à sable,
 * une bibliothèque) est sur son stderr, que ce lancement-ci, direct et borné,
 * recueille. Appelé seulement après un lancement raté ; son processus est tué
 * par son pid s'il vit encore à la borne.
 */
async function chromeSays(
  executablePath: string,
  args: string[],
  profile: string,
): Promise<string> {
  return new Promise((resolve) => {
    let said = '';
    let child: ChildProcess;
    try {
      child = spawn(
        executablePath,
        [...args, `--user-data-dir=${profile}`, '--headless', '--dump-dom', 'about:blank'],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
          detached: process.platform !== 'win32',
        },
      );
    } catch (e) {
      resolve(e instanceof Error ? e.message : String(e));
      return;
    }
    child.stderr?.on('data', (d: Buffer) => {
      if (said.length < 8_000) said += String(d);
    });
    const timer = setTimeout(() => {
      void killProcessTree(child.pid, {
        backstop: () => child.kill('SIGKILL'),
        context: { what: 'page-renderer-diagnosis' },
      });
    }, DIAGNOSIS_MS);
    child.on('error', (e) => {
      said += `\n${e.message}`;
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(said);
    });
  });
}

function firstLine(text: string): string {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !/^TROUBLESHOOTING/i.test(l));
  return lines.slice(0, 3).join(' ').slice(0, 400);
}

/** Linux : Chrome refuse son bac à sable en root, et Nodal ne le coupe pas. */
function refuseRoot(): void {
  if (process.platform === 'linux' && process.getuid?.() === 0) {
    throw new PageRenderError(
      'SANDBOX_UNAVAILABLE',
      "Nodal's page renderer cannot run as root: Chrome's sandbox refuses to start as root, " +
        'and Nodal never turns it off. Run Nodal as a regular user.',
    );
  }
}

function chromeArgs(proxy: NodalProxy): string[] {
  return [
    `--proxy-server=${proxy.url}`,
    // Sans cette entrée, Chrome joint la boucle locale SANS le proxy.
    '--proxy-bypass-list=<-loopback>',
    // Chrome ne résout aucun nom lui-même : le proxy résout, et décide.
    '--host-resolver-rules=MAP * ~NOTFOUND',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-crash-reporter',
    '--disable-breakpad',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-domain-reliability',
    '--disable-sync',
    '--mute-audio',
    '--deny-permission-prompts',
  ];
}

function marginsCss(m: Margins): string {
  return `${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm`;
}

function pdfOptions(paper: PaperOptions, scale: number, timeout: number): PDFOptions {
  const explicitPaper = paper.format !== undefined || paper.orientation !== undefined;
  const m = paper.marginsMm;
  const margin = m ?? {
    top: DEFAULT_MARGIN_MM,
    right: DEFAULT_MARGIN_MM,
    bottom: DEFAULT_MARGIN_MM,
    left: DEFAULT_MARGIN_MM,
  };
  return {
    printBackground: true,
    scale,
    // Sans papier demandé, le `@page { size }` de la page décide ; A4 sinon.
    preferCSSPageSize: !explicitPaper,
    format: paper.format ?? 'A4',
    landscape: paper.orientation === 'landscape',
    margin: {
      top: `${margin.top}mm`,
      right: `${margin.right}mm`,
      bottom: `${margin.bottom}mm`,
      left: `${margin.left}mm`,
    },
    timeout,
  };
}

// ─── Le rendu ───────────────────────────────────────────────────────────────

/**
 * Rend `source` en PDF. Avec `maxPages`, cherche la plus grande échelle qui
 * tient (`fitToPages`). Lève `PageRenderError`, toujours après avoir fermé le
 * navigateur et vérifié que son pid n'existe plus.
 */
export async function renderPdf(req: RenderPdfRequest): Promise<RenderPdfResult> {
  refuseRoot();
  const timeoutMs = req.timeoutMs ?? RENDER_TIME_LIMIT_MS;
  const minScale = req.minScale ?? MIN_READABLE_SCALE;
  const paper = req.paper ?? {};
  const startedAt = Date.now();
  const remaining = (): number => Math.max(1_000, timeoutMs - (Date.now() - startedAt));
  const notLoaded: NotLoaded[] = [];
  const noted = new Set<string>();
  const note = (url: string, reason: string): void => {
    if (noted.has(url)) return;
    noted.add(url);
    notLoaded.push({ url: url.startsWith(PAGE_ORIGIN) ? pathForUrl(url) : url, reason });
  };

  const proxy = await startNodalProxy([], {}, { publicOnly: true });
  const profile = await mkdtemp(join(tmpdir(), 'nodal-page-render-'));
  let browser: Browser | undefined;
  let child: ChildProcess | null = null;
  let pid: number | undefined;
  let timer: NodeJS.Timeout | undefined;

  const work = async (): Promise<RenderPdfResult> => {
    try {
      browser = await puppeteer.launch({
        executablePath: req.executablePath,
        headless: 'shell',
        // Le protocole passe par un tube, jamais par un port : aucun autre
        // processus de la machine ne peut piloter ce navigateur.
        pipe: true,
        userDataDir: profile,
        args: chromeArgs(proxy),
        timeout: Math.min(30_000, remaining()),
        protocolTimeout: timeoutMs,
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
    } catch (err) {
      throw launchFailure(
        err,
        await chromeSays(req.executablePath, chromeArgs(proxy), join(profile, 'diagnosis')),
      );
    }
    child = browser.process();
    pid = child?.pid;
    if (pid !== undefined && child !== null) {
      hookExit();
      live.set(pid, child);
    }
    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (r) => void route(r, req, note));
    page.on('requestfailed', (r) => {
      const url = r.url();
      if (url.startsWith('http:') || url.startsWith('https:')) {
        if (!url.startsWith(PAGE_ORIGIN)) note(url, r.failure()?.errorText ?? 'failed');
      }
    });
    page.on('response', (r) => {
      if (r.status() >= 400) note(r.url(), `HTTP ${r.status()}`);
    });
    page.on('console', (m) => {
      const hit = /Not allowed to load local resource: (\S+)/.exec(m.text());
      if (hit?.[1]) {
        note(hit[1], 'a file:// address; refer to local files by a path relative to the page');
      }
    });
    const response = await page
      .goto(urlForPath(req.source), { waitUntil: 'load', timeout: remaining() })
      .catch((err: unknown) => {
        // Le chargement borné par le temps qui reste : son dépassement EST la borne de l'appel.
        if (err instanceof Error && err.name === 'TimeoutError') throw err;
        throw new PageRenderError(
          'PAGE_FAILED',
          `The page did not load: ${err instanceof Error ? firstLine(err.message) : String(err)}`,
        );
      });
    if (response !== null && !response.ok()) {
      const why = notLoaded.find((n) => n.url === req.source)?.reason;
      throw new PageRenderError(
        'PAGE_FAILED',
        `The page did not load${why !== undefined ? `: ${why}` : ` (HTTP ${response.status()})`}.`,
      );
    }
    if (paper.marginsMm !== undefined) {
      // Des marges DEMANDÉES l'emportent sur celles du CSS de la page.
      await page.addStyleTag({
        content: `@page { margin: ${marginsCss(paper.marginsMm)} !important; }`,
      });
    }
    if (paper.format !== undefined || paper.orientation !== undefined) {
      // Un papier DEMANDÉ l'emporte sur le `@page { size }` de la page.
      await page.addStyleTag({ content: '@page { size: auto !important; }' });
    }
    return renderAndFit(page, req, paper, minScale, remaining, notLoaded);
  };

  const timedOut = (): PageRenderError =>
    new PageRenderError(
      'TIMEOUT',
      `The page did not render within ${Math.round(timeoutMs / 1000)} s. A script that never ` +
        'ends, or a resource that never answers, holds it: nothing was written.',
    );
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timedOut()), timeoutMs);
  });

  let outcome: { ok: true; value: RenderPdfResult } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await Promise.race([work(), deadline]) };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
  const survived = await teardown(browser, child, pid);
  await Promise.all([
    proxy.close(),
    rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
      () => undefined,
    ),
  ]);
  const where = { ...(pid !== undefined ? { pid } : {}), profileDir: profile };
  if (survived) {
    throw new PageRenderError(
      'PROCESS_SURVIVED',
      `Nodal's page renderer (pid ${pid}) could not be stopped after this call.`,
      where,
    );
  }
  if (!outcome.ok) {
    const e = outcome.error;
    if (e instanceof PageRenderError) {
      throw new PageRenderError(e.code, e.message, { ...e.details, ...where });
    }
    // Une étape bornée par le temps qui restait (chargement, rendu) : la borne de l'appel.
    if (e instanceof Error && e.name === 'TimeoutError') {
      const t = timedOut();
      throw new PageRenderError(t.code, t.message, where);
    }
    throw new PageRenderError(
      'PAGE_FAILED',
      `The page could not be rendered: ${e instanceof Error ? firstLine(e.message) : String(e)}`,
      where,
    );
  }
  return { ...outcome.value, profileDir: profile };
}

/** Ferme, puis tue s'il le faut ; rend vrai si le processus vit ENCORE après. */
async function teardown(
  browser: Browser | undefined,
  child: ChildProcess | null,
  pid: number | undefined,
): Promise<boolean> {
  if (browser !== undefined) {
    await Promise.race([
      browser.close().catch(() => undefined),
      new Promise((r) => setTimeout(r, 5_000)),
    ]);
  }
  if (pid === undefined) return false;
  if (!(await waitGone(pid, 1_000))) {
    await killProcessTree(pid, {
      backstop: () => child?.kill('SIGKILL'),
      context: { what: 'page-renderer' },
    });
  }
  const gone = await waitGone(pid, 5_000);
  if (gone) live.delete(pid);
  return !gone;
}

/** Une requête de la page : servie par le périmètre, laissée partir, ou refusée. */
async function route(
  r: HTTPRequest,
  req: RenderPdfRequest,
  note: (url: string, reason: string) => void,
): Promise<void> {
  const url = r.url();
  try {
    if (url.startsWith(`${PAGE_ORIGIN}/`)) {
      const path = pathForUrl(url);
      const read = await req.readLocal(path);
      if (!read.ok) {
        note(url, read.reason);
        await r.abort('accessdenied');
        return;
      }
      if (read.bytes.byteLength > MAX_LOCAL_RESOURCE_BYTES) {
        note(url, `larger than ${MAX_LOCAL_RESOURCE_BYTES} bytes`);
        await r.abort('accessdenied');
        return;
      }
      await r.respond({
        status: 200,
        contentType: contentTypeFor(path, read.bytes),
        body: Buffer.from(read.bytes),
      });
      return;
    }
    if (url.startsWith('data:') || url.startsWith('blob:') || url === 'about:blank') {
      await r.continue();
      return;
    }
    if (url.startsWith('http:') || url.startsWith('https:')) {
      const verdict = await networkVerdict(url);
      if (!verdict.ok) {
        note(url, verdict.reason);
        await r.abort('blockedbyclient');
        return;
      }
      await r.continue();
      return;
    }
    note(url, 'this kind of address is not loaded');
    await r.abort('blockedbyclient');
  } catch (err) {
    // Une requête jamais réglée tiendrait la page jusqu'à la borne de temps :
    // elle est refusée, avec la raison. Déjà réglée (la page fermée), le refus
    // échoue à son tour, sans conséquence.
    note(url, `could not be served (${err instanceof Error ? err.message : String(err)})`);
    await r.abort('failed').catch(() => undefined);
  }
}

async function renderAndFit(
  page: Page,
  req: RenderPdfRequest,
  paper: PaperOptions,
  minScale: number,
  remaining: () => number,
  notLoaded: NotLoaded[],
): Promise<RenderPdfResult> {
  const renderAt = async (scale: number): Promise<ScaledRender> => {
    const pdf = await page.pdf(pdfOptions(paper, scale, remaining()));
    const facts = await readPdfFacts(pdf);
    return { scale, pages: facts.pages, pdf };
  };
  const pid = page.browser().process()?.pid ?? -1;
  if (req.maxPages === undefined) {
    const one = await renderAt(1);
    return finish(one, one.pages, 1, notLoaded, pid);
  }
  const fit = await fitToPages(req.maxPages, minScale, renderAt);
  if (!fit.ok) {
    throw new PageRenderError(
      'DOES_NOT_FIT',
      `The page does not fit on ${req.maxPages} page(s): it takes ${fit.atFullScale.pages} ` +
        `page(s) at scale 1, and still ${fit.atMinScale.pages} at ${minScale}, the smallest ` +
        'scale at which text stays readable. Nothing was written. Shorten the content or ask ' +
        'for more pages.',
      { pagesAtMinScale: fit.atMinScale.pages, pagesAtFullScale: fit.atFullScale.pages },
    );
  }
  return finish(fit.best, fit.atFullScale.pages, fit.renders, notLoaded, pid);
}

async function finish(
  r: ScaledRender,
  pagesAtFullScale: number,
  renders: number,
  notLoaded: NotLoaded[],
  pid: number,
): Promise<RenderPdfResult> {
  const facts = await readPdfFacts(r.pdf);
  return {
    pdf: r.pdf,
    pages: facts.pages,
    scale: r.scale,
    pagesAtFullScale,
    paper: facts.paper,
    mixedSizes: facts.mixedSizes,
    notLoaded: [...notLoaded],
    renders,
    pid,
    profileDir: '',
  };
}
