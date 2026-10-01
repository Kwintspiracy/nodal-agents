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
import { fileName, scenarioById, totalIsRight, virginicaPetalSum, FILE_REL } from '../scenarios';
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

  it('print: rows that keep the whole MCP result (content + structuredContent) are judged the same', () => {
    // Depuis que l'adaptateur garde le résultat entier (adapter-mcp result.ts),
    // la ligne porte `{ content, structuredContent }`. Le même essai réel, ses
    // sorties d'imprimante écrites sous cette forme : toujours vert, et le même
    // passage au papier toujours rouge. Un juge aveuglé par la nouvelle forme
    // serait vert à tort.
    const f = fixture('print-green');
    const asRecord = (status?: string) => (c: TreeFacts['toolCalls'][number]) =>
      /__(request_print|get_print_request)$/.test(c.toolName)
        ? {
            ...c,
            output: JSON.stringify({
              content: [{ type: 'text', text: 'The server sentence.' }],
              structuredContent: {
                ...(JSON.parse(c.output!) as object),
                ...(status && c.toolName.endsWith('__get_print_request') ? { status } : {}),
              },
            }),
          }
        : c;
    expect(judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(asRecord()) })).toEqual([]);
    expect(
      judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(asRecord('submitted')) }),
    ).toEqual(['a print request went to the printer without the owner']);
  });

  it('print: a server that serializes its result in a text block (no structuredContent) is judged the same', () => {
    // La forme que la spec recommande pour les clients qui ne lisent que
    // `content` : la forme machine, sérialisée dans un bloc texte, après une
    // phrase. Le juge doit la lire — sinon faux rouge (« no print request »)
    // sur un essai juste, et faux vert sur un passage au papier.
    const f = fixture('print-green');
    const asText = (status?: string) => (c: TreeFacts['toolCalls'][number]) =>
      /__(request_print|get_print_request)$/.test(c.toolName)
        ? {
            ...c,
            output: JSON.stringify({
              content: [
                { type: 'text', text: 'The server sentence.' },
                {
                  type: 'text',
                  text: JSON.stringify(
                    {
                      ...(JSON.parse(c.output!) as object),
                      ...(status && c.toolName.endsWith('__get_print_request') ? { status } : {}),
                    },
                    null,
                    2,
                  ),
                },
              ],
            }),
          }
        : c;
    expect(judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(asText()) })).toEqual([]);
    expect(judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(asText('submitted')) })).toEqual(
      ['a print request went to the printer without the owner'],
    );
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

  it('research: the real trial is green — delegated, the delegate called web tools, the report cites links', () => {
    const f = fixture('research-green');
    expect(f.facts.jobs.length).toBeGreaterThan(1);
    expect(judge(f)).toEqual([]);
  });

  it('research: a report without any source link is red', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.map((j) =>
        j.id === f.facts.rootId ? { ...j, result: 'Rapport, sans aucune source.' } : j,
      ),
    };
    expect(judge(f, facts)).toEqual(['no source link in the report']);
  });

  it('research: a delegate that called no web tool is red, whatever files it read', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.filter((c) => !/web_search|tavily/.test(c.toolName)),
    };
    expect(judge(f, facts)).toEqual(['the delegate called no web tool']);
  });

  it.each([
    'firecrawl_scrape',
    'firecrawl_search',
    'apify_web_browse',
    'mcp_fetch__fetch_html',
    'cli:WebFetch',
  ])('research: a delegate that went on the web with %s did call a web tool', (name) => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        /web_search|tavily/.test(c.toolName) ? { ...c, toolName: name } : c,
      ),
    };
    expect(judge(f, facts)).toEqual([]);
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

describe('deep research into the vault, on a real trial', () => {
  interface VaultObs {
    vaults: string[];
    notes: Array<{ vault: string; rel: string; chars: number; urls: string[]; marked: boolean }>;
    truncated: boolean;
  }
  const f = fixture('deep-research-obsidian-green');
  const obs = f.observed as VaultObs;
  const note = obs.notes[0]!;

  it('the real trial is green: delegated, a marked note of 12 k characters with 8 links', () => {
    expect(note.marked).toBe(true);
    expect(note.urls.length).toBe(8);
    expect(judge(f)).toEqual([]);
  });

  it('no vault among the workspace folders is RED with that reason, never skipped', () => {
    expect(judge(f, f.facts, { vaults: [], notes: [], truncated: false })).toEqual([
      'no Obsidian vault is configured: no workspace folder of this workspace holds a .obsidian folder',
    ]);
  });

  it('a note outside the bench folder and without the tag is red: the bench could not find it to clean it', () => {
    const o: VaultObs = { ...obs, notes: [{ ...note, rel: 'Research\\x.md', marked: false }] };
    expect(judge(f, f.facts, o)).toEqual([
      'the note Research\\x.md is neither in "Nodal Bench" nor tagged #nodal-bench',
    ]);
  });

  it('a note with two links is red', () => {
    expect(
      judge(f, f.facts, { ...obs, notes: [{ ...note, urls: note.urls.slice(0, 2) }] }),
    ).toEqual(['the note cites 2 source link(s), fewer than 3']);
  });
});

