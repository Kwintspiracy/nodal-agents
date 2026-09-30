// judges.test.ts — les juges, éprouvés sur des essais RÉELS.
//
// Chaque fixture est la photo d'un vrai essai sur la stack du propriétaire,
// prise par `pnpm bench:workflows --capture <job> --scenario <id>` : lignes de
// agent_jobs / tool_calls / llm_calls / approval_requests, et ce que le banc a
// lu sur le disque. Rien n'y est inventé. Le dossier personnel y est remplacé
// par `~` (le dépôt est public).
//
// Un juge qui dit « vert » à tort est pire qu'aucun juge : ces cas sont écrits
// pour le prendre en défaut. Le juge `file` et le juge commun (approbation) ont
// été éprouvés par mutation : retirer la vérification fait rougir ces tests.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TreeFactsSchema, type TreeFacts } from '../facts';
import { scenarioById, totalIsRight, virginicaPetalSum, FILE_REL } from '../scenarios';
import { readXlsxGrid, type SheetGrid } from '../disk';
import { normalizeUrl, textHasNumber, urlsIn } from '../judge-kit';

const FIX = join(__dirname, 'fixtures');

interface Fixture {
  scenario: string;
  facts: TreeFacts;
  observed: unknown;
}
function fixture(name: string): Fixture {
  const raw = JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as Fixture;
  return { ...raw, facts: TreeFactsSchema.parse(raw.facts) };
}
function judge(f: Fixture, facts: TreeFacts = f.facts, observed: unknown = f.observed): string[] {
  const s = scenarioById(f.scenario);
  if (!s) throw new Error(`unknown scenario ${f.scenario}`);
  return s.judge(facts, observed);
}

describe('workflow judges on real trials', () => {
  it('question: the real green trial is green — Canberra, one job, nobody asked', () => {
    const f = fixture('question-green');
    expect(f.facts.jobs).toHaveLength(1);
    expect(f.facts.jobs[0]!.result).toMatch(/Canberra/);
    expect(judge(f)).toEqual([]);
  });

  it('file: the real trial that stopped on an approval is red for THAT reason, though the file was right', () => {
    const f = fixture('file-red-approval');
    // Le classeur écrit par l'essai était juste : ce rouge ne vient QUE de la
    // demande d'approbation (supprimer son script temporaire), et de l'annulation qui l'a suivie.
    expect(judge(f)).toEqual(['root ended cancelled', 'asked an approval (run_command)']);
  });

  it('file: the same trial without its approval row would be green — the cells were read, not assumed', () => {
    const f = fixture('file-red-approval');
    // Le jugement des cellules seul : on retire la ligne d'approbation ET
    // l'annulation qu'elle a provoquée. Ce qui reste est le fichier réel.
    const facts: TreeFacts = {
      ...f.facts,
      approvals: [],
      jobs: f.facts.jobs.map((j) => ({ ...j, status: 'completed' })),
    };
    expect(judge(f, facts)).toEqual([]);
  });

  it('file: a wrong cell in the real workbook is named, with what it holds and what was expected', () => {
    const f = fixture('file-red-approval');
    const obs = f.observed as { found: unknown; sheets: SheetGrid[]; readError: null };
    const cells = { ...obs.sheets[0]!.cells, B3: { kind: 'text' as const, value: '30' } };
    const facts: TreeFacts = {
      ...f.facts,
      approvals: [],
      jobs: f.facts.jobs.map((j) => ({ ...j, status: 'completed' })),
    };
    const reasons = judge(f, facts, { ...obs, sheets: [{ name: 'Ventes', cells }] });
    expect(reasons).toContain('B3 is "30", expected 30');
    // Le total n'est plus 100 quand B3 est du texte : la somme recalculée échoue aussi.
    expect(reasons).toContain('B5 is =SUM(B2:B4), expected a total of 100');
  });

  it('file: no file at all is red, and says where it was looked for', () => {
    const f = fixture('file-red-approval');
    const facts: TreeFacts = {
      ...f.facts,
      approvals: [],
      jobs: f.facts.jobs.map((j) => ({ ...j, status: 'completed' })),
    };
    expect(judge(f, facts, { found: null, sheets: null, readError: null })).toEqual([
      `no file ${FILE_REL} in any workspace folder`,
    ]);
  });

  it('code: the real green trial is green — file downloaded, script ran, 277.6 in the answer', () => {
    const f = fixture('code-green');
    expect(judge(f)).toEqual([]);
  });

  it('code: a value the model states without any script run is red', () => {
    const f = fixture('code-green');
    // Mêmes lignes, sans les appels de commande : la valeur n'a plus été calculée par un script.
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.filter((c) => c.toolName !== 'run_command'),
    };
    expect(judge(f, facts)).toEqual(['no Python or Node run printed 277.6']);
  });
});

