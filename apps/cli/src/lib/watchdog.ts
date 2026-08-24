// watchdog.ts — la surveillance CONTINUE de la santé, après le boot.
//
// Constat du 23/08 au soir : Postgres est mort sous une stack que le lanceur
// déclarait « healthy ». Le lanceur au premier plan n'attend que la MORT des
// processus runner/web (Promise.race sur leurs handles) — or un Postgres mort
// ne tue ni l'un ni l'autre : l'app fait alors semblant de marcher, les jobs
// ne se créent plus, et personne n'est prévenu.
//
// Le runner sonde déjà sa base à chaque GET /api/health (SELECT 1 → 503 si
// morte). Ce watchdog ré-interroge donc CE health-là périodiquement : une
// seule source de vérité, et la panne « runner injoignable » est couverte par
// le même geste. Pas de redémarrage automatique en V1 — invariant #4, fail
// loud : on nomme la panne dans le terminal, on annonce le retour, et c'est
// tout.

export type HealthState = 'healthy' | 'degraded' | 'unreachable';

export interface HealthProbeResult {
  state: HealthState;
  /** Cause courte, affichable ('database unreachable', 'runner not answering'). */
  detail: string;
}

export interface WatchdogOptions {
  /** Sonde de santé. Injectée pour les tests ; en prod = probeRunnerHealth. */
  probe: () => Promise<HealthProbeResult>;
  /** Appelé à CHAQUE transition d'état (jamais répété tant que l'état tient). */
  onTransition: (next: HealthState, detail: string) => void;
  /** Période entre deux sondes. */
  intervalMs?: number;
  /**
   * Nombre d'échecs CONSÉCUTIFS avant de quitter 'healthy'. Une sonde unique
   * qui rate (GC, disque qui gratte) ne doit pas déclencher la sirène ; deux
   * de suite, si.
   */
  failureThreshold?: number;
}

export interface Watchdog {
  stop: () => void;
}

/**
 * Sonde le /api/health du runner. Trois issues :
 *   200            → healthy
 *   autre statut   → degraded (le runner répond mais se déclare malade — la
 *                    seule cause qu'il connaisse est sa base, cf. health.ts)
 *   fetch échoue   → unreachable (runner absent ou gelé)
 */
export async function probeRunnerHealth(runnerUrl: string): Promise<HealthProbeResult> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${runnerUrl}/api/health`, { signal: controller.signal });
    clearTimeout(t);
    if (res.status === 200) return { state: 'healthy', detail: '' };
    return { state: 'degraded', detail: 'database unreachable (runner reports db: error)' };
  } catch {
    return { state: 'unreachable', detail: 'runner is not answering /api/health' };
  }
}

/**
 * Démarre la boucle de surveillance. Le timer est unref'é : il ne retient
 * jamais le process — le lanceur vit déjà tant que ses enfants vivent.
 */
export function startHealthWatchdog(opts: WatchdogOptions): Watchdog {
  const intervalMs = opts.intervalMs ?? 30_000;
  const failureThreshold = opts.failureThreshold ?? 2;

  let announced: HealthState = 'healthy';
  let consecutiveFailures = 0;
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    // Une sonde encore en vol (runner gelé → 3s d'abort) ne doit pas
    // s'empiler sur la suivante.
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      const result = await opts.probe();
      if (stopped) return;

      if (result.state === 'healthy') {
        consecutiveFailures = 0;
        if (announced !== 'healthy') {
          announced = 'healthy';
          opts.onTransition('healthy', 'services are answering again');
        }
        return;
      }

      consecutiveFailures += 1;
      if (consecutiveFailures < failureThreshold) return;
      if (announced !== result.state) {
        announced = result.state;
        opts.onTransition(result.state, result.detail);
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
