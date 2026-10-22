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
//   - réseau : l'étape 1 ne confine que les écritures, mais la BOUCLE LOCALE
//     de la machine donne accès à Nodal (runner, web, Postgres) et
//     `egress.deny` ne la filtre pas (mesuré). D'où le régime `proxy`
//     (NetworkPolicy) : `egress deny`, tout le trafic passe par un proxy côté
//     hôte (proxy.ts) qui laisse passer internet et les services tiers locaux
//     et refuse les ports de Nodal. MXC n'accepte un proxy que sur la boucle
//     locale ; un build qui ne la joint pas (windows-11-arm 9457) rend le bac
//     à sable indisponible (`SANDBOX_PROXY_UNREACHABLE`). Un client NON-HTTP
//     vers un service local n'a pas de route : limite nommée (`limits`) ;
//   - l'environnement passé EN ENTIER (`inheritDefaultEnvironment: false`) :
//     l'environnement par défaut de MXC est le bloc du profil utilisateur,
//     variables persistées comprises — une clé d'API posée par `setx` y
//     serait. L'enfant ne reçoit que l'environnement filtré du moteur ;
//   - télémétrie coupée explicitement (`getTelemetryConsentStatus()` plantait
//     Node sur la machine de l'essai : on n'y touche pas).
//
// UN CONTENEUR PAR JOB, pas par commande (décision du 14/10) : un hôte
// (job-host.ts) y lance chaque commande du job, si bien que ce qu'une
// commande laisse tourner en arrière-plan vit jusqu'à la fin du job, puis
// meurt avec le conteneur quand le runner le ferme.
//
// Le SDK n'est chargé que sous Windows, et par `import()` : sous macOS et
// Linux il n'est jamais lu, et son absence d'une installation se dit
// (`SANDBOX_BACKEND_MISSING`) au lieu de faire tomber le runner au démarrage.

import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as MxcSdk from '@microsoft/mxc-sdk/v1';
import type { ContainerRequest } from '@microsoft/mxc-sdk/v1';
import { sandboxDeniedPaths, nodalDeniedEndpoints, NodalPortsUnknown } from './policy';
import { startNodalProxy, type NodalProxy } from './proxy';
import { ensureJobHostScript, sandboxHostDir } from './job-host';
import { HostJobContainer, definedEnv } from './host-container';
import { MxcBroker, mxcErrorText, type BrokeredContainer, type MxcErrorFields } from './mxc-broker';
import {
  BrokerNodeUnavailable,
  ensureBrokerNode,
  pinnedBrokerNodeSha,
  type BrokerNodeDeps,
} from './broker-node';
import {
  SandboxStartError,
  type JobContainer,
  type ProcessEnd,
  type SandboxBackend,
  type SandboxStatus,
} from './types';

type MxcModule = typeof MxcSdk;

/** Le seul palier d'isolation MXC accepté (voir la sonde). */
const ACCEPTED_TIER = 'base-container';

/**
 * Le régime RÉSEAU du conteneur — un PARAMÈTRE du backend (#628, D2), comme le
 * Node du courtier. Le produit n'en passe qu'UNE valeur, `proxy`, depuis un
 * seul endroit (status.ts) ; il ne vient ni d'une config, ni d'une variable,
 * ni d'un réglage.
 *   - `proxy` (PRODUIT) : `egress deny`, tout le trafic sortant passe par un
 *     proxy que Nodal tient CÔTÉ HÔTE (proxy.ts). Le proxy laisse passer
 *     internet et les services tiers locaux (ComfyUI, Ollama, le serveur d'une
 *     autre commande du job — l'AppContainer partage la pile réseau de l'hôte,
 *     mesuré le 15/10) et REFUSE les ports de Nodal (runner, web, Postgres).
 *     MXC n'accepte un proxy que sur la boucle locale ; sur un build où le
 *     conteneur ne joint pas cette boucle (windows-11-arm 9457), le proxy est
 *     injoignable et le bac à sable se dit indisponible
 *     (`SANDBOX_PROXY_UNREACHABLE`).
 *   - `deny-all` : `egress deny`, AUCUN proxy, aucun réseau. Jamais construit
 *     par le produit — c'est la valeur que la CI passe aux suites qui prouvent
 *     le mur des FICHIERS, le refus de lecture et le blocage du forge, lesquels
 *     ne dépendent pas du réseau. Une valeur de son unique paramètre, pas une
 *     branche de test dans le code produit.
 */
