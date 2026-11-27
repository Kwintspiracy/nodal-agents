// skill-folder-update.test.ts — an installed community skill is the full list
// of its files. An update or a reinstall compares every file, never deletes
// one the source did not ship, shows what will change before it changes, and
// applies completely or not at all.
//
// Real pglite DB, a temporary skill store, a source served from memory (the
// clawhub zip endpoint, mocked: no network). Assertions are on the bytes in
// the store and on the rows. node:fs/promises is wrapped so a test can make
// one precise filesystem step fail; every other call goes to the real module.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import { eq, and, agentSkills, agentSkillAssignments } from '@nodal-agents/db';
import {
  installCommunitySkill,
  applySkillUpdate,
  previewSkillUpdate,
  acknowledgeSkillUpdate,
  SkillInstallError,
} from './install';
import { checkSkillUpdate } from './check-updates';
import { isCaseInsensitiveDir } from './manifest';

// A hook returns an error to throw, 'done' when it performed the call itself, or null.
const fsHooks = vi.hoisted(() => new Map<string, (...args: unknown[]) => Error | 'done' | null>());

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const wrap =
    <K extends 'cp' | 'copyFile' | 'rename'>(name: K) =>
    async (...args: unknown[]): Promise<unknown> => {
      const hook = fsHooks.get(name);
      const err = hook ? hook(...args) : null;
      if (err === 'done') return undefined;
      if (err) throw err;
      return (real[name] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  const mocked = { ...real, cp: wrap('cp'), copyFile: wrap('copyFile'), rename: wrap('rename') };
  return { ...mocked, default: mocked };
});

function fsError(code: string): Error {
  return Object.assign(new Error(`${code}: injected failure`), { code });
}

type Entry = [string, string | Uint8Array];

function makeZip(entries: Entry[]): Buffer {
  const files: Record<string, Uint8Array> = {};
  for (const [name, content] of entries)
    files[name] = typeof content === 'string' ? strToU8(content) : content;
  return Buffer.from(zipSync(files));
}

function serve(slug: string, entries: Entry[]): void {
  global.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input);
    if (url === `https://clawhub.ai/api/v1/download?slug=${slug}`) {
      return new Response(new Uint8Array(makeZip(entries)), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

const skillMd = (slug: string, body: string): Entry => [
  'SKILL.md',
  `---\nname: ${slug}\ndescription: d\n---\n${body}`,
];

const BINARY = Uint8Array.from({ length: 256 }, (_, i) => i);
const BINARY_V2 = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) % 256);

