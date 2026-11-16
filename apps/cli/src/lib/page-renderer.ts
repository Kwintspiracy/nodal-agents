// page-renderer.ts — le moteur de rendu de pages au démarrage, et la commande
// qui l'installe (#1082).
//
// Décision du propriétaire (15-16/11/2026) : Nodal télécharge son moteur de
// rendu (chrome-headless-shell) UNE fois, au premier démarrage, comme
// Hermes-Agent installe son navigateur à l'installation, avec un moyen de le
// refuser : le réglage `pageRenderer.autoInstall: false` de config.json, ou
// `nodal-agents up --skip-renderer-install`.
//
// Il ne retarde JAMAIS « All services healthy » : `up` ne l'appelle qu'APRÈS,
// et un échec (hors ligne, téléchargement, disque, plateforme sans build) ne
// fait jamais échouer le démarrage. Le terminal dit alors que le moteur n'est
// pas installé et pourquoi ; l'outil `render_pdf` le répète à l'agent, avec la
// commande pour l'installer plus tard. Le code qui installe est celui de
// @nodal-agents/page-render, le même pour le démarrage, la commande, la CI.

import chalk from 'chalk';
import ora from 'ora';
import type { NodalConfig } from '@nodal-agents/shared/nodal-config';
import {
  RENDERER_BUILD_ID,
  RENDERER_INSTALL_COMMAND,
  RendererInstallError,
  installRenderer,
  readRendererStatus,
  recordInstallTurnedOff,
  rendererDir,
  type InstallRendererOptions,
  type RendererStatus,
} from '@nodal-agents/page-render/install';

/** Le drapeau de `up` qui refuse le téléchargement pour ce démarrage. */
export const SKIP_RENDERER_FLAG = '--skip-renderer-install';

/**
 * Ce qui refuse le téléchargement au démarrage, dit comme la personne l'a
 * réglé, ou null quand rien ne le refuse.
 */
export function rendererInstallTurnedOff(
  config: Pick<NodalConfig, 'pageRenderer'> | null,
  skipFlag: boolean,
): string | null {
  if (skipFlag) return `nodal-agents up ${SKIP_RENDERER_FLAG}`;
  if (config?.pageRenderer?.autoInstall === false) {
    return 'config.json: "pageRenderer": { "autoInstall": false }';
  }
  return null;
}

const mb = (n: number): string => `${Math.round(n / 1024 / 1024)} MB`;

/** Une ligne de progression, et la ligne de fin, pour la personne qui regarde le terminal. */
interface Reporter {
  start(text: string): void;
  progress(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  info(text: string): void;
}

function oraReporter(): Reporter {
  const spinner = ora();
  return {
    start: (t) => void spinner.start(t),
    progress: (t) => {
      spinner.text = t;
    },
    succeed: (t) => void spinner.succeed(chalk.green(t)),
    fail: (t) => void spinner.fail(chalk.yellow(t)),
    info: (t) => console.log(chalk.gray(`  ${t}`)),
  };
}

export type RendererStartOutcome = 'ready' | 'installed' | 'off' | 'failed' | 'busy';

/** Pourquoi le moteur n'est pas là, pour le terminal. */
function notInstalled(reason: string): string {
  return (
    `Page renderer not installed: ${reason}. Nodal runs without it, and render_pdf says so. ` +
    `Install it later: ${RENDERER_INSTALL_COMMAND}`
  );
}

/**
 * Installe le moteur s'il manque, en montrant la progression. Ne lève jamais :
 * le démarrage de Nodal ne dépend pas de lui.
 */
export async function ensureRendererAtStart(opts: {
  turnedOff: string | null;
  reporter?: Reporter;
  install?: InstallRendererOptions;
}): Promise<RendererStartOutcome> {
  const r = opts.reporter ?? oraReporter();
  try {
    const status = await readRendererStatus({
      ...(opts.install?.dir !== undefined ? { dir: opts.install.dir } : {}),
      ...(opts.install?.buildId !== undefined ? { buildId: opts.install.buildId } : {}),
    });
    if (status.kind === 'ready') return 'ready';
    if (opts.turnedOff !== null) {
      await recordInstallTurnedOff(
        opts.turnedOff,
        opts.install?.dir !== undefined ? { dir: opts.install.dir } : {},
      );
      r.info(
        `Page renderer not installed: its download at start is turned off (${opts.turnedOff}). ` +
          `Install it later: ${RENDERER_INSTALL_COMMAND}`,
      );
      return 'off';
    }
    return await runInstall(r, opts.install ?? {});
  } catch (err) {
    r.fail(notInstalled(err instanceof Error ? err.message : String(err)));
    return 'failed';
  }
}

async function runInstall(
  r: Reporter,
  install: InstallRendererOptions,
): Promise<RendererStartOutcome> {
  const label = `Page renderer: downloading chrome-headless-shell ${install.buildId ?? RENDERER_BUILD_ID}`;
  r.start(`${label}…`);
  try {
    const outcome = await installRenderer({
      ...install,
      onProgress: (p) => {
        install.onProgress?.(p);
        r.progress(
          p.downloadedBytes < p.totalBytes
            ? `${label}: ${mb(p.downloadedBytes)} of ${mb(p.totalBytes)}`
            : `${label}: unpacking…`,
        );
      },
    });
    if (outcome.kind === 'busy') {
      r.succeed(
        `Page renderer: being installed by process ${outcome.pid} (started ${outcome.startedAt})`,
      );
      return 'busy';
    }
    const removed =
      outcome.removed.length > 0 ? `, previous build ${outcome.removed.join(', ')} removed` : '';
    r.succeed(`Page renderer ready: chrome-headless-shell ${outcome.buildId}${removed}`);
    return outcome.kind === 'installed' ? 'installed' : 'ready';
  } catch (err) {
    const why = err instanceof RendererInstallError ? err.message : String(err);
    r.fail(notInstalled(why));
    return 'failed';
  }
}

/** `nodal-agents renderer status` : ce que le moteur est, en une ligne. */
export function describeRendererStatus(status: RendererStatus, dir: string): string {
  switch (status.kind) {
    case 'ready':
      return `ready: chrome-headless-shell ${status.buildId} (${status.executablePath})`;
    case 'installing':
      return (
        `being installed by process ${status.pid} since ${status.startedAt}` +
        (status.downloadedBytes !== undefined && status.totalBytes !== undefined
          ? `, ${mb(status.downloadedBytes)} of ${mb(status.totalBytes)}`
          : '')
      );
    case 'failed':
      return `not installed: ${status.reason} (${status.at}). Run ${RENDERER_INSTALL_COMMAND}`;
    case 'off':
      return `not installed: its download at start is turned off (${status.how}). Run ${RENDERER_INSTALL_COMMAND}`;
    case 'missing':
      return `not installed in ${dir} (${status.detail}). Run ${RENDERER_INSTALL_COMMAND}`;
  }
}

/** `nodal-agents renderer install` : installe au premier plan ; code 1 si rien n'est installé. */
export async function runRendererInstall(): Promise<number> {
  const outcome = await runInstall(oraReporter(), {});
  return outcome === 'installed' || outcome === 'ready' ? 0 : 1;
}

/** `nodal-agents renderer status`. Code 0 quand le moteur est prêt. */
export async function runRendererStatus(): Promise<number> {
  const dir = rendererDir();
  const status = await readRendererStatus({ dir });
  console.log(`  Page renderer ${describeRendererStatus(status, dir)}`);
  return status.kind === 'ready' ? 0 : 1;
}
