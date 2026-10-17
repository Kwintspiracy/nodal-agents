// workspace-roots.test.ts — les racines des dossiers de travail d'une entité
// (P2bis, passe 57). Ce qui se prouve : le dossier PARTAGÉ, que le runner
// injecte sans le ranger en base, fait partie des racines ; et les plus
// longues viennent d'abord.

import { describe, it, expect, afterEach } from 'vitest';
import { join, resolve } from 'node:path';
import { entityWorkspaceRoots, sharedWorkspacePath } from '../workspace-roots.ts';

const ENTITY = '00000000-0000-0000-0000-000000000002';
// `resolve`, not `join`: under Windows `\srv\ws` depends on the current drive,
// and a path variable of Nodal must be fully qualified (packages/shared/src/nodal-home.ts).
const saved = process.env['NODALAI_WORKSPACES_ROOT'];

afterEach(() => {
  if (saved === undefined) delete process.env['NODALAI_WORKSPACES_ROOT'];
  else process.env['NODALAI_WORKSPACES_ROOT'] = saved;
});

/** Une base qui rend des lignes `agent_workspaces` : la chaîne Drizzle, réduite. */
function dbWith(paths: string[]) {
  const rows = paths.map((path) => ({ path }));
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    where: async () => rows,
  };
  return { select: () => chain } as unknown as Parameters<typeof entityWorkspaceRoots>[0];
}

describe('sharedWorkspacePath', () => {
  it('suit NODALAI_WORKSPACES_ROOT quand il est posé : <racine>/<entité>/shared', () => {
    process.env['NODALAI_WORKSPACES_ROOT'] = resolve('/srv', 'ws');
    expect(sharedWorkspacePath(ENTITY)).toBe(join(resolve('/srv', 'ws'), ENTITY, 'shared'));
  });
});

describe('entityWorkspaceRoots', () => {
  it('ajoute le dossier partagé aux racines des agents, les plus longues d’abord, sans doublon', async () => {
    process.env['NODALAI_WORKSPACES_ROOT'] = resolve('/srv', 'ws');
    const shared = join(resolve('/srv', 'ws'), ENTITY, 'shared');
    const roots = await entityWorkspaceRoots(
      dbWith(['C:\\Users\\q\\Documents\\Dev', 'D:\\Vault', 'C:\\Users\\q\\Documents\\Dev']),
      ENTITY,
    );
    expect(roots).toEqual([shared, 'C:\\Users\\q\\Documents\\Dev', 'D:\\Vault']);
  });

  it('une entité sans dossier d’agent a quand même sa racine partagée', async () => {
    process.env['NODALAI_WORKSPACES_ROOT'] = resolve('/srv', 'ws');
    expect(await entityWorkspaceRoots(dbWith([]), ENTITY)).toEqual([
      join(resolve('/srv', 'ws'), ENTITY, 'shared'),
    ]);
  });
});
