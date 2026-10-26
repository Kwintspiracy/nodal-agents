// workspace-sandbox.test.ts — le réglage du bac à sable d'un espace (#876), en
// base : lu tel qu'écrit, jamais deviné.

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { entities } from '../schema/index.ts';
import {
  readWorkspaceSandbox,
  setWorkspaceSandboxEnabled,
  setWorkspaceSandboxFolders,
  workspaceSandboxReader,
} from '../repos/workspace-sandbox.ts';
import { spinUpTestDb, seedMinimal, type TestDb } from './helpers.ts';

let db: TestDb;
let entityId: string;

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  entityId = (await seedMinimal(db)).entityId;
});

describe('readWorkspaceSandbox @cap:executer-une-commande/moteur', () => {
  it('a new workspace: the switch on, no gesture on the folders', async () => {
    expect(await readWorkspaceSandbox(db, entityId)).toEqual({
      enabled: true,
      folders: { added: [], removed: [] },
    });
  });

  it('persists the switch and the gestures, and the reader returns what was written', async () => {
    await setWorkspaceSandboxEnabled(db, entityId, false);
    await setWorkspaceSandboxFolders(db, entityId, {
      added: ['D:\\Models'],
      removed: ['C:\\Users\\me\\.ollama\\models'],
    });
    const [row] = await db
      .select({ enabled: entities.sandboxEnabled, folders: entities.sandboxFolders })
      .from(entities)
      .where(eq(entities.id, entityId));
    expect(row).toEqual({
      enabled: false,
      folders: { added: ['D:\\Models'], removed: ['C:\\Users\\me\\.ollama\\models'] },
    });
    expect(await workspaceSandboxReader(db, entityId)()).toEqual({
      enabled: false,
      folders: { added: ['D:\\Models'], removed: ['C:\\Users\\me\\.ollama\\models'] },
    });
    await setWorkspaceSandboxEnabled(db, entityId, true);
    expect((await readWorkspaceSandbox(db, entityId)).enabled).toBe(true);
  });

  it('a column in an unknown shape fails loud with its code, never read as an empty list', async () => {
    await db.execute(
      sql`UPDATE entities SET sandbox_folders = '{"added": ["x"]}'::jsonb WHERE id = ${entityId}`,
    );
    await expect(readWorkspaceSandbox(db, entityId)).rejects.toThrow(
      /^SANDBOX_SETTINGS_UNREADABLE: sandbox_folders removed/,
    );
    await setWorkspaceSandboxFolders(db, entityId, { added: [], removed: [] });
  });

  it('an unknown workspace fails loud, it is never read as on', async () => {
    await expect(readWorkspaceSandbox(db, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'SANDBOX_SETTINGS_UNREADABLE: workspace 00000000-0000-4000-8000-000000000000 not found',
    );
  });

  it('a value the reader would refuse is never written', async () => {
    await expect(
      setWorkspaceSandboxFolders(db, entityId, { added: [''], removed: [] }),
    ).rejects.toThrow('SANDBOX_SETTINGS_UNREADABLE');
    expect((await readWorkspaceSandbox(db, entityId)).folders).toEqual({ added: [], removed: [] });
  });
});
