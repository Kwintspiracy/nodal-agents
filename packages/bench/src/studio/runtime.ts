// studio/runtime.ts — Bench Studio branché sur la vraie stack, en LECTURE.
//
// data.ts ne connaît ni la base ni le disque : ce module le relie aux mêmes
// fonctions que le CLI (`openStackDb`, `readScenarioEnv`, `readKeyProviders`,
// `readWorkspaceRoots`), et à rien d'autre. Bench Studio ne lance aucun essai :
// lancer attend que le banc épingle ses essais sur l'espace banc (#769).

import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { resolveBenchTarget } from '../space/space';
import { readScenarioEnv } from '../workflows/session';
import { openStackDb, readKeyProviders, readWorkspaceRoots } from '../workflows/stack';
import { studioModels, studioNeeds, type NeedsView, type StudioModel } from './data';

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
  needs(): Promise<NeedsView>;
  /** Les modèles du catalogue, ceux que l'espace du banc peut appeler d'abord. */
  models(): Promise<StudioModel[]>;
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
  return {
    needs: () =>
      studioNeeds(() =>
        withDb(async (db) =>
          readScenarioEnv(db, (await resolveBenchTarget(db)).entityId, Date.now()),
        ),
      ),
    models: async () => {
      try {
        const providers = await withDb(async (db) =>
          readKeyProviders(db, (await resolveBenchTarget(db)).entityId),
        );
        return studioModels({ providers });
      } catch (e) {
        return studioModels({ why: String(e instanceof Error ? e.message : e) });
      }
    },
    deliverable: (path) =>
      withDb(async (db) =>
        findDeliverable(
          await readWorkspaceRoots(db, (await resolveBenchTarget(db)).entityId),
          path,
        ),
      ),
  };
}
