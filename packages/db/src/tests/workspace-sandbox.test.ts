// workspace-sandbox.test.ts — le réglage du bac à sable d'un espace (#876), en
// base : lu tel qu'écrit, jamais deviné. Les gestes simultanés, eux, se
// prouvent sur un vrai Postgres (workspace-sandbox-gestures.pg.test.ts).

import { describe, it, expect, beforeAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { entities } from '../schema/index.ts';
import {
  applySandboxFolderGesture,
  changeWorkspaceSandboxFolders,
  readWorkspaceSandbox,
  setWorkspaceSandboxEnabled,
  workspaceSandboxReader,
} from '../repos/workspace-sandbox.ts';
import { spinUpTestDb, seedMinimal, type TestDb } from './helpers.ts';

let db: TestDb;
let entityId: string;

/** Comme sous Windows : la casse repliée. */
const folderKey = (p: string): string => p.toLowerCase();
const writeFolders = (folders: { added: string[]; removed: string[] }) =>
  db.update(entities).set({ sandboxFolders: folders }).where(eq(entities.id, entityId));

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
    expect(
      await changeWorkspaceSandboxFolders(
        db,
        entityId,
        { op: 'add', path: 'D:\\Models', awaitsConfirmation: false },
        folderKey,
      ),
    ).toBe('added');
    expect(
      await changeWorkspaceSandboxFolders(
        db,
        entityId,
        { op: 'remove', path: 'C:\\Users\\me\\.ollama\\models' },
        folderKey,
      ),
    ).toBe('removed');
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
    await writeFolders({ added: [], removed: [] });
  });

  it('a column in an unknown shape fails loud with its code, never read as an empty list, and no gesture writes over it', async () => {
    await db.execute(
      sql`UPDATE entities SET sandbox_folders = '{"added": ["x"]}'::jsonb WHERE id = ${entityId}`,
    );
    await expect(readWorkspaceSandbox(db, entityId)).rejects.toThrow(
      /^SANDBOX_SETTINGS_UNREADABLE: sandbox_folders removed/,
    );
    await expect(
      changeWorkspaceSandboxFolders(db, entityId, { op: 'remove', path: 'x' }, folderKey),
    ).rejects.toThrow(/^SANDBOX_SETTINGS_UNREADABLE: sandbox_folders removed/);
    await writeFolders({ added: [], removed: [] });
  });

  it('an unknown workspace fails loud, it is never read as on', async () => {
    await expect(readWorkspaceSandbox(db, '00000000-0000-4000-8000-000000000000')).rejects.toThrow(
      'SANDBOX_SETTINGS_UNREADABLE: workspace 00000000-0000-4000-8000-000000000000 not found',
    );
  });

  it('a value the reader would refuse is never written', async () => {
    await expect(
      changeWorkspaceSandboxFolders(
        db,
        entityId,
        { op: 'add', path: '', awaitsConfirmation: false },
        folderKey,
      ),
    ).rejects.toThrow('SANDBOX_SETTINGS_UNREADABLE');
    expect((await readWorkspaceSandbox(db, entityId)).folders).toEqual({ added: [], removed: [] });
  });

  it('a gesture that changes nothing writes nothing, and says what it found', async () => {
    await writeFolders({ added: ['D:\\Models'], removed: ['C:\\cache\\hf'] });
    const outcomes = [];
    for (const g of [
      { op: 'add', path: 'd:\\models', awaitsConfirmation: false },
      { op: 'add', path: 'E:\\big', awaitsConfirmation: true },
      { op: 'remove', path: 'c:\\CACHE\\hf' },
      { op: 'restore', path: 'E:\\never-removed' },
    ] as const) {
      outcomes.push(await changeWorkspaceSandboxFolders(db, entityId, g, folderKey));
    }
    expect(outcomes).toEqual(['already-allowed', 'needs-confirmation', 'unchanged', 'unchanged']);
    expect((await readWorkspaceSandbox(db, entityId)).folders).toEqual({
      added: ['D:\\Models'],
      removed: ['C:\\cache\\hf'],
    });
    await writeFolders({ added: [], removed: [] });
  });
});

describe('applySandboxFolderGesture — one gesture on the gestures already made @cap:executer-une-commande/moteur', () => {
  const none = { added: [], removed: [] };

  it('add: a removed folder is restored first, even one that would need a confirmation', () => {
    expect(
      applySandboxFolderGesture(
        { added: [], removed: ['C:\\Hf'] },
        { op: 'add', path: 'c:\\hf', awaitsConfirmation: true },
        folderKey,
      ),
    ).toEqual({ folders: none, outcome: 'restored' });
    expect(
      applySandboxFolderGesture(
        none,
        { op: 'add', path: 'C:\\', awaitsConfirmation: true },
        folderKey,
      ),
    ).toEqual({ folders: none, outcome: 'needs-confirmation' });
    expect(
      applySandboxFolderGesture(
        none,
        { op: 'add', path: 'C:\\', awaitsConfirmation: false },
        folderKey,
      ),
    ).toEqual({ folders: { added: ['C:\\'], removed: [] }, outcome: 'added' });
  });

  it('remove: an addition is forgotten, a detected folder is recorded removed once', () => {
    expect(
      applySandboxFolderGesture(
        { added: ['E:\\a'], removed: [] },
        { op: 'remove', path: 'e:\\A' },
        folderKey,
      ),
    ).toEqual({ folders: none, outcome: 'forgotten' });
    expect(applySandboxFolderGesture(none, { op: 'remove', path: 'E:\\d' }, folderKey)).toEqual({
      folders: { added: [], removed: ['E:\\d'] },
      outcome: 'removed',
    });
  });

  it('restore: only a removed folder is restored', () => {
    expect(
      applySandboxFolderGesture(
        { added: [], removed: ['E:\\d', 'E:\\e'] },
        { op: 'restore', path: 'E:\\D' },
        folderKey,
      ),
    ).toEqual({ folders: { added: [], removed: ['E:\\e'] }, outcome: 'restored' });
  });
});