describe('print judge on a real trial', () => {
  it('print: the real trial is green — a pending request holding the note, nothing sent to paper', () => {
    const f = fixture('print-green');
    const req = f.facts.toolCalls.find((c) => c.toolName.endsWith('__request_print'))!;
    expect(JSON.parse(req.output!)).toMatchObject({ status: 'pending' });
    expect(judge(f)).toEqual([]);
  });

  it('print: the same request seen reaching the printer is red — paper without the owner', () => {
    const f = fixture('print-green');
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        c.toolName.endsWith('__get_print_request')
          ? {
              ...c,
              output: JSON.stringify({ ...(JSON.parse(c.output!) as object), status: 'submitted' }),
            }
          : c,
      ),
    };
    expect(judge(f, facts)).toEqual(['a print request went to the printer without the owner']);
  });

  it('print: a request for some other text is not this scenario', () => {
    const f = fixture('print-green');
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        c.toolName.endsWith('__request_print') ? { ...c, input: '{"text":"autre chose"}' } : c,
      ),
    };
    expect(judge(f, facts)).toEqual(['no print request holds the text "Nodal bench"']);
  });
});

describe('recipe and research judges on real trials', () => {
  it('recipe: printing an old PDF of the workspace is red, and says the photo cannot be checked (not that it is missing)', () => {
    const f = fixture('recipe-red-file');
    const req = f.facts.toolCalls.find((c) => c.toolName.endsWith('__request_print'))!;
    // Le connecteur n'a rien dit d'images : il imprime un fichier tel quel.
    expect((JSON.parse(req.output!) as { images?: unknown }).images).toBeUndefined();
    expect(judge(f)).toEqual([
      'the request prints an existing file (caviar-aubergines.pdf, made before this run), whose pictures the connector does not report: the photo cannot be checked',
    ]);
  });

  it('research: the real trial is green — delegated, the delegate read the web, a cited link was seen by a tool', () => {
    const f = fixture('research-green');
    expect(f.facts.jobs.length).toBeGreaterThan(1);
    expect(judge(f)).toEqual([]);
  });

  it('research: the same report with invented links only is red', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.map((j) =>
        j.id === f.facts.rootId
          ? {
              ...j,
              result: 'Rapport. Sources : https://invented.example/a https://invented.example/b',
            }
          : j,
      ),
    };
    expect(judge(f, facts)).toEqual([
      'none of the 2 source link(s) in the report was seen by a tool',
    ]);
  });

  it('research: an answer without delegation is red', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.filter((j) => j.id === f.facts.rootId),
    };
    expect(judge(f, facts)).toContain('the research was not delegated');
  });
});

describe('what the judges read', () => {
  it('reads the real workbook of the trial with exceljs, the product library', async () => {
    const sheets = await readXlsxGrid(join(FIX, 'ventes-bench.xlsx'));
    expect(sheets.map((s) => s.name)).toEqual(['Ventes']);
    const c = sheets[0]!.cells;
    expect(c['B1']).toEqual({ kind: 'text', value: 'Unités' });
    expect(c['B4']).toEqual({ kind: 'number', value: 58 });
    expect(c['B5']).toEqual({ kind: 'formula', formula: 'SUM(B2:B4)', result: null });
    // Aucun résultat en cache (écrit par openpyxl) : le total est recalculé sur les cellules lues.
    expect(totalIsRight(c)).toBe(true);
    expect(totalIsRight({ ...c, B4: { kind: 'number', value: 57 } })).toBe(false);
  });

  it('recomputes the expected value on the pinned CSV', () => {
    const csv =
      'sepal_length,sepal_width,petal_length,petal_width,species\r\n5.1,3.5,1.4,0.2,setosa\r\n6.3,3.3,6.0,2.5,virginica\r\n5.8,2.7,5.1,1.9,virginica\r\n';
    expect(virginicaPetalSum(csv)).toEqual({ rows: 3, sum: 11.1 });
  });

  it('finds a number however the answer writes it, and not a longer one', () => {
    expect(textHasNumber('Somme : **277,6**', 277.6, 1)).toBe(true);
    expect(textHasNumber('total 277.60', 277.6, 1)).toBe(true);
    expect(textHasNumber('1277.6', 277.6, 1)).toBe(false);
    expect(textHasNumber('277', 277.6, 1)).toBe(false);
  });

  it('normalizes links so that two spellings of one page meet', () => {
    expect(normalizeUrl('https://www.Example.org/a/b/#x')).toBe('example.org/a/b');
    expect(urlsIn('voir (https://example.org/a/b). et https://example.org/a/b/')).toEqual([
      'example.org/a/b',
    ]);
    expect(urlsIn('{"url":"https:\\/\\/nasa.gov\\/cmb"}')).toEqual(['nasa.gov/cmb']);
  });
});
