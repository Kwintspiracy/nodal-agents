// path-rules.test.ts — les règles de CHEMIN du catalogue du 17/10, sur tous les scénarios.
//
// Décision 1 : un outil du produit disponible doit servir. Un livrable suit une
// CHAÎNE D'EMPREINTES (`tool_call_writes`, dans l'ordre `seq`) : de l'état que
// le banc a préparé à l'état final du disque, chaque écriture partant de
// l'état laissé par la précédente, et chaque écriture qui le change étant
// celle d'un outil attendu, prouvée par les octets qu'il a écrits. Un fichier
// à lire est désigné par le champ chemin d'un appel d'un outil attendu. Sinon
// l'essai est rouge, « product tool available, not used ». La règle est écrite
// une fois (judge-kit `productToolReasons`) et appliquée par runTrial à tout
// scénario qui déclare `productTools` : ces tests la jouent sur CHACUN d'eux.
//
// Chaque P2 des passes 1 et 2 de la revue de #777 a ici son test, nommé par
// lui : l'alibi, l'écrivain hors liste, la lecture seule, la sous-chaîne, la
// fenêtre d'une seconde, l'ordre parallèle.

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog';
import { TreeFactsSchema } from '../facts';
import { fileHash, fixturePath } from '../fixtures';
import { PRODUCT_TOOL_NOT_USED, productToolGate, toolPath } from '../judge-kit';
import { SCENARIOS, scenarioById } from '../scenarios';
import { ROOT_ID, facts, play } from './harness';

const WITH_TOOLS = SCENARIOS.filter((s) => s.productTools);
const WRITES = WITH_TOOLS.filter((s) => s.productTools!.writes.length > 0);
const READS = WITH_TOOLS.filter((s) => s.productTools!.reads.length > 0);
const NO_FILE = WITH_TOOLS.filter(
  (s) => s.productTools!.writes.length === 0 && s.productTools!.reads.length === 0,
);
const pathRule = (reasons: string[]): string[] =>
  reasons.filter((x) => x.startsWith(PRODUCT_TOOL_NOT_USED));
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
/** Les outils d'un scénario qui écrivent : tous sauf ses lecteurs (`*_read`). */
const writersOf = (tools: readonly string[]): string[] => tools.filter((t) => !t.endsWith('_read'));
/** L'état où le banc prépare un livrable : l'empreinte de sa fixture, sinon absent. */
function initialOf(id: string, rel: string): string {
  const f = (scenarioById(id)!.fixtures ?? []).find((x) => x.to === rel);
  return f ? fileHash(fixturePath(f.from)) : 'absent';
}
/** Ce que le travail d'un agent laisse : `content` au chemin du livrable. */
const leave =
  (rel: string, content: string) =>
  (root: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };

