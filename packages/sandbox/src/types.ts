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
  | 'SANDBOX_SELF_TEST_FAILED';

export type SandboxStatus =
  | {
      readonly state: 'available';
      /** Le backend qui confine, nommé pour les journaux et le bandeau. */
      readonly backend: string;
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

/** Une commande prête à être confinée. */
export interface ConfinedLaunch {
  readonly target: LaunchTarget;
  readonly cwd: string;
  /** L'environnement EXACT de l'enfant — jamais complété par celui du runner. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Les dossiers inscriptibles, déjà résolus (`resolveWritableRoots`). */
  readonly writableRoots: readonly string[];
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
   * Résolue quand le processus est sorti ET que ses flux sont fermés. Ne
   * rejette jamais : une panne devient `{ kind: 'error' }`.
   */
  readonly done: Promise<ProcessEnd>;
  /** Tue la commande et tout ce qu'elle a lancé. Idempotent. */
  kill(): void;
}

/** Ce qu'un backend sait faire. */
export interface SandboxBackend {
  /** Sonde UNE fois par processus ; le résultat est mis en cache par l'appelant. */
  probe(): Promise<SandboxStatus>;
  /**
   * Lance une commande confinée. LÈVE `SandboxStartError` si le bac à sable
   * ne peut pas la démarrer : on ne lance jamais la commande sans lui.
   */
  start(launch: ConfinedLaunch): Promise<StartedProcess>;
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
  ) {
    super(`SANDBOX_START_FAILED: ${backendMessage}`);
    this.name = 'SandboxStartError';
  }
}
