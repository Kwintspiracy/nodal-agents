// tool-call-reads.test.ts — CE QU'UN APPEL A LU (le pendant de tool-call-writes.test.ts).
//
// Tout outil du produit qui lit le contenu d'un fichier rapporte le chemin
// résolu qu'il a ouvert et l'empreinte des octets lus. Ce fichier prouve, sur
// le VRAI `executeTool` et les VRAIS outils du registre, que le seam le RANGE
// dans `tool_call_reads` : le chemin réel, l'empreinte, et le lien à la ligne
// `tool_calls` de l'appel (son outil, son `seq`). Les assertions portent sur
// les lignes relues en base, jamais sur un compte d'appels.
//
// Éprouvé sur file_read (lecture entière et par fenêtre d'un gros fichier),
// file_edit, file_search, skill_file_read (entière et par fenêtre), xlsx_read,
// docx_read, pptx_read, un outil Office qui lit avant d'écrire, un outil qui a
// lu puis refusé ou levé, un chemin passé par une jonction, une lecture ratée,
// un outil qui ne lit rien, et une insertion qui échoue (invariant #4 : l'outil
// n'est jamais bloqué, l'absence se journalise). Les envois (send_file,
// send_image, send_video) sont dans tool-call-reads-send.test.ts.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, asc, eq, sql, toolCallReads, toolCalls } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import { MAX_READ_BYTES } from '../builtin/file-ops/workspace';
import type { ApprovalRule, ExecuteOptions, ToolContext } from '../types';

const registry = createToolRegistry();
registerBuiltins(registry);

function outil(nom: string) {
  const t = registry.get(nom);
  if (!t) throw new Error(`outil absent du registre : ${nom}`);
  return t;
}

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let ws = '';
const extra: string[] = [];

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'nodal-tool-call-reads-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const p of [ws, ...extra.splice(0)]) {
    try {
      await rm(p, { recursive: true, force: true });
    } catch {
      /* jetable */
    }
  }
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: 'reads' })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string, root = ws, more: Record<string, unknown> = {}): ToolContext {
  return {
    ...more,
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: root }],
    turn: 1,
  } as unknown as ToolContext;
}

function autoApprove(): ExecuteOptions {
  const rules = registry
    .list()
    .filter((t) => t.mutatesWorkspace === true)
    .map((t) => ({
      id: `rule-${t.name}`,
      toolName: t.name,
      action: 'auto_approve',
      agentId: seed.agentId,
      entityId: seed.entityId,
    })) as ApprovalRule[];
  return { approvalRules: rules, onApprovalRequired: async () => {} };
}

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const shaOnDisk = async (p: string): Promise<string> => sha(await readFile(p));
/** Le chemin réel, sous la forme que la plateforme range (lien résolu, barres obliques). */
const reel = async (p: string): Promise<string> => normalizePath(await realpath(p));

async function appel(
  jobId: string,
  nom: string,
  input: Record<string, unknown>,
  root = ws,
  more: Record<string, unknown> = {},
) {
  return executeTool(outil(nom), input, ctx(jobId, root, more), autoApprove());
}

/** Les lectures rangées pour ce job, avec l'outil et le `seq` de leur appel, dans l'ordre `seq`. */
async function lectures(jobId: string) {
  return db
    .select({
      tool: toolCalls.toolName,
      seq: toolCalls.seq,
      path: toolCallReads.path,
      sha256: toolCallReads.sha256,
    })
    .from(toolCallReads)
    .innerJoin(toolCalls, eq(toolCalls.id, toolCallReads.toolCallId))
    .where(eq(toolCallReads.jobId, jobId))
    .orderBy(asc(toolCalls.seq));
}

