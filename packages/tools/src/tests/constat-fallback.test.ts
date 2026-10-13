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
// Le repli : un workspace qu'aucun dépôt ne couvre est constaté contre une copie
// figée de l'index de son instantané de checkpoint, pris avant tout outil qui
// écrit. Vraie base, vrai git, vrai `run_command` par le vrai `executeTool`.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
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
import { constatedGitWrites, snapshotGitAvant } from '../verification/git-constat';
import { snapshot } from '@nodal-agents/checkpoints';
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

    // L'image est constatée…
    expect(lignes).toContainEqual({
      path: normalizePath(await realpath(join(ws, 'outputs', 'c.png'))),
      kind: 'added',
      by: 'disk',
    });
    // …et `gen.js`, qui existait avant l'appel (écrit avant l'instantané),
    // n'est pas une écriture de la commande.
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

// ─── La comparaison elle-même, contre l'instantané figé (#590, revue A) ────────
//
// Le magasin des instantanés n'a jamais de HEAD : lire son `git status` tel
// quel sortait CHAQUE fichier photographié en `A`. Le constat compare donc
// l'arbre de travail à une copie FIGÉE de l'index de l'instantané, prise à
// l'avant, et n'en lit que la colonne arbre-de-travail.

/**
 * Un workspace photographié par le vrai `snapshot`, avec ses fichiers.
 * `timeoutMs` : la photographie est la MISE EN PLACE du test, pas son sujet.
 * Sur le runner Windows, `git add -A` de 1 100 fichiers dépasse la borne par
 * défaut de 30 s (CI Windows, main 4510428d) : le cas qui en a besoin la donne large.
 */
async function photographie(nom: string, fichiers: Record<string, string>, timeoutMs?: number) {
  const ws = join(racine, nom);
  await mkdir(ws, { recursive: true });
  for (const [f, contenu] of Object.entries(fichiers)) await writeFile(join(ws, f), contenu);
  const store = join(racine, `store-${nom}`);
  await snapshot(store, ws, 'le tour', timeoutMs === undefined ? {} : { timeoutMs });
  return { ws, store, reel: normalizePath(await realpath(ws)) };
}

const ecrits = (c: Awaited<ReturnType<typeof constatedGitWrites>>) =>
  c.fallbackWrites.map((w) => ({ path: w.path, kind: w.kind }));

