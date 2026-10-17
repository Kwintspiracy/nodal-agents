// path-rules.test.ts — les règles de CHEMIN du catalogue du 17/10, sur tous les scénarios.
//
// Décision 1 : un outil du produit disponible doit servir. Un livrable est
// ÉCRIT par un outil attendu (un appel qui peut écrire le nomme, et le fichier
// n'a plus changé après la fin de ce dernier appel) ; un fichier à lire est LU
// par un outil attendu (un appel le nomme). Sinon l'essai est rouge, « product
// tool available, not used ». La règle est écrite une fois (judge-kit
// `productToolReasons`) et appliquée par runTrial à tout scénario qui déclare
// `productTools` : ces tests la jouent sur CHACUN d'eux, pas sur le seul
// scénario qui l'a fait naître.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog';
import { TreeFactsSchema } from '../facts';
import { PRODUCT_TOOL_NOT_USED, productToolGate, toolPath } from '../judge-kit';
import { declaredRiskLevel } from '../needs';
import { SCENARIOS } from '../scenarios';
import { ROOT_ID, facts, play } from './harness';

const WITH_TOOLS = SCENARIOS.filter((s) => s.productTools);
const WRITES = WITH_TOOLS.filter((s) => s.productTools!.writes.length > 0);
const READS = WITH_TOOLS.filter((s) => s.productTools!.reads.length > 0);
const NO_FILE = WITH_TOOLS.filter(
  (s) => s.productTools!.writes.length === 0 && s.productTools!.reads.length === 0,
);
const pathRule = (reasons: string[]): string[] =>
  reasons.filter((x) => x.startsWith(PRODUCT_TOOL_NOT_USED));
/** Les outils du scénario qui peuvent écrire, tels que le produit les déclare. */
const writersOf = (tools: readonly string[]): string[] =>
  tools.filter((t) => declaredRiskLevel(t) !== 'read');
/** Ce que le travail d'un agent laisse : le livrable écrit maintenant, au chemin déclaré. */
const writeNow =
  (rel: string) =>
  (root: string): void => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), 'written');
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
    '%s: no writing call of its tools names its deliverable: red, whatever else was called',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const reads = pt.tools.filter((t) => declaredRiskLevel(t) === 'read');
      const r = await play(
        id,
        {
          // Un appel d'alibi d'un outil de lecture du produit, s'il en a un, ne compte pas.
          tools: reads.map((t) => ({ name: t, input: { path: rel }, risk: 'read' as const })),
        },
        undefined,
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: no writing call of ${writersOf(pt.tools).join(', ')} names ${rel}`,
      ]);
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    '%s: its tool, even under a server prefix, wrote the deliverable last: the path rule is satisfied',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        () => ({
          tools: [
            {
              name: `office__${tool}`,
              input: { path: `shared/${rel}` },
              risk: 'write',
              at: Date.now(),
              durationMs: 400,
            },
          ],
        }),
        writeNow(rel),
        { teamTools: [`office__${tool}`] },
      );
      expect(pathRule(r.reasons)).toEqual([]);
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    '%s: its deliverable changed after its tool ended, by a tool on no list: red, naming the calls made after',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        () => ({
          tools: [
            {
              name: tool,
              input: { path: rel },
              risk: 'write',
              at: Date.now() - 60_000,
              durationMs: 300,
            },
            {
              name: 'fs__copy_file',
              input: { from: 'tmp/x', to: 'out' },
              risk: 'write',
              at: Date.now() - 2_000,
              durationMs: 100,
            },
          ],
        }),
        writeNow(rel),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: ${rel} was changed after the last ${tool} call (calls that may write, made after it: fs__copy_file)`,
      ]);
    },
  );

  it.each(WRITES.map((s) => [s.id, s.productTools!] as const))(
    '%s: a command that only READS the deliverable after its tool wrote it is never red for it',
    async (id, pt) => {
      const rel = pt.writes[0]!;
      const tool = writersOf(pt.tools)[0]!;
      const r = await play(
        id,
        () => ({
          tools: [
            { name: tool, input: { path: rel }, risk: 'write', at: Date.now(), durationMs: 400 },
            {
              name: 'run_command',
              input: { command: `ls -l ${rel} && type ${rel}` },
              risk: 'write',
              at: Date.now() + 500,
              durationMs: 50,
            },
          ],
        }),
        writeNow(rel),
        { teamTools: pt.tools },
      );
      expect(pathRule(r.reasons)).toEqual([]);
    },
  );

  it.each(READS.map((s) => [s.id, s.productTools!] as const))(
    '%s: its file read by a command only is red; read by its tool, a command reading it too is fine',
    async (id, pt) => {
      const rel = pt.reads[0]!;
      const cmd = {
        name: 'run_command',
        input: { command: `python -c "open('${rel}','rb')"` },
        risk: 'write' as const,
      };
      const alone = await play(id, { tools: [cmd] }, undefined, { teamTools: pt.tools });
      expect(pathRule(alone.reasons)).toEqual([
        `${PRODUCT_TOOL_NOT_USED}: no call of ${pt.tools.join(', ')} names ${rel}`,
      ]);
      const both = await play(
        id,
        { tools: [{ name: pt.tools[0]!, input: { path: rel } }, cmd] },
        undefined,
        { teamTools: pt.tools },
      );
      expect(pathRule(both.reasons)).toEqual([]);
    },
  );

  it('a read by the product tool of ANOTHER file is no read of the scenario file (an alibi)', async () => {
    const r = await play(
      'excel-read-answer',
      { tools: [{ name: 'xlsx_read', input: { path: 'tmp/ventes-trimestre.xlsx' } }] },
      undefined,
      { teamTools: ['xlsx_read'] },
    );
    expect(pathRule(r.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: no call of xlsx_read names nodal-bench/ventes-trimestre.xlsx`,
    ]);
  });

  it('a path written the Windows way, escaped in the JSON input, still names the file', async () => {
    const r = await play(
      'excel-read-answer',
      {
        tools: [
          {
            name: 'xlsx_read',
            input: { path: 'C:\\ws\\shared\\nodal-bench\\ventes-trimestre.xlsx' },
          },
        ],
      },
      undefined,
      { teamTools: ['xlsx_read'] },
    );
    expect(pathRule(r.reasons)).toEqual([]);
  });

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

  it('a writing call with no recorded end cannot be shown to have written last: red, said so', async () => {
    const r = await play(
      'file',
      () => ({
        tools: [
          {
            name: 'xlsx_create',
            input: { path: 'nodal-bench/ventes-bench.xlsx' },
            risk: 'write',
            at: Date.now(),
            durationMs: null,
          },
        ],
      }),
      writeNow('nodal-bench/ventes-bench.xlsx'),
      { teamTools: ['xlsx_create', 'xlsx_set_range'] },
    );
    expect(pathRule(r.reasons)).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: the last xlsx_create call naming nodal-bench/ventes-bench.xlsx has no recorded end, so it cannot be shown to have written the file last`,
    ]);
  });

  it('every scenario with a deliverable says, not verified, that the content may come from a script before a last product-tool write', () => {
    for (const c of buildCatalog().scenarios.filter(
      (x) => (x.productTools?.writes.length ?? 0) > 0,
    ))
      expect(c.unverified.map((u) => [u.check, u.ticket])).toContainEqual([
        'content written by the product tool',
        '#779',
      ]);
  });

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

  it('every scenario with product tools says the rule in how it is judged (Bench Studio reads it)', () => {
    for (const c of buildCatalog().scenarios.filter((x) => x.productTools)) {
      expect(c.judgedBy.some((j) => j.includes(`"${PRODUCT_TOOL_NOT_USED}"`))).toBe(true);
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
          riskLevel: 'read',
          durationMs: 5,
        },
        {
          jobId: null,
          toolName: 'run_command',
          input: null,
          output: null,
          createdMs: 2,
          riskLevel: 'write',
          durationMs: 5,
        },
      ],
    });
    expect(toolPath(f)).toEqual([
      { job: ROOT_ID.slice(0, 8), agent: 'root', parent: null, tools: ['web_search'] },
      { job: 'no job', agent: null, parent: null, tools: ['run_command'] },
    ]);
  });
});

