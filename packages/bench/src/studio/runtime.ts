// studio/runtime.ts — Bench Studio branché sur la vraie stack.
//
// data.ts et runs.ts ne connaissent ni la base ni le disque : ce module les
// relie aux mêmes fonctions que le CLI (`openStackDb`, `runBench`,
// `readLiveBenchRoots`, `cancelTree`, `readScenarioEnv`, `readTreeFacts`), et à
// rien d'autre. Une seule instance par processus : le serveur de Bench Studio
// la garde, ses routes la partagent.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { readTreeFacts, type JobFact } from '../workflows/facts';
import { REPO } from '../workflows/paths';
import { findBenchSpace } from '../space/space';
import { readScenarioEnv, rootEntity, runBench } from '../workflows/session';
import {
  cancelTree,
  openStackDb,
  readKeyProviders,
  readLiveBenchRoots,
  readWorkspaceRoots,
} from '../workflows/stack';
import { studioModels, studioNeeds, type NeedsView, type StudioModel } from './data';
import { launchGate, type LaunchGate } from './launch-gate';
import { RunManager } from './runs';

/** Un job de l'arbre d'un essai, tel que la page « Live » le montre. */
export interface TreeJob {
  readonly id: string;
  readonly parentJobId: string | null;
  readonly agent: string | null;
  readonly status: string | null;
  readonly createdMs: number;
  readonly updatedMs: number | null;
}

export interface JobTreeView {
  readonly rootId: string;
  readonly jobs: TreeJob[];
  readonly toolCalls: number;
}

export type DeliverableView =
  | { readonly kind: 'text'; readonly root: string; readonly text: string }
  | {
      readonly kind: 'binary';
      readonly root: string;
      readonly bytes: number;
      readonly type: string;
      readonly abs: string;
    };

export interface StudioRuntime {
  readonly manager: RunManager;
  gate(): Promise<LaunchGate>;
  needs(): Promise<NeedsView>;
  /** Les modèles du catalogue, ceux que l'espace du banc peut appeler d'abord. */
  models(): Promise<StudioModel[]>;
  jobTree(rootId: string): Promise<JobTreeView>;
  deliverable(path: string): Promise<DeliverableView>;
}

const TEXT = new Set(['.md', '.csv', '.html', '.js', '.json', '.txt', '.ts', '.py', '.svg']);

async function withDb<T>(
  f: (db: Awaited<ReturnType<typeof openStackDb>>['db']) => Promise<T>,
): Promise<T> {
  const { db, close } = await openStackDb();
  try {
    return await f(db);
  } finally {
    await close();
  }
}

function treeJob(j: JobFact): TreeJob {
  return {
    id: j.id,
    parentJobId: j.parentJobId,
    agent: j.agentSlug,
    status: j.status,
    createdMs: j.createdMs,
    updatedMs: j.updatedMs,
  };
}

/**
 * Le fichier qu'un essai a laissé, cherché dans les dossiers de travail que la
 * base déclare AUJOURD'HUI. Seulement sous `nodal-bench/` d'un de ces dossiers :
 * tout autre chemin est refusé. Le même chemin dans deux dossiers est dit, pas
 * départagé au hasard.
 */
export function findDeliverable(roots: readonly string[], path: string): DeliverableView {
  const norm = path.replaceAll('\\', '/');
  if (!norm.startsWith('nodal-bench/'))
    throw new Error(`studio_no_deliverable: ${path} is not under nodal-bench/`);
  const hits = roots.flatMap((root) => {
    const abs = resolve(root, norm);
    const inside = abs.startsWith(resolve(root, 'nodal-bench') + sep);
    return inside && existsSync(abs) && statSync(abs).isFile() ? [{ root, abs }] : [];
  });
  if (hits.length === 0)
    throw new Error(`studio_no_deliverable: ${path} is in no workspace folder any more`);
  if (hits.length > 1)
    throw new Error(
      `studio_ambiguous_deliverable: ${path} exists in ${hits.length} workspace folders: ${hits.map((h) => h.root).join(', ')}`,
    );
  const { root, abs } = hits[0]!;
  const ext = extname(abs).toLowerCase();
  if (TEXT.has(ext)) return { kind: 'text', root, text: readFileSync(abs, 'utf8') };
  return { kind: 'binary', root, bytes: statSync(abs).size, type: ext.slice(1), abs };
}

export function createStudioRuntime(): StudioRuntime {
  // L'espace que les essais atteindraient, et l'espace banc : lus à chaque fois.
  const gate = (): Promise<LaunchGate> =>
    launchGate(REPO, {
      target: () =>
        withDb(async (db) => ({
          targetEntityId: await rootEntity(db),
          benchSpaceId: (await findBenchSpace(db))?.id ?? null,
        })),
    });
  const manager = new RunManager(
    gate,
    async (run, stop, hooks) => {
      const { db, close } = await openStackDb();
      try {
        return await runBench({ ...run, stackDir: REPO }, db, stop, hooks);
      } finally {
        await close();
      }
    },
    (stop) =>
      withDb((db) =>
        stop.stop(
          null,
          {
            liveRoots: () => readLiveBenchRoots(db),
            cancel: (root) => cancelTree(db, root.entityId, root.id),
            log: () => undefined,
          },
          { waitMs: 30_000 },
        ),
      ),
  );
  return {
    manager,
    gate,
    needs: () =>
      studioNeeds(() =>
        withDb(async (db) => readScenarioEnv(db, await rootEntity(db), Date.now())),
      ),
    models: async () => {
      try {
        const providers = await withDb(async (db) => readKeyProviders(db, await rootEntity(db)));
        return studioModels({ providers });
      } catch (e) {
        return studioModels({ why: String(e instanceof Error ? e.message : e) });
      }
    },
    jobTree: (rootId) =>
      withDb(async (db) => {
        const facts = await readTreeFacts(db, rootId);
        return {
          rootId,
          jobs: facts.jobs.map(treeJob),
          toolCalls: facts.toolCalls.length,
        };
      }),
    deliverable: (path) =>
      withDb(async (db) =>
        findDeliverable(await readWorkspaceRoots(db, await rootEntity(db)), path),
      ),
  };
}