export type NetworkPolicy = 'proxy' | 'deny-all';
export const DEFAULT_NETWORK_POLICY: NetworkPolicy = 'proxy';

/**
 * Les limites nommées du régime proxy, dites dans le statut (`limits`) :
 *   - un client NON-HTTP n'a pas de route vers un service local ;
 *   - un serveur qu'une commande lance est joignable, par le proxy, par une
 *     commande d'un AUTRE job (la boucle locale de l'hôte est commune à tous
 *     les conteneurs). Un fait, pas un défaut : c'est le même chemin que
 *     ComfyUI, et les ports de Nodal, eux, restent refusés.
 */
const RAW_TCP_LIMIT =
  'SANDBOX_NETWORK_RAW_TCP_LOCAL: a confined command reaches local services (ComfyUI, Ollama, a server another command started) and the internet only over HTTP/HTTPS, through the sandbox proxy; a non-HTTP (raw TCP/UDP) client to a local service has no route';
const CROSS_JOB_LIMIT =
  "SANDBOX_NETWORK_SHARED_LOOPBACK: a server one job starts on 127.0.0.1 is reachable through the sandbox proxy by a command of another job (the machine loopback is shared); Nodal's own ports stay refused";
/** La limite du refus du dossier de données (policy.ts, `sandboxDeniedPaths`). */
const DATA_DIR_LIMIT =
  "SANDBOX_DATA_DIR_NEW_CHILD: Nodal's data folder is refused child by child, computed when a container opens; a child created while a container runs is refused only at the next open, and the names of the folder's children are visible (their contents are not)";

/** La configuration réseau MXC d'un régime, et l'env à ajouter aux commandes. */
interface NetworkSetup {
  readonly network: ContainerRequest['network'];
  readonly containment?: ContainerRequest['containment'];
  readonly extraEnv: Record<string, string>;
}

/** Construit la config réseau d'un régime ; en `proxy`, pointe sur `proxyUrl`. */
export function networkSetup(policy: NetworkPolicy, proxyUrl: string | null): NetworkSetup {
  if (policy === 'deny-all' || proxyUrl === null) {
    return { network: { egress: { default: 'deny' } }, extraEnv: {} };
  }
  return {
    network: {
      egress: { default: 'deny' },
      ingress: { default: 'allow' },
      runtimeConfig: { networkProxy: proxyUrl },
    },
    containment: { type: 'processcontainer', config: { network: { allowedProxyPeer: 'CLI' } } },
    // Node n'honore `HTTP(S)_PROXY` (injectés par MXC) que si on le lui dit.
    // curl et Python les lisent d'office. Propagé à chaque commande par l'hôte.
    extraEnv: { NODE_USE_ENV_PROXY: '1' },
  };
}

/** Le nom sous lequel ce backend apparaît dans le statut et les journaux. */
export const MXC_BACKEND_NAME = 'mxc-processcontainer';

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

function hostRequest(
  script: string,
  writableRoots: readonly string[],
  environment: Record<string, string>,
  setup: NetworkSetup,
  readableRoots: readonly string[] = [],
): ContainerRequest {
  return {
    command: `"${process.execPath}" "${script}"`,
    filesystem: {
      readwritePaths: [...writableRoots],
      readonlyPaths: readableDriveRoots(),
      // Le dossier de données de Nodal (D1) : chacun de ses enfants est refusé
      // sauf ceux qui mènent à ce que CE conteneur doit atteindre — ses dossiers,
      // les scripts du bac à sable (policy.ts dit pourquoi les enfants, pas le
      // dossier). Calculé ici, à chaque ouverture, pour tout conteneur.
      deniedPaths: sandboxDeniedPaths([...writableRoots, ...readableRoots, sandboxHostDir()]),
    },
    network: setup.network,
    ...(setup.containment ? { containment: setup.containment } : {}),
    ui: { disable: false },
    workingDirectory: dirname(script),
    // L'env de l'hôte, plus ce que le régime ajoute (NODE_USE_ENV_PROXY) : l'hôte
    // le propage à chaque commande comme une surcharge (job-host.ts).
    environment: { ...environment, ...setup.extraEnv },
    inheritDefaultEnvironment: false,
  };
}

/** Ce qu'une commande d'épreuve a donné : sa fin, et ce qu'elle a écrit sur stderr (borné). */
export interface ProbeRun {
  readonly end: ProcessEnd;
  readonly stderr: string;
}

const PROBE_STDERR_MAX = 400;

