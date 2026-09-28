// constat-fallback.test.ts — une écriture faite par le shell est constatée même
// quand le workspace n'est pas la racine d'un dépôt git (#590).
//
// Chez le propriétaire, `C:/Users/kwint` est lui-même un dépôt git. Le constat
// par git refusait donc le dépôt de tout workspace posé dessous
// (`GIT_CONSTAT_ROOT_ABOVE_SCOPE`, 678 fois dans runner.log) — à raison : il
// aurait constaté tout le profil. Mais il ne constatait alors RIEN : l'image que
// ComfyArtist produit par `comfy` (un `run_command`) n'entrait jamais dans
// `constated_writes`, la règle des descendants (#589) n'avait rien à admettre,
// et Alfred repartait en détours de copie.
//
// Le repli : un workspace qu'aucun dépôt ne couvre est constaté contre l'index
// de son instantané de checkpoint, pris avant tout outil qui écrit. Vraie base,
// vrai git, vrai `run_command` par le vrai `executeTool`.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, constatedWrites, eq } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { executeTool } from '../execute';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { fileProducedByDescendant } from '../descendant-files';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

const run = promisify(execFile);

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let racine: string;
let rootJob: string;
const registry = createToolRegistry();
registerBuiltins(registry);

beforeAll(async () => {
  db = (await spinUpTestDb()).db;
  seed = await seedMinimal(db);
  racine = await realpath(await mkdtemp(join(tmpdir(), 'nodal-constat-repli-')));
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'demande une image',
      status: 'processing',
    })
    .returning({ id: agentJobs.id });
  rootJob = row!.id;
});

afterAll(async () => {
  await rm(racine, { recursive: true, force: true }).catch(() => undefined);
});

/** Le délégué de la racine, qui tourne en ce moment. */
async function delegue(): Promise<string> {
  const [row] = await db
    .insert(agentJobs)
    .values({
      entityId: seed.entityId,
      agentId: seed.agentId,
      channel: 'api',
      task: 'génère l’image',
      status: 'processing',
      parentJobId: rootJob,
      createdAt: new Date(Date.now() - 1_000),
    })
    .returning({ id: agentJobs.id });
  return row!.id;
}

const autoApprouve: ExecuteOptions = {
  approvalRules: [
    {
      id: 'rule-run-command-590',
      toolName: 'run_command',
      action: 'auto_approve',
      agentId: null,
      entityId: '',
    } as unknown as ApprovalRule,
  ],
  onApprovalRequired: async () => {},
} as unknown as ExecuteOptions;

/**
 * Lance, par le vrai `run_command`, un script qui écrit `outputs/<nom>` comme
 * ComfyUI le ferait, et rend les lignes de constat de ce job.
 */
async function genererDans(ws: string, store: string, nom: string, jobId: string) {
  await writeFile(
    join(ws, 'gen.js'),
    `require('fs').mkdirSync('outputs', { recursive: true });\n` +
      `require('fs').writeFileSync('outputs/${nom}', 'image ${nom}');\n`,
  );
  const rule = { ...autoApprouve.approvalRules[0], entityId: seed.entityId } as ApprovalRule;
  const res = await executeTool(
    registry.get('run_command') as never,
    { purpose: 'générer', command: 'node gen.js', cwd: ws },
    {
      db,
      entityId: seed.entityId,
      agentId: seed.agentId,
      jobId,
      jobChatId: null,
      workspaces: [{ label: 'comfy', path: ws }],
      checkpointsRoot: store,
      turn: 1,
    } as unknown as ToolContext,
    { ...autoApprouve, approvalRules: [rule] } as never,
  );
  expect(res.outcome, JSON.stringify(res)).toBe('success');
  return db
    .select({
      path: constatedWrites.path,
      kind: constatedWrites.changeKind,
      by: constatedWrites.constatedBy,
    })
    .from(constatedWrites)
    .where(eq(constatedWrites.jobId, jobId));
}

describe('a shell write is constated without a git root at the workspace (#590) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('workspace inside a repo rooted ABOVE it: the file is constated, and the root may send it', async () => {
    const dessus = join(racine, 'maison');
    await mkdir(dessus, { recursive: true });
    await run('git', ['init', '--quiet'], { cwd: dessus });
    const ws = join(dessus, 'Documents', 'Nodal', 'ComfyArtist');
    await mkdir(ws, { recursive: true });
    const job = await delegue();

    const lignes = await genererDans(ws, join(racine, 'store-dessus'), 'a.png', job);

    const image = normalizePath(await realpath(join(ws, 'outputs', 'a.png')));
    expect(lignes).toContainEqual({ path: image, kind: 'added', by: 'disk' });
    // La règle des descendants (#589) a maintenant quelque chose à admettre.
    await expect(
      fileProducedByDescendant({ db, jobId: rootJob, entityId: seed.entityId } as never, image),
    ).resolves.toEqual({ kind: 'produced' });
  });

  it('workspace outside any repo: the same', async () => {
    // Un dossier temporaire peut lui-même tomber sous un dépôt (la maison
    // versionnée de la machine qui teste) : c'est alors le cas du dessus, et le
    // repli vaut pour les deux.
    const ws = join(racine, 'sans-depot');
    await mkdir(ws, { recursive: true });
    const job = await delegue();

    const lignes = await genererDans(ws, join(racine, 'store-sans'), 'b.png', job);

    const image = normalizePath(await realpath(join(ws, 'outputs', 'b.png')));
    expect(lignes).toContainEqual({ path: image, kind: 'added', by: 'disk' });
  });

  it('the script that was already there is not constated as written by this call', async () => {
    const ws = join(racine, 'deja-la');
    await mkdir(ws, { recursive: true });
    const job = await delegue();

    const lignes = await genererDans(ws, join(racine, 'store-deja'), 'c.png', job);

    // `gen.js` existait avant l'appel (écrit avant l'instantané) : il n'est
    // pas une écriture de la commande.
    expect(lignes.map((l) => l.path)).not.toContain(
      normalizePath(await realpath(join(ws, 'gen.js'))),
    );
  });

  it('without a checkpoint store nothing covers the workspace, and it is said', async () => {
    const warn = vi.spyOn(console, 'warn');
    const ws = join(racine, 'sans-magasin');
    await mkdir(ws, { recursive: true });
    const job = await delegue();
    await writeFile(join(ws, 'gen.js'), `require('fs').writeFileSync('d.png', 'image d');\n`);
    try {
      const res = await executeTool(
        registry.get('run_command') as never,
        { purpose: 'générer', command: 'node gen.js', cwd: ws },
        {
          db,
          entityId: seed.entityId,
          agentId: seed.agentId,
          jobId: job,
          jobChatId: null,
          workspaces: [{ label: 'comfy', path: ws }],
          turn: 1,
        } as unknown as ToolContext,
        {
          ...autoApprouve,
          approvalRules: [{ ...autoApprouve.approvalRules[0], entityId: seed.entityId }],
        } as never,
      );
      expect(res.outcome).toBe('success');
      const dit = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(
        dit.some((l) => l.includes('GIT_CONSTAT_NO_FALLBACK') && l.includes('no_checkpoint_store')),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});
