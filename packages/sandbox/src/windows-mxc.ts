// windows-mxc.ts — le backend Windows : Microsoft MXC (`@microsoft/mxc-sdk`),
// conteneur de processus AppContainer, sans droits admin ni compte dédié.
//
// La politique est celle que l'essai #731 a mesurée sur Windows 11 Home 25H2
// (D:\APPS\mxc-trial\RAPPORT.md), point par point :
//
//   - `ui: { disable: false }` OBLIGATOIRE : sans lui, `node`, `git`,
//     `powershell` meurent au démarrage en 0xC0000142, sans un mot sur stderr
//     (mesure 0-ui). Presse-papiers et injection d'entrées restent refusés ;
//   - chaque lecteur déclaré en LECTURE : tout chemin non déclaré est interdit
//     en lecture aussi (mesure 2b-noroots) ;
//   - réseau sortant ouvert (`egress allow`) : l'étape 1 ne confine que les
//     écritures. La boucle locale (127.0.0.1) répond avec cette seule règle —
//     mesuré le 14/10, ce qui garde une skill ComfyUI locale joignable ;
//     `ingress.hostLoopback` est refusé par ce Windows (`backend_unavailable`) ;
//   - l'environnement passé EN ENTIER (`inheritDefaultEnvironment: false`) :
//     l'environnement par défaut de MXC est le bloc du profil utilisateur,
//     variables persistées comprises — une clé d'API posée par `setx` y
//     serait. L'enfant ne reçoit que l'environnement filtré du moteur ;
//   - télémétrie coupée explicitement (`getTelemetryConsentStatus()` plantait
//     Node sur la machine de l'essai : on n'y touche pas).
//
// Les processus que la commande laisse derrière elle — un petit-enfant
// détaché, un `start /b` — meurent avec le conteneur à la fin de la commande
// (mesure 1g, et `sandbox-windows.test.ts`).
//
// Le SDK n'est chargé que sous Windows, et par `import()` : sous macOS et
// Linux il n'est jamais lu, et son absence d'une installation se dit
// (`SANDBOX_BACKEND_MISSING`) au lieu de faire tomber le runner au démarrage.

import { existsSync } from 'node:fs';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type * as MxcSdk from '@microsoft/mxc-sdk/v1';
import type { ContainerRequest, MxcProcess } from '@microsoft/mxc-sdk/v1';
import { windowsCommandLine } from './command-line';
import {
  SandboxStartError,
  type ConfinedLaunch,
  type ProcessEnd,
  type SandboxBackend,
  type SandboxStatus,
  type StartedProcess,
} from './types';

type MxcModule = typeof MxcSdk;

/** Le seul palier d'isolation MXC accepté (voir la sonde). */
const ACCEPTED_TIER = 'base-container';

/** Le nom sous lequel ce backend apparaît dans le statut et les journaux. */
export const MXC_BACKEND_NAME = 'mxc-processcontainer';

/**
 * Délai laissé aux flux de sortie pour se vider après la fin du processus.
 * Au-delà, on rend ce qui est capturé : un flux qui ne se ferme jamais ne
 * doit pas bloquer la commande (le processus, lui, est déjà fini).
 */
const STREAM_DRAIN_MS = 2_000;

/** Les lecteurs présents, déclarés en lecture seule. Lus une fois par processus. */
let driveRoots: string[] | undefined;
function readableDriveRoots(): string[] {
  if (driveRoots) return driveRoots;
  // A: et B: écartés : un lecteur de disquette absent peut bloquer la sonde.
  driveRoots = 'CDEFGHIJKLMNOPQRSTUVWXYZ'
    .split('')
    .map((letter) => `${letter}:\\`)
    .filter((root) => existsSync(root));
  return driveRoots;
}

function toRequest(launch: ConfinedLaunch): ContainerRequest {
  const environment: Record<string, string> = {};
  for (const [k, v] of Object.entries(launch.env)) {
    if (v !== undefined) environment[k] = v;
  }
  // ComSpec de l'environnement de l'ENFANT, comme Node le lit pour `shell: true`.
  const comspecKey = Object.keys(environment).find((k) => k.toUpperCase() === 'COMSPEC');
  const comspec = (comspecKey && environment[comspecKey]) || 'cmd.exe';
  return {
    command: windowsCommandLine(launch.target, comspec),
    filesystem: {
      readwritePaths: [...launch.writableRoots],
      readonlyPaths: readableDriveRoots(),
    },
    network: { egress: { default: 'allow' } },
    ui: { disable: false },
    workingDirectory: launch.cwd,
    environment,
    inheritDefaultEnvironment: false,
  };
}

async function drain(stream: Readable | null): Promise<void> {
  if (!stream) return;
  await Promise.race([
    finished(stream).catch(() => undefined),
    new Promise((r) => setTimeout(r, STREAM_DRAIN_MS)),
  ]);
}