/** Lance une commande d'épreuve dans un conteneur, draine ses flux, rend sa fin et son stderr. */
async function runProbeCommand(
  container: JobContainer,
  command: string,
  env: Record<string, string | undefined>,
): Promise<ProbeRun> {
  const proc = await container.start({
    target: { command },
    cwd: process.env['SYSTEMROOT'] ?? 'C:\\Windows',
    env,
  });
  proc.stdout?.resume();
  let stderr = '';
  proc.stderr?.on('data', (chunk: Buffer | string) => {
    if (stderr.length < PROBE_STDERR_MAX) stderr += String(chunk);
  });
  const end = await proc.done;
  return { end, stderr: stderr.trim().slice(0, PROBE_STDERR_MAX) };
}

/** La fin d'une commande d'épreuve, dite telle qu'observée : `exit 7: ECONNREFUSED`, l'erreur, ou `signal`. */
export function observedOutcome({ end, stderr }: ProbeRun): string {
  const head =
    end.kind === 'exit' ? `exit ${end.exitCode}` : end.kind === 'error' ? end.message : 'signal';
  return stderr ? `${head}: ${stderr}` : head;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? mxcErrorText(e as MxcErrorFields) : String(e);
}

/**
 * Le backend MXC. `load` est injectable pour les tests (un SDK absent, un SDK
 * qui refuse) ; par défaut, le vrai paquet.
 */
