// sandbox-switch.test.ts — l'interrupteur du bac à sable de l'ESPACE (#876), à
// travers les vrais `run_command` et `run_skill_script`, sur une vraie base :
//
//   - coupé (`entities.sandbox_enabled = false`), la commande tourne sans
//     confinement et son résultat le dit par un code à lui, `SANDBOX_DISABLED` ;
//     le conteneur n'est même pas demandé ;
//   - le réglage est relu à CHAQUE commande : rallumé, la commande suivante du
//     MÊME job repart confinée, sans redémarrer quoi que ce soit ;
//   - les dossiers que l'utilisateur ajoute arrivent dans les dossiers
//     inscriptibles du conteneur ;
//   - un réglage illisible refuse la commande avec son code, jamais « allumé »
//     ni « éteint » en silence.
//
// Le bac à sable est un backend FACTICE disponible, sur tous les systèmes : son
// conteneur note les dossiers qu'on lui donne et refuse de démarrer — une
// commande confinée se reconnaît donc à son refus `FAKE_CONTAINER`, une
// commande non confinée à sa vraie sortie.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq, entities, sql } from '@nodal-agents/db';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import {
  SandboxStartError,
  closeJobProcessScope,
  createSandbox,
  jobProcessScope,
  type SandboxBackend,
} from '@nodal-agents/sandbox';
import { runCommandTool } from '../builtin/run-command';
import { runSkillScriptTool } from '../builtin/run-skill-script';
import type { ToolContext } from '../types';

const SLUG = 'switch-skill';
let db: Awaited<ReturnType<typeof spinUpTestDb>>['db'];
let seed: Awaited<ReturnType<typeof seedMinimal>>;
let ws: string;
let outside: string;
let store: string;
let extra: string;
/** Les dossiers inscriptibles de chaque conteneur demandé. */
const opened: (readonly string[])[] = [];

const backend: SandboxBackend = {
  probe: async () => ({ state: 'available', backend: 'fake-backend' }),
  openContainer: async (roots) => {
    opened.push(roots);
    throw new SandboxStartError('FAKE_CONTAINER: this command would have been confined');
  },
};

function ctx(): ToolContext {
  return {
    jobId: seed.jobId,
    agentId: seed.agentId,
    entityId: seed.entityId,
    db: db as unknown as ToolContext['db'],
    jobChatId: null,
    workspaces: [{ label: 'ws', path: ws }],
    skillStoreDir: store,
    assignedSkillSlugs: [SLUG],
    scriptAuthorizedSkillSlugs: [SLUG],
  };
}

const setEnabled = (enabled: boolean) =>
  db.update(entities).set({ sandboxEnabled: enabled }).where(eq(entities.id, seed.entityId));

/** Une commande qui écrit HORS de tout dossier du job : seule une commande non confinée le peut. */
const writeOutside = (name: string) =>
  runCommandTool.execute(
    {
      purpose: 'sandbox switch',
      command: `"${process.execPath}" -e "require('fs').writeFileSync(process.argv[1], 'written')" "${join(outside, name)}"`,
    },
    ctx(),
  );

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
  ws = await mkdtemp(join(tmpdir(), 'nodal-switch-ws-'));
  outside = await mkdtemp(join(tmpdir(), 'nodal-switch-out-'));
  extra = await mkdtemp(join(tmpdir(), 'nodal-switch-extra-'));
  store = await mkdtemp(join(tmpdir(), 'nodal-switch-store-'));
  await mkdir(join(store, SLUG, 'scripts'), { recursive: true });
  await writeFile(join(store, SLUG, 'scripts', 'hello.js'), "console.log('hello');\n");
  // Le périmètre du job, sous le bac à sable factice : `run_command` et
  // `run_skill_script` le retrouvent par `jobProcessScope(ctx.jobId)`.
  jobProcessScope(seed.jobId, createSandbox(backend, { log: () => {} }));
});

afterAll(async () => {
  await closeJobProcessScope(seed.jobId);
  for (const d of [ws, outside, extra, store]) await rm(d, { recursive: true, force: true });
});

describe('the workspace sandbox switch, through the real tools @cap:executer-une-commande/moteur', () => {
  it('on by default: the command goes to the container, with the job folders', async () => {
    opened.length = 0;
    const out = await writeOutside('default.txt');
    expect(out.sandbox).toMatchObject({ confined: true });
    expect(out.exitCode).toBeNull();
    expect(out.stderr).toContain('FAKE_CONTAINER');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(ws);
    expect(existsSync(join(outside, 'default.txt'))).toBe(false);
  });

  it('switched off: run_command runs unconfined, writes for real, and says SANDBOX_DISABLED', async () => {
    await setEnabled(false);
    opened.length = 0;
    const out = await writeOutside('off.txt');
    expect(out.exitCode).toBe(0);
    expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_DISABLED' });
    expect(readFileSync(join(outside, 'off.txt'), 'utf8')).toBe('written');
    expect(opened, 'the container must not even be asked for').toHaveLength(0);
  });

  it('switched off: run_skill_script says SANDBOX_DISABLED too, its real output intact', async () => {
    await setEnabled(false);
    const out = await runSkillScriptTool.execute(
      { purpose: 'sandbox switch', skill: SLUG, script: 'scripts/hello.js' },
      ctx(),
    );
    expect(out.exitCode).toBe(0);
    expect(out.stdout.trim()).toBe('hello');
    expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_DISABLED' });
  });

  it('the setting is re-read at every command: on, off, on again within the same job', async () => {
    await setEnabled(true);
    expect((await writeOutside('a.txt')).sandbox).toMatchObject({ confined: true });
    await setEnabled(false);
    expect((await writeOutside('b.txt')).sandbox).toEqual({
      confined: false,
      code: 'SANDBOX_DISABLED',
    });
    await setEnabled(true);
    expect((await writeOutside('c.txt')).sandbox).toMatchObject({ confined: true });
    expect(existsSync(join(outside, 'a.txt'))).toBe(false);
    expect(existsSync(join(outside, 'b.txt'))).toBe(true);
    expect(existsSync(join(outside, 'c.txt'))).toBe(false);
  });

  it('a folder the user added reaches the writable roots of the next container', async () => {
    await setEnabled(true);
    await db
      .update(entities)
      .set({ sandboxFolders: { added: [extra], removed: [] } })
      .where(eq(entities.id, seed.entityId));
    opened.length = 0;
    await writeOutside('extra.txt');
    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain(extra);
    await db
      .update(entities)
      .set({ sandboxFolders: { added: [], removed: [] } })
      .where(eq(entities.id, seed.entityId));
  });

  it('an unreadable setting refuses the command with its code, and nothing runs', async () => {
    await db.execute(
      sql`UPDATE entities SET sandbox_folders = '{"added": "not a list"}'::jsonb WHERE id = ${seed.entityId}`,
    );
    opened.length = 0;
    const out = await writeOutside('unreadable.txt');
    expect(out.exitCode).toBeNull();
    expect(out.stderr).toContain('SANDBOX_SETTINGS_UNREADABLE');
    expect(out.sandbox).toEqual({ confined: false, code: 'SANDBOX_SETTINGS_UNREADABLE' });
    expect(existsSync(join(outside, 'unreadable.txt'))).toBe(false);
    expect(opened).toHaveLength(0);
    await db
      .update(entities)
      .set({ sandboxFolders: { added: [], removed: [] } })
      .where(eq(entities.id, seed.entityId));
  });
});