let counter = 0;
function freshSlug(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now()}-${counter}`;
}

describe('an installed skill is the full list of its files @cap:apprendre-une-skill/moteur', () => {
  const origFetch = global.fetch;
  let store: string;

  beforeEach(async () => {
    store = await mkdtemp(join(tmpdir(), 'nodal-skill-folder-'));
    fsHooks.clear();
  });

  afterEach(async () => {
    fsHooks.clear();
    global.fetch = origFetch;
    await rm(store, { recursive: true, force: true });
  });

  async function setup(prefix: string, entries: (slug: string) => Entry[]) {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = freshSlug(prefix);
    serve(slug, entries(slug));
    const result = await installCommunitySkill({
      db: db as never,
      source: `https://clawhub.ai/pub/${slug}`,
      skillStoreDir: store,
      entityId: seed.entityId,
    });
    const dir = join(store, slug);
    const opts = { db: db as never, slug, skillStoreDir: store, entityId: seed.entityId };
    const row = async () => {
      const [r] = await db.select().from(agentSkills).where(eq(agentSkills.slug, slug));
      if (!r) throw new Error('skill row missing');
      return r;
    };
    return { db, seed, slug, dir, opts, row, result };
  }

  async function put(dir: string, rel: string, content: string | Uint8Array): Promise<void> {
    const abs = join(dir, ...rel.split('/'));
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, content);
  }

  const text = (dir: string, rel: string) => readFile(join(dir, ...rel.split('/')), 'utf8');
  const bytes = (dir: string, rel: string) => readFile(join(dir, ...rel.split('/')));

  // ── 1. FK1-01: a file added to the folder survives an update and a reinstall ──

  it('a file added to the folder survives an update byte for byte, and is listed in the review', async () => {
    const s = await setup('keep-added', (slug) => [
      skillMd(slug, 'v1'),
      ['references/guide.md', 'guide v1'],
    ]);
    // What an agent's skill_file_write leaves: a workflow, and a binary file.
    await put(s.dir, 'workflows/mine.json', '{"steps":[1,2,3]}');
    await put(s.dir, 'workflows/thumb.bin', BINARY);

    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/guide.md', 'guide v1']]);
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'SKILL.md', kind: 'changed' },
      { path: 'workflows/mine.json', kind: 'kept-local-addition' },
      { path: 'workflows/thumb.bin', kind: 'kept-local-addition' },
    ]);
    expect(preview.filesState).toBe('update');

    const result = await applySkillUpdate({
      ...s.opts,
      expectedContentHash: preview.upstreamContentHash,
      expectedFilesHash: preview.upstreamFilesHash,
    });
    expect(result.files).toEqual(preview.files);
    expect(await text(s.dir, 'workflows/mine.json')).toBe('{"steps":[1,2,3]}');
    expect(Buffer.compare(await bytes(s.dir, 'workflows/thumb.bin'), Buffer.from(BINARY))).toBe(0);
    expect(await text(s.dir, 'SKILL.md')).toContain('v2');
    expect(await text(s.dir, 'references/guide.md')).toBe('guide v1');

    const after = await s.row();
    // The manifest lists what the source shipped — never the local additions.
    expect(after.installedFiles?.map((e) => e.path)).toEqual(['SKILL.md', 'references/guide.md']);
    // No staging or previous folder is left beside the skill.
    expect(await readdir(store)).toEqual([s.slug]);
  });

  it('installing the same source again changes nothing and sends the person to the update review', async () => {
    const s = await setup('reinstall', (slug) => [
      skillMd(slug, 'v1'),
      ['scripts/run.py', 'print(1)'],
    ]);
    await put(s.dir, 'workflows/mine.json', 'mine');
    await s.db
      .update(agentSkills)
      .set({ content: 'owner edit', contentOverridden: true })
      .where(eq(agentSkills.slug, s.slug));
    const [assignment] = await s.db
      .insert(agentSkillAssignments)
      .values({
        entityId: s.seed.entityId,
        agentId: s.seed.agentId,
        skillId: (await s.row()).id,
        scriptsAuthorized: true,
      })
      .returning();
    const before = await s.row();

    serve(s.slug, [skillMd(s.slug, 'v2'), ['scripts/run.py', 'print(2)']]);
    const again = await installCommunitySkill({
      db: s.db as never,
      source: `https://clawhub.ai/pub/${s.slug}`,
      skillStoreDir: store,
      entityId: s.seed.entityId,
    });

    expect(again.status).toBe('already_installed');
    // Nothing written: the folder, the row, the authorization.
    expect(await text(s.dir, 'workflows/mine.json')).toBe('mine');
    expect(await text(s.dir, 'scripts/run.py')).toBe('print(1)');
    const after = await s.row();
    expect(after.content).toBe('owner edit');
    expect(after.contentOverridden).toBe(true);
    expect(after.defaultContent).toBe(before.defaultContent);
    expect(after.installedFiles).toEqual(before.installedFiles);
    const [a] = await s.db
      .select()
      .from(agentSkillAssignments)
      .where(eq(agentSkillAssignments.id, assignment!.id));
    expect(a!.scriptsAuthorized).toBe(true);

    // The review it leads to shows the script change and keeps the addition.
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'SKILL.md', kind: 'changed' },
      { path: 'scripts/run.py', kind: 'changed' },
      { path: 'workflows/mine.json', kind: 'kept-local-addition' },
    ]);
  });

  // ── 2. A shipped file changed on both sides is a conflict the person decides ──

  it('a shipped file edited locally and changed upstream: nothing is written until the person chooses', async () => {
    const s = await setup('conflict', (slug) => [
      skillMd(slug, 'v1'),
      ['references/guide.md', 'guide v1'],
      ['references/old.md', 'old v1'],
    ]);
    await put(s.dir, 'references/guide.md', 'my guide');
    await put(s.dir, 'references/old.md', 'my old');
    const before = await s.row();

    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/guide.md', 'guide v2']]);
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'SKILL.md', kind: 'changed' },
      { path: 'references/guide.md', kind: 'conflict', reason: 'both-changed' },
      { path: 'references/old.md', kind: 'conflict', reason: 'edited-locally-removed-upstream' },
    ]);
    expect(preview.filesState).toBe('conflict');

    // No choice: refused, nothing written.
    await expect(applySkillUpdate(s.opts)).rejects.toThrow(SkillInstallError);
    expect(await text(s.dir, 'references/guide.md')).toBe('my guide');
    expect(await text(s.dir, 'SKILL.md')).toContain('v1');
    expect((await s.row()).defaultContent).toBe(before.defaultContent);

    // A choice for a file that is not in conflict: refused, nothing written.
    await expect(
      applySkillUpdate({
        ...s.opts,
        conflictChoices: {
          'references/guide.md': 'keep-local',
          'references/old.md': 'keep-local',
          'SKILL.md': 'keep-local',
        },
      }),
    ).rejects.toThrow(/no longer in conflict/);
    expect(await text(s.dir, 'SKILL.md')).toContain('v1');

    // Keep mine for one, take the new version for the other.
    await applySkillUpdate({
      ...s.opts,
      conflictChoices: {
        'references/guide.md': 'keep-local',
        'references/old.md': 'take-upstream',
      },
    });
    expect(await text(s.dir, 'references/guide.md')).toBe('my guide');
    await expect(text(s.dir, 'references/old.md')).rejects.toThrow(/ENOENT/);
    expect(await text(s.dir, 'SKILL.md')).toContain('v2');

    // The kept edit is now a local change against the new baseline: no badge.
    const row = await s.row();
    const check = await checkSkillUpdate({
      db: s.db as never,
      skill: {
        id: row.id,
        slug: row.slug,
        source: row.source!,
        defaultContent: row.defaultContent,
        installedScripts: row.installedScripts,
        installedFiles: row.installedFiles,
      },
      skillStoreDir: store,
    });
    expect(check).toMatchObject({ kind: 'checked', filesState: 'local-only' });
    expect((await s.row()).updateAvailable).toBe(false);
  });

  it('"take the new version" on a conflict writes the new bytes', async () => {
    const s = await setup('conflict-take', (slug) => [
      skillMd(slug, 'v1'),
      ['assets/logo.bin', BINARY],
    ]);
    await put(s.dir, 'assets/logo.bin', 'mine');
    serve(s.slug, [skillMd(s.slug, 'v1'), ['assets/logo.bin', BINARY_V2]]);
    await applySkillUpdate({ ...s.opts, conflictChoices: { 'assets/logo.bin': 'take-upstream' } });
    expect(Buffer.compare(await bytes(s.dir, 'assets/logo.bin'), Buffer.from(BINARY_V2))).toBe(0);
  });

  // ── 3. A failure at any step leaves the old folder and the old row ──

  type Step = { name: string; arm: (store: string, slug: string) => void };
  const steps: Step[] = [
    {
      name: 'copying the live folder to the staging folder',
      arm: (st, slug) =>
        fsHooks.set('cp', (src) => (String(src) === join(st, slug) ? fsError('EIO') : null)),
    },
    {
      name: 'writing the second new file into the staging folder (half-way)',
      arm: () => {
        let n = 0;
        fsHooks.set('copyFile', (_src, dest) =>
          String(dest).includes('.staging-') && ++n === 2 ? fsError('ENOSPC') : null,
        );
      },
    },
    {
      name: 'moving the live folder aside',
      arm: (st, slug) =>
        fsHooks.set('rename', (from) =>
          String(from) === join(st, slug) ? fsError('EXDEV') : null,
        ),
    },
    {
      name: 'moving the staging folder in',
      arm: () =>
        fsHooks.set('rename', (from) =>
          String(from).includes('.staging-') ? fsError('EXDEV') : null,
        ),
    },
  ];

  for (const step of steps) {
    it(`a failure while ${step.name} leaves the old folder and the old row`, async () => {
      const s = await setup('fail', (slug) => [
        skillMd(slug, 'v1'),
        ['references/a.md', 'a v1'],
        ['references/b.md', 'b v1'],
      ]);
      await put(s.dir, 'workflows/mine.json', 'mine');
      const before = await s.row();

      serve(s.slug, [
        skillMd(s.slug, 'v2'),
        ['references/a.md', 'a v2'],
        ['references/b.md', 'b v2'],
      ]);
      step.arm(store, s.slug);
      await expect(applySkillUpdate(s.opts)).rejects.toThrow();
      fsHooks.clear();

      expect(await text(s.dir, 'SKILL.md')).toContain('v1');
      expect(await text(s.dir, 'references/a.md')).toBe('a v1');
      expect(await text(s.dir, 'references/b.md')).toBe('b v1');
      expect(await text(s.dir, 'workflows/mine.json')).toBe('mine');
      const after = await s.row();
      expect(after.defaultContent).toBe(before.defaultContent);
      expect(after.installedFiles).toEqual(before.installedFiles);
      expect(await readdir(store)).toEqual([s.slug]);

      // Nothing reads as a local edit: the next check still offers the update.
      const check = await checkSkillUpdate({
        db: s.db as never,
        skill: {
          id: after.id,
          slug: after.slug,
          source: after.source!,
          defaultContent: after.defaultContent,
          installedScripts: after.installedScripts,
          installedFiles: after.installedFiles,
        },
        skillStoreDir: store,
      });
      expect(check).toMatchObject({ kind: 'checked', filesState: 'update' });
      expect((await s.row()).updateAvailable).toBe(true);
    });
  }

  it('a copy that reports success but writes other bytes is caught before the switch', async () => {
    const s = await setup('short-copy', (slug) => [
      skillMd(slug, 'v1'),
      ['references/a.md', 'a v1'],
    ]);
    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/a.md', 'a v2']]);
    fsHooks.set('copyFile', (_src, dest) => {
      if (!String(dest).includes('.staging-')) return null;
      writeFileSync(String(dest), 'truncated');
      return 'done';
    });
    await expect(applySkillUpdate(s.opts)).rejects.toThrow(/did not come out as expected/);
    expect(await text(s.dir, 'references/a.md')).toBe('a v1');
    expect(await text(s.dir, 'SKILL.md')).toContain('v1');
    expect(await readdir(store)).toEqual([s.slug]);
  });

  it('a failure of the database commit after the switch puts the old folder back', async () => {
    const s = await setup('fail-db', (slug) => [skillMd(slug, 'v1'), ['references/a.md', 'a v1']]);
    await put(s.dir, 'workflows/mine.json', 'mine');
    const before = await s.row();
    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/a.md', 'a v2']]);

    // The transaction runs its body (rows + switch), then fails to commit.
    const realTx = s.db.transaction.bind(s.db);
    (s.db as unknown as { transaction: unknown }).transaction = (async (
      fn: (tx: unknown) => Promise<unknown>,
    ) =>
      realTx(async (tx) => {
        await fn(tx);
        throw new Error('simulated commit failure');
      })) as unknown;
    await expect(applySkillUpdate(s.opts)).rejects.toThrow(/simulated commit failure/);
    (s.db as unknown as { transaction: unknown }).transaction = realTx;

    expect(await text(s.dir, 'references/a.md')).toBe('a v1');
    expect(await text(s.dir, 'workflows/mine.json')).toBe('mine');
    expect((await s.row()).defaultContent).toBe(before.defaultContent);
    expect(await readdir(store)).toEqual([s.slug]);
  });

  it('a file written into the folder while the update is prepared is never lost: the apply refuses', async () => {
    const s = await setup('late-write', (slug) => [
      skillMd(slug, 'v1'),
      ['references/a.md', 'a v1'],
    ]);
    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/a.md', 'a v2']]);
    // An agent's skill_file_write lands after the staging copy, just before the switch.
    fsHooks.set('rename', (from) => {
      if (String(from) === join(store, s.slug)) {
        writeFileSync(join(store, s.slug, 'late.md'), 'written late');
        fsHooks.delete('rename');
      }
      return null;
    });
    await expect(applySkillUpdate(s.opts)).rejects.toThrow(
      /changed while the update was being prepared/,
    );
    expect(await text(s.dir, 'late.md')).toBe('written late');
    expect(await text(s.dir, 'references/a.md')).toBe('a v1');
    expect(await readdir(store)).toEqual([s.slug]);
  });

  it('a folder that is briefly in use (EBUSY) is replaced once it is free', async () => {
    const s = await setup('busy', (slug) => [skillMd(slug, 'v1'), ['references/a.md', 'a v1']]);
    serve(s.slug, [skillMd(s.slug, 'v2'), ['references/a.md', 'a v2']]);
    let n = 0;
    fsHooks.set('rename', (from) =>
      String(from) === join(store, s.slug) && ++n <= 2 ? fsError('EBUSY') : null,
    );
    await applySkillUpdate(s.opts);
    expect(await text(s.dir, 'references/a.md')).toBe('a v2');
  });

  // ── 4. A script new in the update is not authorized by the old grant ──

  it('a script added by the update revokes the authorization; a kept local script patch does not', async () => {
    const s = await setup('scripts', (slug) => [
      skillMd(slug, 'v1'),
      ['scripts/run.py', 'print(1)'],
    ]);
    const [assignment] = await s.db
      .insert(agentSkillAssignments)
      .values({
        entityId: s.seed.entityId,
        agentId: s.seed.agentId,
        skillId: (await s.row()).id,
        scriptsAuthorized: true,
      })
      .returning();
    const authorized = async () =>
      (
        await s.db
          .select()
          .from(agentSkillAssignments)
          .where(eq(agentSkillAssignments.id, assignment!.id))
      )[0]!.scriptsAuthorized;

    // Upstream changes only the text; the owner patched the script: kept, still authorized.
    await put(s.dir, 'scripts/run.py', 'print("patched")');
    serve(s.slug, [skillMd(s.slug, 'v2'), ['scripts/run.py', 'print(1)']]);
    const p1 = await previewSkillUpdate(s.opts);
    expect(p1.scriptsChanged).toBe(false);
    expect(p1.scriptsToAuthorize).toEqual([]);
    const r1 = await applySkillUpdate(s.opts);
    expect(r1.scriptsAuthorizationRevoked).toBe(0);
    expect(await text(s.dir, 'scripts/run.py')).toBe('print("patched")');
    expect(await authorized()).toBe(true);

    // Upstream adds a script: the review names it, the apply revokes.
    serve(s.slug, [
      skillMd(s.slug, 'v2'),
      ['scripts/run.py', 'print(1)'],
      ['scripts/new.py', 'print("new")'],
    ]);
    const p2 = await previewSkillUpdate(s.opts);
    expect(p2.scriptsChanged).toBe(true);
    expect(p2.scriptsToAuthorize).toEqual(['scripts/new.py']);
    const r2 = await applySkillUpdate(s.opts);
    expect(r2.scriptsAuthorizationRevoked).toBe(1);
    expect(await authorized()).toBe(false);
    expect(await text(s.dir, 'scripts/new.py')).toBe('print("new")');
  });

  // ── 5. Installed before the manifest existed: the first update keeps every file ──

  it('a skill installed before the manifest: its first update keeps every file that is there', async () => {
    const s = await setup('legacy', (slug) => [
      skillMd(slug, 'v1'),
      ['references/same.md', 'same'],
      ['references/edited.md', 'shipped'],
    ]);
    await s.db
      .update(agentSkills)
      .set({ installedFiles: null })
      .where(eq(agentSkills.slug, s.slug));
    await put(s.dir, 'references/edited.md', 'edited by the owner');
    await put(s.dir, 'notes/added.md', 'added by an agent');

    serve(s.slug, [
      skillMd(s.slug, 'v2'),
      ['references/same.md', 'same'],
      ['references/edited.md', 'shipped'],
      ['references/new.md', 'new upstream'],
    ]);
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'SKILL.md', kind: 'conflict', reason: 'unknown-origin' },
      { path: 'notes/added.md', kind: 'kept-local-addition' },
      { path: 'references/edited.md', kind: 'conflict', reason: 'unknown-origin' },
      { path: 'references/new.md', kind: 'added' },
    ]);
    await expect(applySkillUpdate(s.opts)).rejects.toThrow(SkillInstallError);

    await applySkillUpdate({
      ...s.opts,
      conflictChoices: { 'SKILL.md': 'keep-local', 'references/edited.md': 'keep-local' },
    });
    expect(await text(s.dir, 'SKILL.md')).toContain('v1');
    expect(await text(s.dir, 'references/edited.md')).toBe('edited by the owner');
    expect(await text(s.dir, 'references/same.md')).toBe('same');
    expect(await text(s.dir, 'notes/added.md')).toBe('added by an agent');
    expect(await text(s.dir, 'references/new.md')).toBe('new upstream');
    // From now on it has a manifest, and the three-way compare applies.
    expect((await s.row()).installedFiles?.map((e) => e.path)).toEqual([
      'SKILL.md',
      'references/edited.md',
      'references/new.md',
      'references/same.md',
    ]);
  });

  // ── 6. Generality: nested folders, binary files, names that differ by case ──

  it('nested folders and binary files: changed upstream are replaced, added locally are kept', async () => {
    const s = await setup('nested', (slug) => [
      skillMd(slug, 'v1'),
      ['a/b/c/deep.txt', 'deep v1'],
      ['a/b/model.bin', BINARY],
    ]);
    await put(s.dir, 'a/b/c/d/mine.bin', BINARY_V2);
    serve(s.slug, [
      skillMd(s.slug, 'v1'),
      ['a/b/c/deep.txt', 'deep v2'],
      ['a/b/model.bin', BINARY_V2],
    ]);
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'a/b/c/d/mine.bin', kind: 'kept-local-addition' },
      { path: 'a/b/c/deep.txt', kind: 'changed' },
      { path: 'a/b/model.bin', kind: 'changed' },
    ]);
    await applySkillUpdate(s.opts);
    expect(await text(s.dir, 'a/b/c/deep.txt')).toBe('deep v2');
    expect(Buffer.compare(await bytes(s.dir, 'a/b/model.bin'), Buffer.from(BINARY_V2))).toBe(0);
    expect(Buffer.compare(await bytes(s.dir, 'a/b/c/d/mine.bin'), Buffer.from(BINARY_V2))).toBe(0);
  });

  it('a local file whose name differs only by case from a new upstream file is never overwritten', async () => {
    const s = await setup('case', (slug) => [skillMd(slug, 'v1')]);
    await put(s.dir, 'notes.md', 'mine, lower case');
    serve(s.slug, [skillMd(s.slug, 'v1'), ['Notes.md', 'theirs, capitalised']]);
    const preview = await previewSkillUpdate(s.opts);

    if (await isCaseInsensitiveDir(store)) {
      // One file on this filesystem: both sides added it — a conflict.
      expect(preview.files).toEqual([
        { path: 'Notes.md', kind: 'conflict', reason: 'added-on-both-sides' },
      ]);
      await expect(applySkillUpdate(s.opts)).rejects.toThrow(SkillInstallError);
      expect(await text(s.dir, 'notes.md')).toBe('mine, lower case');
      await applySkillUpdate({ ...s.opts, conflictChoices: { 'Notes.md': 'keep-local' } });
      expect(await readdir(s.dir)).toContain('notes.md');
      expect(await text(s.dir, 'notes.md')).toBe('mine, lower case');
    } else {
      // Two files on this filesystem: each keeps its bytes.
      expect(preview.files).toEqual([
        { path: 'Notes.md', kind: 'added' },
        { path: 'notes.md', kind: 'kept-local-addition' },
      ]);
      await applySkillUpdate(s.opts);
      expect(await text(s.dir, 'notes.md')).toBe('mine, lower case');
      expect(await text(s.dir, 'Notes.md')).toBe('theirs, capitalised');
    }
  });

  it('the check raises the badge for a changed reference file, not only for SKILL.md and scripts', async () => {
    const s = await setup('ref-only', (slug) => [
      skillMd(slug, 'v1'),
      ['references/forms.md', 'v1'],
    ]);
    serve(s.slug, [skillMd(s.slug, 'v1'), ['references/forms.md', 'v2']]);
    const row = await s.row();
    const check = await checkSkillUpdate({
      db: s.db as never,
      skill: {
        id: row.id,
        slug: row.slug,
        source: row.source!,
        defaultContent: row.defaultContent,
        installedScripts: row.installedScripts,
        installedFiles: row.installedFiles,
      },
      skillStoreDir: store,
    });
    expect(check).toMatchObject({ kind: 'checked', contentChanged: false, filesState: 'update' });
    expect((await s.row()).updateAvailable).toBe(true);
  });

  it('"keep my version" re-baselines every file and touches none', async () => {
    const s = await setup('ack', (slug) => [skillMd(slug, 'v1'), ['references/g.md', 'g v1']]);
    await put(s.dir, 'references/g.md', 'mine');
    await put(s.dir, 'extra.md', 'extra');
    serve(s.slug, [skillMd(s.slug, 'v1'), ['references/g.md', 'g v2']]);
    await acknowledgeSkillUpdate({ db: s.db as never, slug: s.slug, entityId: s.seed.entityId });
    expect(await text(s.dir, 'references/g.md')).toBe('mine');
    expect(await text(s.dir, 'extra.md')).toBe('extra');
    const preview = await previewSkillUpdate(s.opts);
    expect(preview.files).toEqual([
      { path: 'extra.md', kind: 'kept-local-addition' },
      { path: 'references/g.md', kind: 'kept-local-change' },
    ]);
    expect(preview.filesState).toBe('local-only');
  });

  // ── Install: every refusal happens before the store is touched ──

  it('an install refused for its size leaves no folder in the store', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = freshSlug('too-big');
    serve(slug, [skillMd(slug, 'x'.repeat(600 * 1024))]);
    await expect(
      installCommunitySkill({
        db: db as never,
        source: `https://clawhub.ai/pub/${slug}`,
        skillStoreDir: store,
        entityId: seed.entityId,
      }),
    ).rejects.toThrow(/too large/);
    expect(await readdir(store)).toEqual([]);
  });

  it('an install over a folder that belongs to no installed skill refuses and keeps that folder', async () => {
    const { db } = await spinUpTestDb();
    const seed = await seedMinimal(db);
    const slug = freshSlug('orphan');
    await put(join(store, slug), 'left.md', 'left behind');
    serve(slug, [skillMd(slug, 'v1')]);
    await expect(
      installCommunitySkill({
        db: db as never,
        source: `https://clawhub.ai/pub/${slug}`,
        skillStoreDir: store,
        entityId: seed.entityId,
      }),
    ).rejects.toThrow(/belongs to no installed skill/);
    expect(await text(join(store, slug), 'left.md')).toBe('left behind');
    const rows = await db
      .select()
      .from(agentSkills)
      .where(and(eq(agentSkills.slug, slug), eq(agentSkills.entityId, seed.entityId)));
    expect(rows).toEqual([]);
    expect(await readdir(store)).toEqual([slug]);
  });

  it('a fresh install records the manifest of every shipped file, nested skills excluded', async () => {
    const s = await setup('fresh', (slug) => [
      skillMd(slug, 'v1'),
      ['scripts/run.py', 'print(1)'],
      ['assets/logo.bin', BINARY],
      ['plugins/other/SKILL.md', '---\nname: other\ndescription: d\n---\nother'],
    ]);
    expect(s.result.status).toBe('installed');
    const row = await s.row();
    expect(row.installedFiles?.map((e) => e.path)).toEqual([
      'SKILL.md',
      'assets/logo.bin',
      'scripts/run.py',
    ]);
    await expect(text(s.dir, 'plugins/other/SKILL.md')).rejects.toThrow(/ENOENT/);
    expect(await readdir(store)).toEqual([s.slug]);
  });
});