describe('the fallback reads a frozen copy of the snapshot, not the store as is (#590) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('only what the call wrote is constated', async () => {
    const { ws, store, reel } = await photographie('delta', { 'a.txt': 'a', 'b.txt': 'b' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await writeFile(join(ws, 'c.txt'), 'c');

    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/c.txt`, kind: 'added' },
    ]);
  });

  it('a file that was there and is rewritten is modified, not added', async () => {
    const { ws, store, reel } = await photographie('modifie', { 'a.txt': 'avant' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await writeFile(join(ws, 'a.txt'), 'après');

    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/a.txt`, kind: 'modified' },
    ]);
  });

  it('more than MAX_STATUS_ENTRIES files already there do not hide the one written', async () => {
    const fichiers: Record<string, string> = {};
    for (let i = 0; i < 1100; i++) fichiers[`img-${i}.png`] = `image ${i}`;
    const { ws, store, reel } = await photographie('gros', fichiers, 240_000);
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await writeFile(join(ws, 'neuve.png'), 'neuve');

    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/neuve.png`, kind: 'added' },
    ]);
  }, 300_000);

  it('another job snapshotting between the before and the after does not swallow the write', async () => {
    const { ws, store, reel } = await photographie('concurrent', { 'a.txt': 'a' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await writeFile(join(ws, 'c.txt'), 'c');
    await writeFile(join(ws, 'a.txt'), 'a réécrit');
    // L'instantané d'un AUTRE job, sur le même workspace : il restage l'index
    // partagé, fichiers écrits par cet appel compris.
    await snapshot(store, ws, 'un autre job');

    expect(ecrits(await constatedGitWrites(avant))).toEqual(
      expect.arrayContaining([
        { path: `${reel}/c.txt`, kind: 'added' },
        { path: `${reel}/a.txt`, kind: 'modified' },
      ]),
    );
  });

  it('the snapshot index is only read, and no frozen copy is left behind', async () => {
    const { ws, store } = await photographie('lecture', { 'a.txt': 'a' });
    const indexes = join(store, 'indexes');
    const [cle] = await readdir(indexes);
    const octetsAvant = await readFile(join(indexes, cle!));
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await writeFile(join(ws, 'c.txt'), 'c');
    await constatedGitWrites(avant);

    expect((await readFile(join(indexes, cle!))).equals(octetsAvant)).toBe(true);
    expect(await readdir(indexes)).toEqual([cle]);
  });

  it('each missing piece says its own reason', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const jamais = join(racine, 'jamais-photographie');
      await mkdir(jamais, { recursive: true });
      // Un magasin qui existe, mais aucun instantané de CE workspace.
      const { store } = await photographie('autre-ws', { 'a.txt': 'a' });
      await snapshotGitAvant([jamais], { store, workspaces: [jamais] });
      const dit = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(dit.some((l) => l.includes('reason=never_snapshotted'))).toBe(true);
      expect(dit.some((l) => l.includes('GIT_CONSTAT_STATUS_FAILED'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('what the snapshot does not cover is said once per workspace AND per job', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const { ws, store } = await photographie('couverture', { 'a.txt': 'a' });
      const appel = async (jobId: string) =>
        constatedGitWrites(await snapshotGitAvant([ws], { store, workspaces: [ws], jobId }));
      await appel('job-1');
      await appel('job-1');
      await appel('job-2');
      const dit = warn.mock.calls
        .map((c) => c.map(String).join(' '))
        .filter((l) => l.includes('GIT_CONSTAT_FALLBACK_COVERAGE'));
      // Une fois pour job-1 malgré ses deux appels, et de nouveau pour job-2 :
      // un runner qui tourne des semaines ne devient pas muet.
      expect(dit).toHaveLength(2);
      expect(dit[0]).toContain('job=job-1');
      expect(dit[1]).toContain('job=job-2');
      expect(dit[0]).toContain('node_modules/');
      expect(dit[0]).toContain('.gitignore');
    } finally {
      warn.mockRestore();
    }
  });

  it('a deleted file is constated deleted', async () => {
    const { ws, store, reel } = await photographie('supprime', { 'a.txt': 'a', 'b.txt': 'b' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await rm(join(ws, 'a.txt'));

    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/a.txt`, kind: 'deleted' },
    ]);
  });

  it('a write in a path the snapshot excludes is not constated', async () => {
    const { ws, store, reel } = await photographie('exclu', { 'a.txt': 'a' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });
    await mkdir(join(ws, 'dist'), { recursive: true });
    await writeFile(join(ws, 'dist', 'x.js'), 'x');
    await writeFile(join(ws, 'c.txt'), 'c');

    // Seul `c.txt` : `dist/` est une exclusion du magasin, et c'est la limite
    // que GIT_CONSTAT_FALLBACK_COVERAGE annonce.
    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/c.txt`, kind: 'added' },
    ]);
  });

  it('more than MAX_STATUS_ENTRIES changes since the snapshot: nothing is constated, and it is said', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const { ws, store } = await photographie('trop-change', { 'a.txt': 'a' });
      // Des changements APRÈS l'instantané du tour (des appels précédents du
      // même tour, par exemple) : la borne compte ce qui a changé, pas ce qui
      // est là.
      for (let i = 0; i < 1001; i++) await writeFile(join(ws, `n-${i}.png`), `n ${i}`);
      const avant = await snapshotGitAvant([ws], { store, workspaces: [ws] });

      expect(avant).toEqual([]);
      const dit = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(dit.some((l) => l.includes('GIT_CONSTAT_TREE_TOO_DIRTY'))).toBe(true);
      expect(
        (await readdir(join(store, 'indexes'))).filter((f) => f.includes('.constat-')),
      ).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  }, 60_000);

  it('an index that cannot be copied is freeze_failed', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const { ws, store } = await photographie('gel-impossible', { 'a.txt': 'a' });
      const indexes = join(store, 'indexes');
      const [cle] = await readdir(indexes);
      // Un dossier à la place de l'index : il existe, mais ne se lit pas.
      await rm(join(indexes, cle!));
      await mkdir(join(indexes, cle!));
      expect(await snapshotGitAvant([ws], { store, workspaces: [ws] })).toEqual([]);
      const dit = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(dit.some((l) => l.includes('reason=freeze_failed'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('an index git refuses is snapshot_status_failed, and its copy is released', async () => {
    const warn = vi.spyOn(console, 'warn');
    try {
      const { ws, store } = await photographie('index-casse', { 'a.txt': 'a' });
      const indexes = join(store, 'indexes');
      const [cle] = await readdir(indexes);
      await writeFile(join(indexes, cle!), 'pas un index git');
      expect(await snapshotGitAvant([ws], { store, workspaces: [ws] })).toEqual([]);
      const dit = warn.mock.calls.map((c) => c.map(String).join(' '));
      expect(dit.some((l) => l.includes('reason=snapshot_status_failed'))).toBe(true);
      expect(await readdir(indexes)).toEqual([cle]);
    } finally {
      warn.mockRestore();
    }
  });

  it('the same workspace listed twice is frozen once, and no copy is left behind', async () => {
    const { ws, store, reel } = await photographie('deux-fois', { 'a.txt': 'a' });
    const avant = await snapshotGitAvant([ws], { store, workspaces: [ws, `${ws}/`] });
    expect(avant).toHaveLength(1);
    await writeFile(join(ws, 'c.txt'), 'c');

    expect(ecrits(await constatedGitWrites(avant))).toEqual([
      { path: `${reel}/c.txt`, kind: 'added' },
    ]);
    expect((await readdir(join(store, 'indexes'))).filter((f) => f.includes('.constat-'))).toEqual(
      [],
    );
  });
});

describe('a call whose after is never read leaves no frozen copy (#590) @cap:travailler-sur-des-fichiers/moteur', () => {
  it('a tool that throws', async () => {
    const ws = join(racine, 'echec');
    await mkdir(ws, { recursive: true });
    const store = join(racine, 'store-echec');
    const job = await delegue();
    const rule = { ...autoApprouve.approvalRules[0], entityId: seed.entityId } as ApprovalRule;
    // Le vrai `run_command` — mêmes cibles, même approbation — dont l'exécution
    // lève : l'après n'est jamais lu.
    const qui_leve = {
      ...(registry.get('run_command') as object),
      execute: async () => {
        throw new Error('panne');
      },
    };
    const res = await executeTool(
      qui_leve as never,
      { purpose: 'échouer', command: 'node gen.js', cwd: ws },
      {
        db,
        entityId: seed.entityId,
        agentId: seed.agentId,
        jobId: job,
        jobChatId: null,
        workspaces: [{ label: 'comfy', path: ws }],
        checkpointsRoot: store,
        turn: 1,
      } as unknown as ToolContext,
      { ...autoApprouve, approvalRules: [rule] } as never,
    );
    expect(res.outcome).toBe('error');
    const restes = (await readdir(join(store, 'indexes'))).filter((f) => f.includes('.constat-'));
    expect(restes).toEqual([]);
  });
});
