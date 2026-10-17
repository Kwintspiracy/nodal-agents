// path-rules.test.ts — les règles de CHEMIN du catalogue du 17/10, sur tous les scénarios.
//
// Décision 1 : un outil du produit disponible doit servir. Si l'un des outils
// attendus d'un scénario est dans l'équipe, l'arbre doit en appeler un, et
// aucune commande ne doit traiter un fichier du scénario à sa place ; sinon
// l'essai est rouge, « product tool available, not used ». La règle est écrite
// une fois (judge-kit `productToolReasons`) et appliquée par runTrial à tout
// scénario qui déclare `productTools` : ces tests la jouent sur CHACUN d'eux,
// pas sur le seul scénario qui l'a fait naître.

import { describe, expect, it } from 'vitest';
import { buildCatalog } from '../catalog';
import { TreeFactsSchema } from '../facts';
import { PRODUCT_TOOL_NOT_USED, productToolGate, toolPath } from '../judge-kit';
import { SCENARIOS } from '../scenarios';
import { ROOT_ID, facts, play } from './harness';

const WITH_TOOLS = SCENARIOS.filter((s) => s.productTools);
const WITH_FILES = WITH_TOOLS.filter((s) => (s.productTools?.files.length ?? 0) > 0);
const base = (rel: string): string => rel.split('/').pop()!;

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
    expect(WITH_TOOLS).toHaveLength(18);
  });

  it.each(WITH_TOOLS.map((s) => [s.id, s.productTools!.tools] as const))(
    '%s: its tools in the team but none called is red, with the rule named',
    async (id, tools) => {
      const r = await play(id, {}, undefined, { teamTools: tools });
      expect(r.reasons).toContain(
        `${PRODUCT_TOOL_NOT_USED}: none of ${tools.join(', ')} was called`,
      );
    },
  );

  it.each(WITH_TOOLS.map((s) => [s.id, s.productTools!.tools] as const))(
    '%s: one of its tools called, even under a server prefix, satisfies the rule',
    async (id, tools) => {
      const r = await play(id, { tools: [{ name: `office__${tools[0]}`, input: {} }] }, undefined, {
        teamTools: [`office__${tools[0]}`],
      });
      expect(r.reasons.filter((x) => x.startsWith(PRODUCT_TOOL_NOT_USED))).toEqual([]);
    },
  );

  it.each(WITH_FILES.map((s) => [s.id, s.productTools!] as const))(
    '%s: a command naming its file is the product tool bypassed, even when the tool was called too',
    async (id, pt) => {
      const name = base(pt.files[0]!);
      const r = await play(
        id,
        {
          tools: [
            { name: pt.tools[0]!, input: {} },
            { name: 'run_command', input: { command: `python -c "work('nodal-bench/${name}')"` } },
          ],
        },
        undefined,
        { teamTools: pt.tools },
      );
      expect(r.reasons).toContain(
        `${PRODUCT_TOOL_NOT_USED}: a command handled ${name} (run_command)`,
      );
    },
  );

  it('a script written during the run that names the file, then run by a command that does not, is a bypass too', async () => {
    const r = await play(
      'excel-edit-column',
      {
        tools: [
          {
            name: 'file_write',
            input: {
              path: 'shared/scripts/edit.py',
              content: "wb = load('nodal-bench/stock.xlsx')",
            },
          },
          { name: 'bash', input: { command: 'python3 scripts/edit.py' } },
        ],
      },
      undefined,
      { teamTools: ['xlsx_read', 'xlsx_set_range'] },
    );
    expect(r.reasons).toContain(
      `${PRODUCT_TOOL_NOT_USED}: none of xlsx_read, xlsx_set_range was called`,
    );
    expect(r.reasons).toContain(
      `${PRODUCT_TOOL_NOT_USED}: a command handled stock.xlsx through edit.py (bash)`,
    );
  });

  it('a script that names the file but is never run is not a bypass', async () => {
    const r = await play(
      'excel-read-answer',
      {
        result: 'Le Café moulu, 550.',
        tools: [
          { name: 'xlsx_read', input: { path: 'nodal-bench/ventes-trimestre.xlsx' } },
          {
            name: 'file_write',
            input: { path: 'notes/plan.py', content: 'ventes-trimestre.xlsx' },
          },
        ],
      },
      undefined,
      { teamTools: ['xlsx_read'] },
    );
    expect(r.reasons).toEqual([]);
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
      expect(c.judgedBy.some((j) => j.includes(`(red: "${PRODUCT_TOOL_NOT_USED}")`))).toBe(true);
    }
  });
});

describe('the path of a tree', () => {
  it('a tool call whose job is not in the tree is kept under "no job", never dropped', () => {
    const f = TreeFactsSchema.parse({
      ...facts({ tools: [{ name: 'web_search' }] }),
      toolCalls: [
        { jobId: ROOT_ID, toolName: 'web_search', input: null, output: null, createdMs: 1 },
        { jobId: null, toolName: 'run_command', input: null, output: null, createdMs: 2 },
      ],
    });
    expect(toolPath(f)).toEqual([
      { job: ROOT_ID.slice(0, 8), agent: 'root', parent: null, tools: ['web_search'] },
      { job: 'no job', agent: null, parent: null, tools: ['run_command'] },
    ]);
  });
});
