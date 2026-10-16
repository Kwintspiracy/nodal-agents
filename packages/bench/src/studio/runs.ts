// studio/runs.ts — les lancements de Bench Studio, suivis en direct.
//
// Un lancement est une SESSION du banc (session.ts, le même code que le CLI) :
// Bench Studio n'y ajoute que l'écoute. Chaque étape de chaque essai devient
// un événement, gardé en mémoire et diffusé à qui suit le lancement (le flux
// SSE de la page « Live »). Deux portes, tenues ICI et pas seulement dans
// l'interface :
//   - la porte de l'espace banc (`launchGate`) : sans elle, rien ne part ;
//   - un scénario qui envoie au propriétaire exige `allowOwnerSends` ;
//     session.ts et runTrial le refusent aussi.

import { BenchStop } from '../workflows/lock';
import type { SessionHooks, SessionSummary, BenchRun } from '../workflows/session';
import { selectScenarios, type Selection } from '../workflows/selection';
import type { TrialProgress } from '../workflows/trial';
import type { TrialLine } from '../workflows/types';
import type { LaunchGate } from './launch-gate';

export type RunEvent =
  | { readonly at: number; readonly type: 'log'; readonly line: string }
  | {
      readonly at: number;
      readonly type: 'trial-start';
      readonly index: number;
      readonly total: number;
      readonly scenario: string;
    }
  | {
      readonly at: number;
      readonly type: 'progress';
      readonly index: number;
      readonly scenario: string;
      readonly event: TrialProgress;
    }
  | {
      readonly at: number;
      readonly type: 'trial-end';
      readonly index: number;
      readonly scenario: string;
      readonly line: TrialLine;
    }
  | {
      readonly at: number;
      readonly type: 'done';
      readonly failed: number;
      readonly skipped: number;
    }
  | { readonly at: number; readonly type: 'error'; readonly message: string };

export interface LaunchRequest {
  readonly selection: Selection;
  readonly trials: number;
  readonly allowOwnerSends: boolean;
}

/** Comment une session est réellement jouée : la base ouverte, `runBench`. Injecté pour les tests. */
export type SessionRunner = (
  run: Omit<BenchRun, 'stackDir'>,
  stop: BenchStop,
  hooks: SessionHooks,
) => Promise<SessionSummary>;

export interface RunState {
  readonly id: string;
  readonly startedAt: number;
  readonly request: LaunchRequest;
  readonly events: RunEvent[];
  finished: boolean;
}

export class RunManager {
  private readonly runs = new Map<string, RunState>();
  private readonly stops = new Map<string, BenchStop>();
  private readonly listeners = new Map<string, Set<(e: RunEvent) => void>>();
  private seq = 0;

  constructor(
    private readonly gate: () => Promise<LaunchGate>,
    private readonly runner: SessionRunner,
    private readonly cancelLive: (stop: BenchStop) => Promise<void>,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Lance une session ; refuse, en le disant, si la porte est fermée ou si la demande est invalide. */
  async launch(req: LaunchRequest): Promise<RunState> {
    const g = await this.gate();
    if (!g.enabled) throw new Error(`studio_launch_refused: ${g.reason}`);
    if (!Number.isInteger(req.trials) || req.trials < 1 || req.trials > 20)
      throw new Error('studio_bad_trials: trials must be an integer from 1 to 20');
    const scenarios = selectScenarios(req.selection);
    if (scenarios.length === 0) throw new Error('studio_no_scenario: the selection is empty');
    const owner = scenarios.filter((s) => s.sends === 'owner').map((s) => s.id);
    if (owner.length > 0 && !req.allowOwnerSends) {
      throw new Error(
        `studio_owner_sends: ${owner.join(', ')} sends to the owner; tick "Allow sends to the owner" to run it`,
      );
    }
    // Aucun `await` entre ce contrôle et l'enregistrement du lancement : deux
    // lancements concurrents ne peuvent pas passer tous les deux.
    if ([...this.runs.values()].some((r) => !r.finished))
      throw new Error('studio_busy: a run is already in progress');

    const id = `run-${++this.seq}-${this.now()}`;
    const state: RunState = {
      id,
      startedAt: this.now(),
      request: req,
      events: [],
      finished: false,
    };
    this.runs.set(id, state);
    const stop = new BenchStop();
    this.stops.set(id, stop);
    const emit = (e: RunEvent): void => {
      state.events.push(e);
      for (const l of this.listeners.get(id) ?? []) l(e);
    };
    void this.runner(
      { scenarios, trials: req.trials, trigger: 'manual', allowOwnerSends: req.allowOwnerSends },
      stop,
      {
        log: (line) => emit({ at: this.now(), type: 'log', line }),
        trialStart: (s, index, total) =>
          emit({ at: this.now(), type: 'trial-start', index, total, scenario: s.id }),
        progress: (s, index, event) =>
          emit({ at: this.now(), type: 'progress', index, scenario: s.id, event }),
        trialEnd: (s, index, line) =>
          emit({ at: this.now(), type: 'trial-end', index, scenario: s.id, line }),
      },
    ).then(
      (sum) => {
        state.finished = true;
        emit({ at: this.now(), type: 'done', failed: sum.failed, skipped: sum.skipped });
      },
      (e: unknown) => {
        state.finished = true;
        emit({
          at: this.now(),
          type: 'error',
          message: String(e instanceof Error ? e.message : e),
        });
      },
    );
    return state;
  }

  /** Arrête un lancement : plus aucun essai ne part, et les essais vivants sont annulés. */
  async cancel(id: string): Promise<void> {
    const stop = this.stops.get(id);
    if (!stop) throw new Error(`studio_no_run: ${id}`);
    await this.cancelLive(stop);
  }

  get(id: string): RunState | undefined {
    return this.runs.get(id);
  }

  list(): RunState[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Suit un lancement : les événements passés d'abord, puis chacun à son arrivée. Rend la désinscription. */
  subscribe(id: string, listener: (e: RunEvent) => void): () => void {
    const state = this.runs.get(id);
    if (!state) throw new Error(`studio_no_run: ${id}`);
    for (const e of state.events) listener(e);
    if (!this.listeners.has(id)) this.listeners.set(id, new Set());
    this.listeners.get(id)!.add(listener);
    return () => this.listeners.get(id)?.delete(listener);
  }
}