describe('tool_call_reads: what each call read @cap:travailler-sur-des-fichiers/moteur', () => {
  it('file_read: one row on the call, the real path and the hash of the bytes read', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'notes.txt'), 'ligne un\nligne deux\n');
    expect((await appel(jobId, 'file_read', { path: 'notes.txt' })).outcome).toBe('success');
    expect(await lectures(jobId)).toEqual([
      {
        tool: 'file_read',
        seq: expect.anything() as unknown as number,
        path: await reel(join(ws, 'notes.txt')),
        sha256: sha('ligne un\nligne deux\n'),
      },
    ]);
  });

  it('file_read of a big file through a window: the hash covers the WHOLE file, which the window reads to its end', async () => {
    const jobId = await jobNeuf();
    const big = `${'x'.repeat(99)}\n`.repeat(Math.ceil((MAX_READ_BYTES + 4096) / 100));
    await writeFile(join(ws, 'gros.txt'), big);
    const res = await appel(jobId, 'file_read', { path: 'gros.txt', offset: 1, limit: 3 });
    expect(res.outcome).toBe('success');
    expect((await lectures(jobId)).map((r) => [r.tool, r.sha256])).toEqual([
      ['file_read', sha(big)],
    ]);
  });

  it('file_edit reads the file it edits: the row holds the bytes BEFORE its own write', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'a-editer.txt'), 'avant\n');
    const res = await appel(jobId, 'file_edit', {
      path: 'a-editer.txt',
      old_string: 'avant',
      new_string: 'apres',
    });
    expect(res.outcome).toBe('success');
    expect(await lectures(jobId)).toEqual([
      {
        tool: 'file_edit',
        seq: expect.anything() as unknown as number,
        path: await reel(join(ws, 'a-editer.txt')),
        sha256: sha('avant\n'),
      },
    ]);
    expect(await readFile(join(ws, 'a-editer.txt'), 'utf8')).toBe('apres\n');
  });

  it('file_search through contents: one row per file whose contents it read, none for a name-only search', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'un.txt'), 'aiguille\n');
    await writeFile(join(ws, 'deux.txt'), 'foin\n');
    expect(
      (await appel(jobId, 'file_search', { pattern: 'aiguille', target: 'content' })).outcome,
    ).toBe('success');
    const rows = await lectures(jobId);
    expect(rows.map((r) => [r.tool, r.path, r.sha256]).sort()).toEqual(
      [
        ['file_search', await reel(join(ws, 'deux.txt')), sha('foin\n')],
        ['file_search', await reel(join(ws, 'un.txt')), sha('aiguille\n')],
      ].sort(),
    );

    const jobNoms = await jobNeuf();
    expect((await appel(jobNoms, 'file_search', { pattern: 'un', target: 'files' })).outcome).toBe(
      'success',
    );
    expect(await lectures(jobNoms)).toEqual([]);
  });

  it('skill_file_read: the row names the real file in the skill store and its bytes', async () => {
    const jobId = await jobNeuf();
    const store = await mkdtemp(join(tmpdir(), 'nodal-reads-skills-'));
    extra.push(store);
    await mkdir(join(store, 'mon-skill', 'references'), { recursive: true });
    await writeFile(join(store, 'mon-skill', 'references', 'guide.md'), '# Guide\n');
    const res = await appel(
      jobId,
      'skill_file_read',
      { skill: 'mon-skill', path: 'references/guide.md' },
      ws,
      {
        skillStoreDir: store,
        assignedSkillSlugs: ['mon-skill'],
      },
    );
    expect(res.outcome).toBe('success');
    expect(await lectures(jobId)).toEqual([
      {
        tool: 'skill_file_read',
        seq: expect.anything() as unknown as number,
        path: await reel(join(store, 'mon-skill', 'references', 'guide.md')),
        sha256: sha('# Guide\n'),
      },
    ]);
  });

  it('skill_file_read of a big file through a window: the hash covers the whole file', async () => {
    const jobId = await jobNeuf();
    const store = await mkdtemp(join(tmpdir(), 'nodal-reads-skills-'));
    extra.push(store);
    await mkdir(join(store, 'gros-skill'), { recursive: true });
    const big = `${'y'.repeat(99)}\n`.repeat(Math.ceil((MAX_READ_BYTES + 4096) / 100));
    await writeFile(join(store, 'gros-skill', 'gros.md'), big);
    const res = await appel(
      jobId,
      'skill_file_read',
      { skill: 'gros-skill', path: 'gros.md', offset: 1, limit: 2 },
      ws,
      { skillStoreDir: store, assignedSkillSlugs: ['gros-skill'] },
    );
    expect(res.outcome).toBe('success');
    expect((await lectures(jobId)).map((r) => [r.tool, r.sha256])).toEqual([
      ['skill_file_read', sha(big)],
    ]);
  });

  it.each([
    ['xlsx_create', 'xlsx_read', 'v.xlsx', { sheet: 'Ventes' }],
    ['docx_create', 'docx_read', 'n.docx', { paragraphs: [{ text: 'Titre', heading: 1 }] }],
    ['pptx_create', 'pptx_read', 'd.pptx', { slides: [{ title: 'Intro', bullets: ['A'] }] }],
  ])(
    '%s then %s: the read row names the real file and the bytes on disk, and the create read nothing',
    async (create, read, fichier, extraInput) => {
      const jobId = await jobNeuf();
      expect((await appel(jobId, create, { path: fichier, ...extraInput })).outcome).toBe(
        'success',
      );
      expect((await appel(jobId, read, { path: fichier })).outcome).toBe('success');
      expect(await lectures(jobId)).toEqual([
        {
          tool: read,
          seq: expect.anything() as unknown as number,
          path: await reel(join(ws, fichier)),
          sha256: await shaOnDisk(join(ws, fichier)),
        },
      ]);
    },
  );

  it('an Office tool that reads before it writes records what it READ: the bytes before its own write', async () => {
    const jobId = await jobNeuf();
    expect((await appel(jobId, 'xlsx_create', { path: 's.xlsx', sheet: 'S' })).outcome).toBe(
      'success',
    );
    const before = await shaOnDisk(join(ws, 's.xlsx'));
    const res = await appel(jobId, 'xlsx_set_cell', {
      path: 's.xlsx',
      sheet: 'S',
      cell: 'A1',
      value: 'x',
    });
    expect(res.outcome).toBe('success');
    const rows = await lectures(jobId);
    expect(rows.map((r) => [r.tool, r.sha256])).toEqual([['xlsx_set_cell', before]]);
    expect(await shaOnDisk(join(ws, 's.xlsx'))).not.toBe(before);
  });

  it('a tool that read and then refused (its own ok:false) DID read: the row is on that call', async () => {
    const jobId = await jobNeuf();
    expect((await appel(jobId, 'xlsx_create', { path: 'e.xlsx', sheet: 'S' })).outcome).toBe(
      'success',
    );
    const before = await shaOnDisk(join(ws, 'e.xlsx'));
    const res = await appel(jobId, 'xlsx_set_cell', {
      path: 'e.xlsx',
      sheet: 'Absente',
      cell: 'A1',
      value: 'x',
    });
    expect(JSON.stringify(res)).toContain('not found in workbook');
    expect(await lectures(jobId)).toEqual([
      {
        tool: 'xlsx_set_cell',
        seq: expect.anything() as unknown as number,
        path: await reel(join(ws, 'e.xlsx')),
        sha256: before,
      },
    ]);
  });

  it('a tool that read and then THREW did read: the row is recorded on its failed call', async () => {
    const jobId = await jobNeuf();
    // Une archive zip saine, sans partie Word : le lecteur la lit, mammoth lève.
    const zip = new JSZip();
    zip.file('autre.txt', 'pas un document');
    const bytes = await zip.generateAsync({ type: 'nodebuffer' });
    await writeFile(join(ws, 'faux.docx'), bytes);
    const res = await appel(jobId, 'docx_read', { path: 'faux.docx' });
    expect(res.outcome).toBe('error');
    expect(await lectures(jobId)).toEqual([
      {
        tool: 'docx_read',
        seq: expect.anything() as unknown as number,
        path: await reel(join(ws, 'faux.docx')),
        sha256: sha(bytes),
      },
    ]);
  });

  it('a workspace folder reached through a junction: the row carries the REAL path, never the one the agent went through', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'par-lien.txt'), 'contenu');
    const link = join(tmpdir(), `nodal-reads-link-${Date.now()}`);
    await symlink(ws, link, 'junction');
    extra.push(link);
    expect((await appel(jobId, 'file_read', { path: 'par-lien.txt' }, link)).outcome).toBe(
      'success',
    );
    const rows = await lectures(jobId);
    expect(rows.map((r) => r.path)).toEqual([await reel(join(ws, 'par-lien.txt'))]);
    expect(rows[0]!.path).not.toBe(normalizePath(join(link, 'par-lien.txt')));
  });

  it('a read that fails (no such file) leaves no row: nothing was read', async () => {
    const jobId = await jobNeuf();
    const res = await appel(jobId, 'file_read', { path: 'absent.txt' });
    expect(JSON.stringify(res)).toMatch(/not found/i);
    expect(await lectures(jobId)).toEqual([]);
  });

  it('a tool that reads no file (file_list) leaves no row', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'a.txt'), 'a');
    expect((await appel(jobId, 'file_list', { path: '.' })).outcome).toBe('success');
    expect(await lectures(jobId)).toEqual([]);
  });

  it('an insert that fails never blocks the tool: it is logged by its code, and no row means "not recorded"', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'quand-meme.txt'), 'lu');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db.execute(sql`ALTER TABLE tool_call_reads RENAME TO tool_call_reads_away`);
    try {
      const res = await appel(jobId, 'file_read', { path: 'quand-meme.txt' });
      expect(res.outcome).toBe('success');
    } finally {
      await db.execute(sql`ALTER TABLE tool_call_reads_away RENAME TO tool_call_reads`);
    }
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).startsWith('[verification] TOOL_CALL_READS_UNRECORDED tool=file_read'),
      ),
    ).toBe(true);
    expect(await lectures(jobId)).toEqual([]);
  });
});