function wrap(proc: MxcProcess): StartedProcess {
  // Les flux sont pris AVANT `wait()` : le SDK draine lui-même ceux qu'on
  // n'a pas pris, et refuse ensuite qu'on les lise.
  const stdout = proc.standardOutput;
  const stderr = proc.standardError;
  const done: Promise<ProcessEnd> = proc
    .wait()
    .then(async (w): Promise<ProcessEnd> => {
      await Promise.all([drain(stdout), drain(stderr)]);
      return { kind: 'exit', exitCode: w.exitCode };
    })
    .catch(
      (e: unknown): ProcessEnd => ({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      }),
    )
    .finally(() => {
      try {
        proc.dispose();
      } catch {
        /* déjà libéré */
      }
    });
  return {
    stdout,
    stderr,
    done,
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* déjà fini */
      }
    },
  };
}

function messageOf(e: unknown): string {
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return typeof code === 'string' ? `${code}: ${e.message}` : e.message;
  }
  return String(e);
}

/**
 * Le backend MXC. `load` est injectable pour les tests (un SDK absent, un SDK
 * qui refuse) ; par défaut, le vrai paquet.
 */
export function mxcBackend(
  load: () => Promise<MxcModule> = () => import('@microsoft/mxc-sdk/v1'),
): SandboxBackend {
  let mod: Promise<MxcModule> | undefined;
  const sdk = (): Promise<MxcModule> => (mod ??= load());

  const start = async (launch: ConfinedLaunch): Promise<StartedProcess> => {
    let m: MxcModule;
    try {
      m = await sdk();
    } catch (e) {
      throw new SandboxStartError(messageOf(e));
    }
    try {
      const proc = await m.spawn(toRequest(launch), { telemetry: { enabled: false } });
      return wrap(proc);
    } catch (e) {
      throw new SandboxStartError(messageOf(e));
    }
  };

  const probe = async (): Promise<SandboxStatus> => {
    let m: MxcModule;
    try {
      m = await sdk();
    } catch (e) {
      return { state: 'unavailable', code: 'SANDBOX_BACKEND_MISSING', reason: messageOf(e) };
    }
    try {
      const support = m.getPlatformSupport();
      if (!support.isSupported) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_PLATFORM_UNSUPPORTED',
          reason: support.reason || 'getPlatformSupport: isSupported=false',
        };
      }
      // LE PALIER D'ISOLATION. Seul `base-container` est accepté, parce que
      // c'est le seul MESURÉ sain (Windows 11 Home 25H2, essai #731 et ce
      // PR : +120 ms par commande). Sur le palier `appcontainer-dacl`
      // (runner Windows Server 2025 de GitHub, mesuré le 14/10), déclarer
      // les lecteurs en lecture fait RÉÉCRIRE par MXC les ACL de tout le
      // lecteur C: : 820 s pour la première commande, 159 s pour la
      // suivante, et des commandes parallèles refusées au bout de 30 s
      // (`timed out acquiring DACL mutex on \\?\C:\`). Confiner à ce prix,
      // en touchant aux droits de chaque fichier de l'utilisateur, n'est pas
      // un mode dégradé acceptable : le bac à sable se dit indisponible, avec
      // le palier et les avertissements de MXC cités tels quels.
      if (support.isolationTier !== ACCEPTED_TIER) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_PLATFORM_UNSUPPORTED',
          reason: [
            `isolationTier=${support.isolationTier ?? 'unknown'}`,
            ...(support.isolationWarnings ?? []),
          ].join(' | '),
        };
      }
    } catch (e) {
      return { state: 'unavailable', code: 'SANDBOX_PLATFORM_UNSUPPORTED', reason: messageOf(e) };
    }
    // L'épreuve : une commande triviale, confinée pour de vrai. Elle attrape
    // ce qu'aucune sonde déclarative ne voit — un Node trop ancien pour les
    // flux natifs du SDK (« native stdio on Windows requires Node.js
    // 24.21.0 … or 26.8.0 », mesuré sur Node 26.4), une DLL qui ne
    // s'initialise pas, des binaires manquants.
    // LOCALAPPDATA : MXC refuse un environnement qui ne le porte pas
    // (`policy_validation … missing the required variable(s): LOCALAPPDATA`).
    const env: Record<string, string | undefined> = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[name] = process.env[name];
    }
    try {
      const proc = await start({
        target: { command: 'exit 0' },
        cwd: process.env['SYSTEMROOT'] ?? 'C:\\Windows',
        env,
        writableRoots: [],
      });
      proc.stdout?.resume();
      proc.stderr?.resume();
      const end = await proc.done;
      if (end.kind !== 'exit' || end.exitCode !== 0) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_SELF_TEST_FAILED',
          reason:
            end.kind === 'exit'
              ? `exit ${end.exitCode}`
              : end.kind === 'error'
                ? end.message
                : 'signal',
        };
      }
    } catch (e) {
      const reason = e instanceof SandboxStartError ? e.backendMessage : messageOf(e);
      return { state: 'unavailable', code: 'SANDBOX_SELF_TEST_FAILED', reason };
    }
    return { state: 'available', backend: MXC_BACKEND_NAME };
  };

  return { probe, start };
}