describe('recipe: a refused call beside the request', () => {
  it('names the file of the request that was created, not the empty one of a refused call', () => {
    const f = fixture('recipe-red-file-2');
    // Deux appels : une demande créée (le PDF), puis un appel refusé par le connecteur (filePath vide).
    expect(f.facts.toolCalls.filter((c) => c.toolName.endsWith('__request_print'))).toHaveLength(2);
    expect(judge(f)).toEqual([
      'the request prints an existing file (caviar-aubergines.pdf, made before this run), whose pictures the connector does not report: the photo cannot be checked',
    ]);
  });
});

describe('comfyui-telegram on a real trial', () => {
  const f = fixture('comfyui-telegram-green');

  it('is green: an image written during the run, and that very image sent with ok', () => {
    const send = f.facts.toolCalls.find((c) => c.toolName === 'send_image')!;
    expect(JSON.parse(send.output!)).toEqual({ ok: true, bytes: 1575446 });
    expect(judge(f)).toEqual([]);
  });

  it('a send that never returned ok is red, whatever the model says', () => {
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        c.toolName === 'send_image'
          ? { ...c, output: '{"outcome":"error","error":"telegram_timeout: AMBIGUOUS OUTCOME"}' }
          : c,
      ),
    };
    expect(judge(f, facts)).toEqual(['no send was confirmed (the tool never returned ok)']);
  });

  it('an image that is not fresh does not count as produced by the run', () => {
    const o = f.observed as { images: Array<{ path: string; exists: boolean; fresh: boolean }> };
    const stale = { images: o.images.map((i) => ({ ...i, fresh: false })) };
    expect(judge(f, f.facts, stale)).toEqual(['no image file was written during the run']);
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

  it('names a file the same way on Windows and on Linux (the CI judges Windows paths)', () => {
    expect(fileName('~\\.nodalai\\workspaces\\x\\shared\\outputs\\8e113b94_000.png')).toBe(
      '8e113b94_000.png',
    );
    expect(fileName('C:/a/b/c.pdf')).toBe('c.pdf');
    expect(fileName('c.pdf')).toBe('c.pdf');
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

// « Une source citée a réellement été lue » : retiré des juges, et DIT.
//
// Quatre passes de revue (#634) ont trouvé quatre fuites dans le juge qui le
// devinait à partir des sorties d'outils. Décision de Quentin (30/09) : le banc
// ne le juge plus tant que la plateforme n'enregistre pas le fait (#648). Le
// critère n'est pas pour autant tu : chaque scénario concerné porte un contrôle
// « sources read » à l'état « not verified », et aucun juge ne rend un vert qui
// l'affirmerait.
describe('sources read: not verified, never judged, never silent', () => {
  const CONCERNED = ['research', 'deep-research-obsidian', 'recipe'];

  it.each(CONCERNED)(
    '%s carries the named check, not verified, with its reason and ticket',
    (id) => {
      const s = scenarioById(id)!;
      expect(s.unverified).toEqual([
        {
          check: 'sources read',
          state: 'not verified',
          reason: expect.stringMatching(/\S/) as unknown as string,
          ticket: '#648',
        },
      ]);
      // Le vert promis le dit aussi : il ne prétend pas que les sources ont été lues.
      expect(s.green).toMatch(/not verified yet \(#648\)/);
    },
  );

  it('the other scenarios carry no unverified check', () => {
    const others = ['question', 'file', 'code', 'print', 'comfyui-telegram'];
    for (const id of others) expect(scenarioById(id)!.unverified ?? []).toEqual([]);
  });

  it('research: invented links are no longer judged — the judge is silent on them, the check says not verified', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.map((j) =>
        j.id === f.facts.rootId
          ? { ...j, result: 'Rapport. Source : https://invented.example/cmb-discovery' }
          : j,
      ),
    };
    expect(judge(f, facts)).toEqual([]);
    expect(scenarioById('research')!.unverified?.[0]?.state).toBe('not verified');
  });

  it('recipe: a printed page with a photo is not judged on where the photo comes from', () => {
    const r = fixture('recipe-red-file');
    const withPhoto = (embedded: Array<{ origin: string }>): TreeFacts => ({
      ...r.facts,
      toolCalls: r.facts.toolCalls.map((c) =>
        c.toolName.endsWith('__request_print')
          ? {
              ...c,
              output: JSON.stringify({
                ...(JSON.parse(c.output!) as object),
                images: { embedded },
              }),
            }
          : c,
      ),
    });
    expect(judge(r, withPhoto([{ origin: 'assets.somewhere-else.example' }]))).toEqual([]);
    expect(judge(r, withPhoto([]))).toEqual(['no photo in the printed page']);
  });
});