// Revue Reviewer A de #777, passe 1 : les deux P2 de la règle « outil du produit contourné ».
describe('review pass 1 of #777: the deliverable must be WRITTEN by a product tool', () => {
  const STOCK = 'nodal-bench/stock.xlsx';
  const TOOLS = ['xlsx_read', 'xlsx_set_range', 'xlsx_set_cell'];
  const write = (root: string): void => {
    writeFileSync(join(root, 'nodal-bench', 'stock.xlsx'), 'rewritten by a script');
  };

  it('P2 false green: an alibi read by the product tool, then an interpreter outside any list writes the file', async () => {
    const r = await play(
      'excel-edit-column',
      () => ({
        tools: [
          {
            name: 'xlsx_read',
            input: { path: STOCK },
            risk: 'read',
            at: Date.now() - 60_000,
            durationMs: 50,
          },
          {
            name: 'notebook__python_repl',
            input: { code: 'wb.save(p)' },
            risk: 'write',
            at: Date.now() - 1_000,
            durationMs: 900,
          },
        ],
      }),
      write,
      { teamTools: TOOLS },
    );
    expect(r.reasons.filter((x) => x.startsWith(PRODUCT_TOOL_NOT_USED))).toEqual([
      `${PRODUCT_TOOL_NOT_USED}: no writing call of xlsx_set_range, xlsx_set_cell names ${STOCK}`,
    ]);
  });

  it('P2 false red: the product tool writes, then a command only READS the file: green on the path', async () => {
    const r = await play(
      'excel-edit-column',
      () => ({
        tools: [
          {
            name: 'xlsx_set_range',
            input: { path: STOCK },
            risk: 'write',
            at: Date.now(),
            durationMs: 500,
          },
          {
            name: 'run_command',
            input: { command: `python -c "print(open('${STOCK}','rb').read()[:4])"` },
            risk: 'write',
            at: Date.now() + 600,
            durationMs: 300,
          },
        ],
      }),
      write,
      { teamTools: TOOLS },
    );
    expect(r.reasons.filter((x) => x.startsWith(PRODUCT_TOOL_NOT_USED))).toEqual([]);
  });
});
