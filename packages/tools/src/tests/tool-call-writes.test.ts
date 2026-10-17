// tool-call-writes.test.ts — CE QU'UN APPEL A FAIT À CHAQUE FICHIER QU'IL VISAIT (#779).
//
// Le seam d'exécution prend l'empreinte de chaque cible FICHIER avant l'outil
// et la reprend après. Ce fichier prouve, sur le VRAI `executeTool` et les
// VRAIS outils du registre, qu'il la RANGE dans `tool_call_writes` : le chemin
// réel, l'état et l'empreinte avant, l'état et l'empreinte après, et le lien à
// la ligne `tool_calls` de l'appel, donc à son `seq`. Les assertions portent
// sur les lignes relues en base, jamais sur un compte d'appels.
//
// La règle est la même pour tout outil à cible fichier (règle #11) : elle est
// éprouvée ici sur file_write, file_edit, xlsx_create, docx_create et
// pptx_create, sur un appel raté, sur un appel qui laisse le fichier intact, et
// sur une commande (cible dossier : aucune ligne par fichier). Une insertion
// qui échoue ne bloque pas l'outil, et se journalise (invariant #4).

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { agentJobs, asc, eq, toolCallWrites, toolCalls } from '@nodal-agents/db';
import { normalizePath } from '@nodal-agents/shared';
import { createToolRegistry } from '../registry';
import { registerBuiltins } from '../builtin';
import { executeTool } from '../execute';
import { cheminConstate } from '../verification/record-constat';
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

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

