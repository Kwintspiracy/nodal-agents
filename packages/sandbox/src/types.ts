// types.ts — le contrat d'un backend de bac à sable, quel que soit l'OS.

import type { Readable } from 'node:stream';

/**
 * Pourquoi le bac à sable n'est pas disponible — un CODE stable, que le
 * bandeau (décision D2) et les journaux lisent, jamais un booléen qui
 * cacherait la raison.
 */
export type SandboxUnavailableCode =
  /** Pas encore de backend pour ce système (macOS, Linux : PR suivantes). */
  | 'SANDBOX_NOT_IMPLEMENTED'
  /** Le paquet du backend n'a pas pu être chargé (absent de l'installation). */
  | 'SANDBOX_BACKEND_MISSING'
  /** Le backend dit lui-même que cette machine ne le supporte pas. */
  | 'SANDBOX_PLATFORM_UNSUPPORTED'
  /** Une commande triviale confinée n'a pas pu tourner : le backend est cassé ici. */
  | 'SANDBOX_SELF_TEST_FAILED'
  /** Le processus qui tient les conteneurs (le courtier MXC) n'a pas pu être lancé. */
  | 'SANDBOX_BROKER_START_FAILED'
  /** Le Node dédié du courtier n'a pas pu être obtenu (réseau, somme). */
  | 'SANDBOX_BROKER_NODE_UNAVAILABLE'
  /** Le proxy réseau (côté hôte) n'est pas joignable depuis le conteneur. */
  | 'SANDBOX_PROXY_UNREACHABLE';

export type SandboxStatus =
  | {
      readonly state: 'available';
      /** Le backend qui confine, nommé pour les journaux et le bandeau. */
      readonly backend: string;
      /**
       * Ce que la politique de l'étape 1 promet et que CETTE machine ne tient
       * pas sous ce backend, chaque limite commençant par son code stable
       * (par ex. `SANDBOX_NETWORK_RAW_TCP_LOCAL: …`). Absent quand il n'y en a pas.
       */
      readonly limits?: readonly string[];
    }
  | {
      readonly state: 'unavailable';
      readonly code: SandboxUnavailableCode;
      /** La raison telle que le backend (ou l'OS) l'a donnée — une donnée, citée. */
      readonly reason: string;
    };

/**
 * Ce qu'on lance : une commande shell, ou un exécutable avec ses arguments.
 * Le moteur shell (`@nodal-agents/tools`) emploie ce même type ; chaque
 * backend le traduit dans la forme que son OS lit (une ligne de commande
 * Windows pour MXC, un argv préfixé pour Seatbelt et Landlock).
 */
export type LaunchTarget =
  | { readonly command: string }
  | {
      readonly file: string;
      readonly args: readonly string[];
      /** Windows : argv passé tel quel, sans citation (voir command-line.ts). */
      readonly windowsVerbatimArguments?: boolean;
    };

/** UNE commande à lancer dans le conteneur d'un job. */
export interface CommandLaunch {
  readonly target: LaunchTarget;
  readonly cwd: string;
  /** L'environnement EXACT de la commande — jamais complété par celui du runner. */
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Comment un processus a fini — trois issues, jamais confondues. */
export type ProcessEnd =
  | { readonly kind: 'exit'; readonly exitCode: number }
  | { readonly kind: 'signal' }
  | { readonly kind: 'error'; readonly message: string };

/** Un processus lancé, confiné ou non : ce que le moteur shell manipule. */
export interface StartedProcess {
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  /**
   * Résolue quand la commande est sortie — son processus racine, puis ses
   * flux vidés (borné : un processus d'arrière-plan qui garde le tuyau ne
   * retient pas la commande). Ne rejette jamais : une panne devient
   * `{ kind: 'error' }`.
   */
  readonly done: Promise<ProcessEnd>;
  /** Tue la commande et ce qu'elle a lancé (timeout, Stop). Idempotent. */
  kill(): void;
}

/**
 * Le conteneur confiné d'UN job (#628, décision du 14/10) : toutes les
 * commandes du job y tournent, et ce qu'elles lancent en arrière-plan y vit
 * jusqu'à ce que le job finisse — un serveur démarré par une commande répond
 * à la suivante. `close()` tue tout ce qu'il contient.
 */
export interface JobContainer {
  /** Lève `SandboxStartError` si le conteneur ne peut pas lancer la commande. */
  start(launch: CommandLaunch): Promise<StartedProcess>;
  /** Le conteneur tourne encore (il peut mourir seul : son hôte tué de l'extérieur). */
  readonly alive: boolean;
  close(): Promise<void>;
}

/** Ce qu'un backend sait faire. */
export interface SandboxBackend {
  /** Sonde UNE fois par processus ; le résultat est mis en cache par l'appelant. */
  probe(): Promise<SandboxStatus>;
  /**
   * Ouvre un conteneur dont seuls `writableRoots` (déjà résolus) sont
   * inscriptibles. `env` est l'environnement de son hôte. LÈVE
   * `SandboxStartError` si le bac à sable ne peut pas l'ouvrir : rien ne
   * tourne alors sans lui.
   */
  openContainer(
    writableRoots: readonly string[],
    env: Readonly<Record<string, string | undefined>>,
  ): Promise<JobContainer>;
}

/**
 * Le bac à sable est disponible mais n'a pas pu démarrer CETTE commande. La
 * commande est refusée, jamais lancée sans confinement (invariant #4).
 */
export class SandboxStartError extends Error {
  readonly code = 'SANDBOX_START_FAILED';
  constructor(
    /** Le message du backend, cité tel quel. */
    readonly backendMessage: string,
    /**
     * Le code d'indisponibilité quand l'échec n'est pas celui d'une commande
     * mais du backend entier (le courtier qui ne démarre pas) : la sonde le
     * rend tel quel dans le statut.
     */
    readonly reasonCode?: SandboxUnavailableCode,
  ) {
    super(`SANDBOX_START_FAILED: ${backendMessage}`);
    this.name = 'SandboxStartError';
  }
}