export function mxcBackend(
  load: () => Promise<MxcModule> = () => import('@microsoft/mxc-sdk/v1'),
  networkPolicy: NetworkPolicy = DEFAULT_NETWORK_POLICY,
  /**
   * D'où vient le Node du courtier. Par défaut Nodal l'obtient
   * (`ensureBrokerNode`, un build officiel épinglé, téléchargé et vérifié) :
   * le courtier ne tourne jamais sur le Node de l'utilisateur, qui peut être
   * trop ancien pour les flux natifs du SDK. Un chemin fixe sert aux tests.
   */
  brokerNode: string | BrokerNodeDeps = {},
  /**
   * Le proxy côté hôte du régime `proxy`. Par défaut celui de Nodal ; un test
   * y met un simple écouteur TCP pour mesurer ce que la MACHINE laisse passer,
   * sans le proxy de Nodal dans la mesure.
   */
  startProxy: () => Promise<NodalProxy> = () => startNodalProxy(nodalDeniedEndpoints()),
): SandboxBackend {
  let mod: Promise<MxcModule> | undefined;
  const sdk = (): Promise<MxcModule> => (mod ??= load());
  // Les conteneurs sont tenus par le courtier, hors du runner (mxc-broker.ts
  // dit pourquoi). Il résout le SDK lui-même, depuis CE module : le même
  // paquet que celui que le runner charge. Rien n'est résolu ici, où un
  // bundler (le build du web) lirait la résolution et voudrait l'embarquer.
  let brokerClient: MxcBroker | undefined;
  // Le proxy côté hôte, démarré une fois en régime `proxy`. Il refuse les
  // ports de Nodal, lus de la vraie config du runner (nodalDeniedEndpoints).
  let proxyOnce: Promise<NodalProxy> | undefined;
  const proxy = (): Promise<NodalProxy> => (proxyOnce ??= startProxy());
  const setup = async (): Promise<NetworkSetup> =>
    networkPolicy === 'proxy'
      ? networkSetup('proxy', (await proxy()).url)
      : networkSetup('deny-all', null);
  // Le Node du courtier : un chemin fixe (tests), ou le build officiel que
  // Nodal télécharge s'il manque. Résolu à chaque ouverture : un binaire
  // écarté (somme fausse) est ainsi retéléchargé à la suivante. Sa somme
  // ÉPINGLÉE est vérifiée par le courtier à chaque LANCEMENT (#628, P1-2).
  const brokerNodePath = (): Promise<string> =>
    typeof brokerNode === 'string' ? Promise.resolve(brokerNode) : ensureBrokerNode(brokerNode);
  const broker = (nodePath: string): MxcBroker =>
    (brokerClient ??= new MxcBroker(
      fileURLToPath(import.meta.url),
      nodePath,
      typeof brokerNode === 'string' ? undefined : pinnedBrokerNodeSha(brokerNode),
    ));

  const openContainer = async (
    writableRoots: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
    readableRoots: readonly string[] = [],
  ): Promise<JobContainer> => {
    try {
      await sdk();
    } catch (e) {
      throw new SandboxStartError(messageOf(e));
    }
    const environment = definedEnv(env);
    let opened: BrokeredContainer;
    try {
      const net = await setup();
      const b = broker(await brokerNodePath());
      opened = await b.open(
        hostRequest(ensureJobHostScript(), writableRoots, environment, net, readableRoots),
      );
    } catch (e) {
      if (e instanceof BrokerNodeUnavailable || e instanceof NodalPortsUnknown) {
        throw new SandboxStartError(e.message, e.code);
      }
      throw e instanceof SandboxStartError ? e : new SandboxStartError(messageOf(e));
    }
    const container = new HostJobContainer(opened);
    try {
      await container.init(environment);
    } catch (e) {
      await container.close();
      throw e instanceof SandboxStartError ? e : new SandboxStartError(messageOf(e));
    }
    return container;
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
      // PR). Sur le palier `appcontainer-dacl` (runner Windows Server 2025 de
      // GitHub, mesuré le 14/10), déclarer les lecteurs en lecture fait
      // RÉÉCRIRE par MXC les ACL de tout le lecteur C: : 820 s pour la
      // première commande, 159 s pour la suivante, et des commandes
      // parallèles refusées au bout de 30 s (`timed out acquiring DACL mutex
      // on \\?\C:\`). Confiner à ce prix, en touchant aux droits de chaque
      // fichier de l'utilisateur, n'est pas un mode dégradé acceptable : le
      // bac à sable se dit indisponible, avec le palier et les avertissements
      // de MXC cités tels quels.
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
    // L'épreuve : un conteneur ouvert pour de vrai, une commande triviale,
    // fermé. Elle attrape ce qu'aucune sonde déclarative ne voit — un Node
    // trop ancien pour les flux natifs du SDK (« native stdio on Windows
    // requires Node.js 24.21.0 … or 26.8.0 », mesuré sur Node 26.4), une DLL
    // qui ne s'initialise pas, des binaires manquants.
    // LOCALAPPDATA : MXC refuse un environnement qui ne le porte pas
    // (`policy_validation … missing the required variable(s): LOCALAPPDATA`).
    const env: Record<string, string | undefined> = {};
    for (const name of ['SYSTEMROOT', 'WINDIR', 'PATH', 'COMSPEC', 'LOCALAPPDATA', 'USERPROFILE']) {
      env[name] = process.env[name];
    }
    let container: JobContainer | null = null;
    try {
      container = await openContainer([], env);
      const selfTest = await runProbeCommand(container, 'exit 0', env);
      if (selfTest.end.kind !== 'exit' || selfTest.end.exitCode !== 0) {
        return {
          state: 'unavailable',
          code: 'SANDBOX_SELF_TEST_FAILED',
          reason: observedOutcome(selfTest),
        };
      }
      // En régime proxy, le proxy côté hôte DOIT être joignable depuis le
      // conteneur (par le canal `allowedProxyPeer`). Sur un build où la boucle
      // locale est fermée (windows-11-arm 9457), il ne l'est pas : on le dit,
      // on ne laisse pas une commande tourner avec un réseau qu'on croit filtré.
      if (networkPolicy === 'proxy') {
        const url = new URL((await proxy()).url);
        const reach = await runProbeCommand(
          container,
          `"${process.execPath}" -e "const s=require('net').connect(${url.port},'127.0.0.1');s.on('connect',()=>process.exit(0));s.on('error',e=>{console.error(e.code||e.message);process.exit(7)});setTimeout(()=>{console.error('no answer in 5 s');process.exit(8)},5000)"`,
          env,
        );
        if (reach.end.kind !== 'exit' || reach.end.exitCode !== 0) {
          return {
            state: 'unavailable',
            code: 'SANDBOX_PROXY_UNREACHABLE',
            reason: `the sandbox proxy at ${(await proxy()).url} is not reachable from the container on this Windows build (the container's connect: ${observedOutcome(reach)})`,
          };
        }
      }
    } catch (e) {
      if (e instanceof SandboxStartError) {
        return {
          state: 'unavailable',
          code: e.reasonCode ?? 'SANDBOX_SELF_TEST_FAILED',
          reason: e.backendMessage,
        };
      }
      return { state: 'unavailable', code: 'SANDBOX_SELF_TEST_FAILED', reason: messageOf(e) };
    } finally {
      await container?.close();
    }
    return {
      state: 'available',
      backend: MXC_BACKEND_NAME,
      limits:
        networkPolicy === 'proxy'
          ? [DATA_DIR_LIMIT, RAW_TCP_LIMIT, CROSS_JOB_LIMIT]
          : [DATA_DIR_LIMIT],
    };
  };

  return { probe, openContainer };
}