beforeEach(async () => {
  ws = await mkdtemp(join(tmpdir(), 'nodal-tool-call-writes-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  try {
    await rm(ws, { recursive: true, force: true });
  } catch {
    /* jetable */
  }
});

async function jobNeuf(): Promise<string> {
  const [job] = await db
    .insert(agentJobs)
    .values({ entityId: seed.entityId, agentId: seed.agentId, channel: 'api', task: '#779' })
    .returning();
  if (!job) throw new Error('job insert failed');
  return job.id;
}

function ctx(jobId: string): ToolContext {
  return {
    db,
    entityId: seed.entityId,
    agentId: seed.agentId,
    jobId,
    jobChatId: null,
    workspaces: [{ label: 'shared', path: ws }],
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

const sha = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
const shaOnDisk = async (p: string): Promise<string> => sha(await readFile(p));

/** Les lignes rangées pour ce job, avec l'outil et le `seq` de leur appel, dans l'ordre `seq`. */
async function lignes(jobId: string) {
  return db
    .select({
      tool: toolCalls.toolName,
      seq: toolCalls.seq,
      path: toolCallWrites.path,
      beforeKind: toolCallWrites.beforeKind,
      beforeSha256: toolCallWrites.beforeSha256,
      afterKind: toolCallWrites.afterKind,
      afterSha256: toolCallWrites.afterSha256,
    })
    .from(toolCallWrites)
    .innerJoin(toolCalls, eq(toolCalls.id, toolCallWrites.toolCallId))
    .where(eq(toolCallWrites.jobId, jobId))
    .orderBy(asc(toolCalls.seq));
}

async function appel(jobId: string, nom: string, input: Record<string, unknown>) {
  return executeTool(outil(nom), input, ctx(jobId), autoApprove());
}

describe('tool_call_writes: what each call did to each file it targeted @cap:travailler-sur-des-fichiers/moteur', () => {
  it('file_write then file_edit on one file: two rows linked to their calls, the chain readable in seq order', async () => {
    const jobId = await jobNeuf();
    expect((await appel(jobId, 'file_write', { path: 'notes.txt', content: 'un' })).outcome).toBe(
      'success',
    );
    expect(
      (await appel(jobId, 'file_edit', { path: 'notes.txt', old_string: 'un', new_string: 'deux' }))
        .outcome,
    ).toBe('success');
    const path = await cheminConstate(join(ws, 'notes.txt'));
    const rows = await lignes(jobId);
    expect(rows.map(({ seq: _s, ...r }) => r)).toEqual([
      {
        tool: 'file_write',
        path,
        beforeKind: 'absent',
        beforeSha256: null,
        afterKind: 'file',
        afterSha256: sha('un'),
      },
      {
        tool: 'file_edit',
        path,
        beforeKind: 'file',
        beforeSha256: sha('un'),
        afterKind: 'file',
        afterSha256: sha('deux'),
      },
    ]);
    // La chaîne de garde : l'avant du second appel est l'après du premier, et `seq` les ordonne.
    expect(Number(rows[1]!.seq)).toBeGreaterThan(Number(rows[0]!.seq));
    expect(rows[1]!.beforeSha256).toBe(rows[0]!.afterSha256);
    expect(path).toBe(normalizePath(path));
  });

  it.each([
    ['xlsx_create', 'ventes.xlsx', { sheet: 'Ventes' }],
    [
      'docx_create',
      'note.docx',
      { paragraphs: [{ text: 'Convocation', heading: 1 }, { text: 'Le 12 novembre.' }] },
    ],
    ['pptx_create', 'deck.pptx', { slides: [{ title: 'Intro', bullets: ['A', 'B'] }] }],
  ])('%s: one row, absent before, the bytes it left on disk after', async (nom, fichier, extra) => {
    const jobId = await jobNeuf();
    const res = await appel(jobId, nom, { path: fichier, ...extra });
    expect(res.outcome).toBe('success');
    expect(await lignes(jobId)).toEqual([
      {
        tool: nom,
        seq: expect.anything() as unknown as number,
        path: await cheminConstate(join(ws, fichier)),
        beforeKind: 'absent',
        beforeSha256: null,
        afterKind: 'file',
        afterSha256: await shaOnDisk(join(ws, fichier)),
      },
    ]);
  });

  it('a call that fails still says what it did: the file it targeted, intact, before and after', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'garde.txt'), 'contenu');
    const res = await appel(jobId, 'file_edit', {
      path: 'garde.txt',
      old_string: 'absent de ce fichier',
      new_string: 'x',
    });
    // Le refus est l'issue de l'outil, sous quelque forme qu'il la rende.
    expect(JSON.stringify(res)).toMatch(/not found|introuvable|does not|no match|0 occurrence/i);
    expect((await lignes(jobId)).map((r) => [r.tool, r.beforeSha256, r.afterSha256])).toEqual([
      ['file_edit', sha('contenu'), sha('contenu')],
    ]);
  });

  it('a call that rewrites the same bytes: before equals after, said, not hidden', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'pareil.txt'), 'meme');
    expect(
      (await appel(jobId, 'file_write', { path: 'pareil.txt', content: 'meme' })).outcome,
    ).toBe('success');
    expect(
      (await lignes(jobId)).map((r) => [r.beforeKind, r.beforeSha256, r.afterKind, r.afterSha256]),
    ).toEqual([['file', sha('meme'), 'file', sha('meme')]]);
  });

  it('a command targets a FOLDER: it writes a file, and no per-file row exists for it', async () => {
    const jobId = await jobNeuf();
    const cible = normalizePath(join(ws, 'par-la-commande.txt'));
    const res = await appel(jobId, 'run_command', {
      purpose: 'ecrire',
      command: `node -e "require('fs').writeFileSync('${cible}', 'x')"`,
    });
    expect(res.outcome).toBe('success');
    expect(await readFile(cible, 'utf8')).toBe('x');
    expect(await lignes(jobId)).toEqual([]);
  });

  it('a read-only tool declares no target and leaves no row', async () => {
    const jobId = await jobNeuf();
    await writeFile(join(ws, 'lu.txt'), 'lu');
    expect((await appel(jobId, 'file_read', { path: 'lu.txt' })).outcome).toBe('success');
    expect(await lignes(jobId)).toEqual([]);
  });

  it('an insert that fails never blocks the tool: it is logged by its code, and no row means "not recorded"', async () => {
    const jobId = await jobNeuf();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await db.execute(
      // La table renommée le temps d'un appel : l'insertion échoue pour de vrai.
      (await import('@nodal-agents/db'))
        .sql`ALTER TABLE tool_call_writes RENAME TO tool_call_writes_away`,
    );
    try {
      const res = await appel(jobId, 'file_write', { path: 'quand-meme.txt', content: 'ecrit' });
      expect(res.outcome).toBe('success');
      expect(await readFile(join(ws, 'quand-meme.txt'), 'utf8')).toBe('ecrit');
    } finally {
      await db.execute(
        (await import('@nodal-agents/db'))
          .sql`ALTER TABLE tool_call_writes_away RENAME TO tool_call_writes`,
      );
    }
    expect(
      warn.mock.calls.some((c) =>
        String(c[0]).startsWith('[verification] TOOL_CALL_WRITES_UNRECORDED tool=file_write'),
      ),
    ).toBe(true);
    expect(await lignes(jobId)).toEqual([]);
  });
});