describe('decision 1: a product tool available must be used', () => {
  it('the scenarios that declare product tools are the Excel, Word, PowerPoint, web page and print ones; PDF and code declare none', () => {
    const by = (a: string) => SCENARIOS.filter((s) => s.activity === a);
    for (const a of ['excel', 'word', 'powerpoint', 'html-page', 'print'])
      expect(by(a).map((s) => [s.id, Boolean(s.productTools)])).toEqual(
        by(a).map((s) => [s.id, true]),
      );
    for (const a of ['pdf', 'code'])
      expect(
        by(a)
          .filter((s) => s.productTools)
          .map((s) => s.id),
      ).toEqual([]);
    expect([WITH_TOOLS.length, WRITES.length, READS.length, NO_FILE.length]).toEqual([
      18, 12, 4, 2,
    ]);
  });

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    '%s: its tool wrote the deliverable, recorded with its bytes, from the prepared state to the disk: the path rule holds',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        {
          writes: [
            { tool: `office__${tool}`, rel, before: initialOf(id, rel), after: sha('livre') },
          ],
        },
        leave(rel, 'livre'),
        { teamTools: [`office__${tool}`] },
      );
      expect(pathRule(r.reasons)).toEqual([]);
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    'P2 alibi (pass 1) — %s: a read by the product tool, the deliverable written by a script: no recorded write, red',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const reader = pt.tools.find((t) => t.endsWith('_read'));
      const r = await play(
        id,
        {
          tools: [
            ...(reader ? [{ name: reader, input: { path: rel } }] : []),
            { name: 'notebook__python_repl', input: { code: 'wb.save(p)' } },
          ],
        },
        leave(rel, 'ecrit par un script'),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)[0]).toBe(
        `${PRODUCT_TOOL_NOT_USED}: no write of ${rel} by ${pt.tools.join(', ')} is recorded with the bytes it wrote`,
      );
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    'P2 writer on no list (pass 1) and the one-second window (pass 2) — %s: the deliverable changed after its tool wrote it, whatever wrote it and however soon: red',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        {
          tools: [{ name: 'fs__copy_file', input: { from: 'tmp/x', to: rel } }],
          writes: [{ tool, rel, before: initialOf(id, rel), after: sha('par l outil'), seq: 7 }],
        },
        leave(rel, 'remplace aussitot'),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: ${rel} was changed after ${tool} (seq 7) by something that left no record (expected sha-256 ${sha('par l outil').slice(0, 12)}, on disk sha-256 ${sha('remplace aussitot').slice(0, 12)})`,
      ]);
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    'P2 read only (pass 1) — %s: a command that only READS the deliverable after its tool wrote it is never red for it',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        {
          tools: [
            {
              name: 'run_command',
              input: { command: `ls -l ${rel} && python -c "open('${rel}','rb')"` },
            },
          ],
          writes: [{ tool, rel, before: initialOf(id, rel), after: sha('livre') }],
        },
        leave(rel, 'livre'),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([]);
    },
  );

  it('P2 substring (pass 2): a write of ANOTHER file whose content cites the deliverable is no write of it', async () => {
    const rel = 'nodal-bench/boulangerie-bench.html';
    const r = await play(
      'html-landing',
      {
        tools: [
          {
            name: 'file_write',
            input: { path: 'nodal-bench/autre.html', content: `<a href="${rel}">voir</a>` },
          },
        ],
        writes: [
          { tool: 'file_write', rel: 'nodal-bench/autre.html', before: 'absent', after: sha('x') },
        ],
      },
      leave(rel, 'ecrit par un script'),
      { teamTools: ['file_write'] },
    );
    expect(pathRule(r.reasons)[0]).toBe(
      `${PRODUCT_TOOL_NOT_USED}: no write of ${rel} by file_write is recorded with the bytes it wrote`,
    );
  });

  it('P2 substring (pass 2): a read tool whose OTHER field cites the file does not read it; only its path field counts', async () => {
    const rel = 'nodal-bench/ventes-trimestre.xlsx';
    const cited = await play(
      'excel-read-answer',
      { tools: [{ name: 'xlsx_read', input: { path: 'tmp/autre.xlsx', note: rel } }] },
      undefined,
      { teamTools: ['xlsx_read'] },
    );
    expect(pathRule(cited.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: no call of xlsx_read reads ${rel}`,
    ]);
  });

  // Revue de #777, passe 3 (P2) : un champ chemin qui finit par le bon chemin
  // relatif peut désigner une COPIE du fichier posé (backup/nodal-bench/…). Le
  // chemin de l'appel se résout comme le produit le résout, contre les
  // dossiers de travail de l'agent qui a fait l'appel, puis se compare au
  // chemin réel du fichier posé.
  it.each(READS.map((s) => [s.id, s.productTools!] as const))(
    'P2 copy (pass 3) — %s: its tool reads a COPY under a folder whose path ends the right way: red',
    async (id, pt) => {
      const rel = pt.reads[0]!;
      const field = pt.tools[0] === 'request_print' ? 'filePath' : 'path';
      const r = await play(
        id,
        { tools: [{ name: pt.tools[0]!, input: { [field]: `backup/${rel}` } }] },
        (root) => leave(`backup/${rel}`, 'la copie')(root),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: no call of ${pt.tools.join(', ')} reads ${rel}`,
      ]);
    },
  );

  it('the file posed, designated three right ways: relative, prefixed by its workspace label, absolute', async () => {
    const rel = 'nodal-bench/ventes-trimestre.xlsx';
    for (const path of [rel, `shared/${rel}`, (root: string) => join(root, rel)]) {
      const r = await play(
        'excel-read-answer',
        (root) => ({
          tools: [
            { name: 'xlsx_read', input: { path: typeof path === 'string' ? path : path(root) } },
          ],
        }),
        undefined,
        { teamTools: ['xlsx_read'] },
      );
      expect(pathRule(r.reasons)).toEqual([]);
    }
  });

  it('the file posed, read through a workspace folder reached by a junction: still designated', async () => {
    const rel = 'nodal-bench/ventes-trimestre.xlsx';
    const r = await play(
      'excel-read-answer',
      { tools: [{ name: 'xlsx_read', input: { path: `shared/${rel}` } }] },
      undefined,
      { teamTools: ['xlsx_read'], linkedRoot: true },
    );
    expect(pathRule(r.reasons)).toEqual([]);
  });

  it('a workspace folder reached through a link: the rows carry the real path, and the chain still finds them', async () => {
    const rel = 'nodal-bench/ventes-bench.xlsx';
    const r = await play(
      'file',
      { writes: [{ tool: 'xlsx_create', rel, before: 'absent', after: sha('final') }] },
      leave(rel, 'final'),
      { teamTools: ['xlsx_create', 'xlsx_set_range'], linkedRoot: true },
    );
    expect(pathRule(r.reasons)).toEqual([]);
  });

  it('P2 parallel order (pass 2): the chain follows seq, whatever order the rows come in', async () => {
    const rel = 'nodal-bench/stock.xlsx';
    const initial = initialOf('excel-edit-column', rel);
    const r = await play(
      'excel-edit-column',
      {
        writes: [
          { tool: 'xlsx_set_cell', rel, before: sha('A'), after: sha('B'), seq: 12 },
          { tool: 'xlsx_set_range', rel, before: initial, after: sha('A'), seq: 11 },
        ],
      },
      leave(rel, 'B'),
      { teamTools: ['xlsx_read', 'xlsx_set_range', 'xlsx_set_cell'] },
    );
    expect(pathRule(r.reasons)).toEqual([]);
  });

  it('a script that wrote the content BEFORE a last product-tool write breaks the chain: red, between which calls said', async () => {
    const rel = 'nodal-bench/ventes-bench.xlsx';
    const r = await play(
      'file',
      {
        writes: [
          {
            tool: 'xlsx_set_range',
            rel,
            before: sha('par un script'),
            after: sha('final'),
            seq: 4,
          },
        ],
      },
      leave(rel, 'final'),
      { teamTools: ['xlsx_create', 'xlsx_set_range'] },
    );
    expect(pathRule(r.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: ${rel} was changed between the bench prepared it and xlsx_set_range (seq 4) by something that left no record (it was absent, then sha-256 ${sha('par un script').slice(0, 12)})`,
    ]);
  });

  it('a write recorded as a re-read is not a proof: "not recorded", never green', async () => {
    const rel = 'nodal-bench/ventes-bench.xlsx';
    const r = await play(
      'file',
      {
        writes: [
          {
            tool: 'xlsx_create',
            rel,
            before: 'absent',
            after: sha('final'),
            source: 'read',
            seq: 3,
          },
        ],
      },
      leave(rel, 'final'),
      { teamTools: ['xlsx_create', 'xlsx_set_range'] },
    );
    expect(pathRule(r.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: no write of ${rel} by xlsx_create, xlsx_set_range is recorded with the bytes it wrote`,
      `${PRODUCT_TOOL_NOT_USED}: the write of ${rel} by xlsx_create (seq 3) is not recorded with the bytes it wrote (a re-read of the disk, never a proof)`,
    ]);
  });

  it('a recorded write by a tool that is not one of the scenario: red, named', async () => {
    const rel = 'nodal-bench/ventes-bench.xlsx';
    const r = await play(
      'file',
      {
        writes: [
          { tool: 'xlsx_create', rel, before: 'absent', after: sha('cree'), seq: 1 },
          { tool: 'file_write', rel, before: sha('cree'), after: sha('final'), seq: 2 },
        ],
      },
      leave(rel, 'final'),
      { teamTools: ['xlsx_create', 'xlsx_set_range', 'file_write'] },
    );
    expect(pathRule(r.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: ${rel} was written by file_write (seq 2), not one of xlsx_create, xlsx_set_range`,
    ]);
  });

  it('a call that left the file as it was (same hash before and after) is part of the chain, never a breach', async () => {
    const rel = 'nodal-bench/ventes-bench.xlsx';
    const r = await play(
      'file',
      {
        writes: [
          { tool: 'xlsx_create', rel, before: 'absent', after: sha('final'), seq: 1 },
          {
            tool: 'file_edit',
            rel,
            before: sha('final'),
            after: sha('final'),
            source: 'read',
            seq: 2,
          },
        ],
      },
      leave(rel, 'final'),
      { teamTools: ['xlsx_create', 'xlsx_set_range'] },
    );
    expect(pathRule(r.reasons)).toEqual([]);
  });

  it.each(READS.map((s) => [s.id, s.productTools!] as const))(
    '%s: its file read by a command only is red; designated by its tool, a command reading it too is fine',
    async (id, pt) => {
      const rel = pt.reads[0]!;
      const cmd = { name: 'run_command', input: { command: `python -c "open('${rel}','rb')"` } };
      const alone = await play(id, { tools: [cmd] }, undefined, { teamTools: pt.tools });
      expect(pathRule(alone.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: no call of ${pt.tools.join(', ')} reads ${rel}`,
      ]);
      const field = pt.tools[0] === 'request_print' ? 'filePath' : 'path';
      const both = await play(
        id,
        { tools: [{ name: pt.tools[0]!, input: { [field]: `shared/${rel}` } }, cmd] },
        undefined,
        { teamTools: pt.tools },
      );
      expect(pathRule(both.reasons)).toEqual([]);
    },
  );

  it.each(NO_FILE.map((s) => [s.id, s.productTools!.tools] as const))(
    '%s: no file to attribute, so one call of its tool is the rule',
    async (id, tools) => {
      const none = await play(id, {}, undefined, { teamTools: tools });
      expect(pathRule(none.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: none of ${tools.join(', ')} was called`,
      ]);
      const one = await play(id, { tools: [{ name: `printer__${tools[0]}` }] }, undefined, {
        teamTools: [`printer__${tools[0]}`],
      });
      expect(pathRule(one.reasons)).toEqual([]);
    },
  );

  it('without any of its tools in the team, the rule says nothing: runTrial skips the trial before', async () => {
    for (const s of WITH_TOOLS) {
      expect(productToolGate(s, { teamTools: [] })).toEqual([
        `no agent of this workspace has the product tool this scenario is about (${s.productTools!.tools.join(', ')})`,
      ]);
      expect(productToolGate(s, { teamTools: [s.productTools!.tools[0]!] })).toEqual([]);
    }
  });

  it('PDF and code have no product tool: a command handling their files is the right path, never red for it', async () => {
    const pdf = await play(
      'pdf-read-total',
      {
        result: 'Facture FB-2026-117, total TTC 1 234,56 €.',
        tools: [
          { name: 'run_command', input: { command: 'pdftotext nodal-bench/facture-bench.pdf -' } },
        ],
      },
      undefined,
      { teamTools: ['run_command', 'xlsx_read', 'docx_read'] },
    );
    expect(pdf.reasons).toEqual([]);
  });

  it('every scenario with product tools says the rule in how it is judged (Bench Studio reads it), and carries no file-time check any more', () => {
    for (const c of buildCatalog().scenarios.filter((x) => x.productTools)) {
      expect(c.judgedBy.some((j) => j.includes(`"${PRODUCT_TOOL_NOT_USED}"`))).toBe(true);
      expect(c.unverified.map((u) => u.check)).not.toContain('content written by the product tool');
    }
  });
});

describe('the path of a tree', () => {
  it('a tool call whose job is not in the tree is kept under "no job", never dropped', () => {
    const f = TreeFactsSchema.parse({
      ...facts({ tools: [{ name: 'web_search' }] }),
      toolCalls: [
        {
          jobId: ROOT_ID,
          toolName: 'web_search',
          input: null,
          output: null,
          createdMs: 1,
        },
        {
          jobId: null,
          toolName: 'run_command',
          input: null,
          output: null,
          createdMs: 2,
        },
      ],
    });
    expect(toolPath(f)).toEqual([
      { job: ROOT_ID.slice(0, 8), agent: 'root', parent: null, tools: ['web_search'] },
      { job: 'no job', agent: null, parent: null, tools: ['run_command'] },
    ]);
  });
});
