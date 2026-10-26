// routes/sandbox.ts — GET /api/sandbox?entityId=<uuid> — ce que le bac à sable
// EST sur cette machine, pour un espace (#876).
//
// Le runner est le seul à le savoir : la sonde (`getSandboxStatus`, mise en
// cache par processus), la détection des dossiers permis, les dossiers de
// données de Nodal, les ports du proxy. Le web lit cette route et en fait ses
// phrases ; il ne recalcule rien. La réponse ne porte que des codes et des
// chemins (invariant #2), validée par `SandboxStateSchema` (@nodal-agents/shared)
// des deux côtés.
//
// LE RÉGLAGE DE L'ESPACE est relu ici à chaque appel, par le même lecteur que
// les commandes (`readWorkspaceSandbox`) : l'écran montre ce que la prochaine
// commande appliquera, jamais une copie. Un réglage illisible rend 500 avec
// son code, jamais un état supposé (invariant #4).
//
// Auth : la garde `requireRunnerAuth` (server.ts). Un appelant de confiance (le
// web, qui a cadré l'espace depuis la session) passe ; un porteur de jeton de
// session ne lit que SON espace, et un autre est introuvable (404).

import type { Context } from 'hono';
import { z } from 'zod';
import { agents, and, eq, readWorkspaceSandbox } from '@nodal-agents/db';
import {
  composeAllowedFolders,
  getSandboxStatus,
  nodalDataFolders,
  nodalDeniedEndpoints,
  NodalPortsUnknown,
  type MachineView,
  type SandboxStatus,
} from '@nodal-agents/sandbox';
import { SANDBOX_SETTINGS_UNREADABLE, type SandboxState } from '@nodal-agents/shared';
import { resolveRunWorkspaces } from '@nodal-agents/tools';
import type { RunnerDeps } from '../deps.ts';

const QuerySchema = z.object({ entityId: z.string().guid() });

/** Ce que la route lit de la machine — injectable pour les tests. */
export interface SandboxRouteSources {
  status: () => Promise<SandboxStatus>;
  env: Readonly<Record<string, string | undefined>>;
  machine?: MachineView;
}

const thisRunner = (): SandboxRouteSources => ({ status: getSandboxStatus, env: process.env });

export async function sandboxRoute(
  c: Context,
  deps: Pick<RunnerDeps, 'db'>,
  sources: SandboxRouteSources = thisRunner(),
): Promise<Response> {
  const parsed = QuerySchema.safeParse({ entityId: c.req.query('entityId') });
  if (!parsed.success) return c.json({ error: 'invalid_request' }, 400);
  const { entityId } = parsed.data;
  if (!c.get('callerTrusted') && c.get('callerEntityId') !== entityId) {
    return c.json({ error: 'entity_not_found' }, 404);
  }
  const db = deps.db;

  let settings: Awaited<ReturnType<typeof readWorkspaceSandbox>>;
  try {
    settings = await readWorkspaceSandbox(db, entityId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.startsWith(SANDBOX_SETTINGS_UNREADABLE)) throw err;
    console.error(`[sandbox-route] ${message}`);
    return c.json({ error: SANDBOX_SETTINGS_UNREADABLE }, 500);
  }

  const status = await sources.status();

  // Les dossiers de chaque agent actif : la liste même que ses outils reçoivent
  // (`resolveRunWorkspaces`), le partagé à part puisqu'il est à tous.
  const agentRows = await db
    .select({ id: agents.id, name: agents.name, runtime: agents.runtime })
    .from(agents)
    .where(and(eq(agents.entityId, entityId), eq(agents.active, true)))
    .orderBy(agents.name);
  let sharedFolder: string | null = null;
  const agentFolders: SandboxState['agents'] = [];
  for (const a of agentRows) {
    const resolved = await resolveRunWorkspaces(db, a.id, entityId);
    sharedFolder = resolved.sharedPath;
    agentFolders.push({
      id: a.id,
      name: a.name,
      runtime: a.runtime,
      folders: resolved.attached.map((w) => ({ label: w.label, path: w.path })),
    });
  }

  let network: SandboxState['network'];
  try {
    network = { deniedPorts: nodalDeniedEndpoints(sources.env).map((e) => e.port) };
  } catch (err) {
    if (!(err instanceof NodalPortsUnknown)) throw err;
    network = { code: err.code, reason: err.message };
  }

  const body: SandboxState = {
    platform: sources.machine?.platform ?? process.platform,
    status:
      status.state === 'available'
        ? {
            state: 'available',
            backend: status.backend,
            ...(status.limits ? { limits: [...status.limits] } : {}),
          }
        : { state: 'unavailable', code: status.code, reason: status.reason },
    enabled: settings.enabled,
    allowedFolders: composeAllowedFolders(settings.folders, sources.machine).map((f) => ({
      path: f.path,
      source: f.source,
      state: f.state,
    })),
    agents: agentFolders,
    sharedFolder,
    readRefused: nodalDataFolders(sources.machine),
    network,
  };
  return c.json(body, 200);
}
