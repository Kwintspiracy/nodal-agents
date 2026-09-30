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
import { normalizeUrl, PAGE_MIN_CHARS, textHasNumber, urlsIn } from '../judge-kit';

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

  it('research: the real trial is green — delegated, the delegate read the web, a cited link was returned by a web search', () => {
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
      'none of the 2 source link(s) in the report was seen in a web result',
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

describe('deep research into the vault, on a real trial', () => {
  interface VaultObs {
    vaults: string[];
    notes: Array<{ vault: string; rel: string; chars: number; urls: string[]; marked: boolean }>;
    truncated: boolean;
  }
  const f = fixture('deep-research-obsidian-green');
  const obs = f.observed as VaultObs;
  const note = obs.notes[0]!;

  it('the real trial is green: delegated, a marked note of 12 k characters with 8 links, links returned by web retrievals', () => {
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

  it('a note with two links is red; with invented links only, red too', () => {
    expect(
      judge(f, f.facts, { ...obs, notes: [{ ...note, urls: note.urls.slice(0, 2) }] }),
    ).toEqual(['the note cites 2 source link(s), fewer than 3']);
    const invented = ['a.example/1', 'b.example/2', 'c.example/3'];
    expect(judge(f, f.facts, { ...obs, notes: [{ ...note, urls: invented }] })).toEqual([
      'none of the 3 source links of the note was seen in a web result',
    ]);
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

// Ce qu'est une source LUE (revue de la PR #634, passes 1 à 3).
//
// Trois fuites du même juge : une adresse prise dans l'ENTRÉE d'un outil (la
// note que le modèle écrit), puis dans une sortie d'échec en texte (`cli:*`),
// puis dans un échec sérialisé en chaîne ou en blocs par `executeTool`. Le
// défaut commun : fonder « lu » sur un drapeau de succès que les outils ne
// donnent pas de façon fiable. Le critère est donc devenu le CONTENU : une
// adresse est lue quand une sortie d'outil web porte, pour CETTE adresse, du
// contenu réel (un résultat de recherche avec son extrait, ou une page d'au
// moins `PAGE_MIN_CHARS` caractères hors adresses et blancs).
//
// Les lignes sont écrites comme en production : `executeTool` écrit
// `JSON.stringify(valeur rendue)`, le runtime CLI écrit le texte du
// `tool_result` tel quel (ou sa liste de blocs en JSON).
describe('a source is an address a web retrieval returned real content for', () => {
  const INVENTED = 'https://invented.example/cmb-discovery';
  const f = fixture('research-green');
  const root = f.facts.rootId;
  const child = f.facts.jobs.find((j) => j.id !== root)!.id;
  const at = f.facts.jobs[0]!.createdMs + 1_000;
  /** Une ligne écrite par `executeTool` : la valeur rendue, sérialisée. */
  const tool = (toolName: string, input: unknown, value: unknown, jobId = child) => ({
    jobId,
    toolName,
    input: JSON.stringify(input),
    output: JSON.stringify(value),
    createdMs: at,
  });
  /** Une ligne écrite par le runtime CLI : le texte du `tool_result`, tel quel. */
  const cli = (toolName: string, input: unknown, text: string) => ({
    jobId: child,
    toolName,
    input: JSON.stringify(input),
    output: text,
    createdMs: at,
  });
  const citing = (extra: TreeFacts['toolCalls'], url = INVENTED): TreeFacts => ({
    ...f.facts,
    jobs: f.facts.jobs.map((j) =>
      j.id === root ? { ...j, result: `Rapport. Source : ${url}` } : j,
    ),
    toolCalls: [...f.facts.toolCalls, ...extra],
  });
  const NONE = 'none of the 1 source link(s) in the report was seen in a web result';
  // Une vraie page, lue par un vrai essai (tavily_extract du 30/09, 2 941 caractères).
  const REAL_PAGE = (() => {
    const ex = f.facts.toolCalls.find((c) => c.toolName === 'tavily_extract')!;
    const r = (JSON.parse(ex.output!) as { results: Array<{ rawContent: string }> }).results;
    return r.map((x) => x.rawContent).sort((a, b) => a.length - b.length)[0]!;
  })();

  it('the real page of the fixture is well above the threshold, a failure message far below', () => {
    expect(REAL_PAGE.length).toBeGreaterThan(2 * PAGE_MIN_CHARS);
    expect(`Request to ${INVENTED} timed out after 60000ms`.length).toBeLessThan(
      PAGE_MIN_CHARS / 5,
    );
  });

  it('a link the model wrote into a note, then read back, is not a source', () => {
    const note = `# CMB\nSource : ${INVENTED}\n${REAL_PAGE}`;
    const facts = citing([
      tool('file_write', { path: 'CMB.md', content: note }, { ok: true, written: true }),
      tool('file_read', { path: 'CMB.md' }, { ok: true, content: note }),
    ]);
    expect(judge(f, facts)).toEqual([NONE]);
  });

  it.each([
    [
      'an MCP fetch that timed out (a string, as executeTool writes it)',
      tool(
        'mcp_fetch__fetch_txt',
        { url: INVENTED },
        `Request to ${INVENTED} timed out after 60000ms`,
      ),
    ],
    [
      'an MCP fetch that failed as a list of text blocks',
      tool('mcp_fetch__fetch_html', { url: INVENTED }, [
        { type: 'text', text: `Failed to fetch ${INVENTED} - status code 404` },
      ]),
    ],
    [
      'an error outcome written by executeTool',
      tool(
        'mcp_fetch__fetch_html',
        { url: INVENTED },
        {
          outcome: 'error',
          error: `fetch failed: ${INVENTED} answered 404`,
        },
      ),
    ],
    [
      'a Tavily extract that lists the address among its failures',
      tool(
        'tavily_extract',
        { urls: [INVENTED] },
        {
          results: [],
          failedResults: [{ url: INVENTED, error: 'not found' }],
        },
      ),
    ],
    [
      'a Tavily extract result with no content',
      tool(
        'tavily_extract',
        { urls: [INVENTED] },
        {
          results: [{ url: INVENTED, title: null, rawContent: '   ', truncated: false }],
          failedResults: [],
        },
      ),
    ],
    [
      'a search result with an empty snippet',
      tool(
        'web_search',
        { query: 'cmb' },
        { results: [{ title: 'CMB', url: INVENTED, snippet: '' }] },
      ),
    ],
    [
      'a CLI fetch answering 404 in text',
      cli('cli:WebFetch', { url: INVENTED }, `Failed to fetch ${INVENTED} - status code 404`),
    ],
    [
      'a CLI fetch failure serialized as blocks',
      cli(
        'cli:WebFetch',
        { url: INVENTED },
        JSON.stringify([{ type: 'text', text: `Request to ${INVENTED} timed out` }]),
      ),
    ],
    [
      'a CLI search listing (text, no structured result with its snippet)',
      cli(
        'cli:WebSearch',
        { query: 'cmb' },
        `Web search results for query: "cmb"\n\nLinks: [{"title":"CMB","url":"${INVENTED}"}]`,
      ),
    ],
    [
      // L'enveloppe d'échec du runtime CLI (Codex la pose sur un item `failed`),
      // devant une sortie aussi longue qu'une page.
      'a CLI call marked failed, however long its text',
      cli('cli:WebFetch', { url: INVENTED }, `<tool_use_error>${REAL_PAGE}`),
    ],
    [
      'a long page read under another address',
      tool(
        'mcp_fetch__fetch_txt',
        { url: 'https://other.example/page' },
        `${INVENTED}\n${REAL_PAGE}`,
      ),
    ],
    [
      'a page padded with addresses only',
      tool('mcp_fetch__fetch_txt', { url: INVENTED }, Array(200).fill(INVENTED).join('\n')),
    ],
  ])('not a source: %s', (_what, row) => {
    expect(judge(f, citing([row]))).toEqual([NONE]);
  });

  it.each([
    [
      'a real search result carrying the address with its snippet',
      tool(
        'web_search',
        { query: 'cmb' },
        {
          results: [{ title: 'CMB', url: INVENTED, snippet: 'The CMB was discovered in 1965.' }],
        },
      ),
    ],
    [
      'a real page fetched by MCP (a string, as executeTool writes it)',
      tool('mcp_fetch__fetch_txt', { url: INVENTED }, REAL_PAGE),
    ],
    [
      'a real page returned by Tavily extract for that address',
      tool(
        'tavily_extract',
        { urls: [INVENTED] },
        {
          results: [{ url: INVENTED, title: 'CMB', rawContent: REAL_PAGE, truncated: false }],
          failedResults: [],
        },
      ),
    ],
    [
      'a real page returned by a CLI fetch',
      cli('cli:WebFetch', { url: INVENTED, prompt: 'x' }, REAL_PAGE),
    ],
  ])('a source: %s', (_what, row) => {
    expect(judge(f, citing([row]))).toEqual([]);
  });

  it('the real trial stays green on its own real outputs', () => {
    expect(judge(f)).toEqual([]);
  });

  it('a delegate that only read files holding links did not read the web', () => {
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: [
        ...f.facts.toolCalls.filter((c) => !/web_search|tavily/.test(c.toolName)),
        tool(
          'file_read',
          { path: 'Cosmologie.md' },
          { ok: true, content: `https://en.wikipedia.org/wiki/CMB\n${REAL_PAGE}` },
        ),
      ],
    };
    expect(judge(f, facts)).toContain('the delegate read no web source');
  });

  it('deep research: a note whose links only the note itself carries is red, even read back', () => {
    const d = fixture('deep-research-obsidian-green');
    const obs = d.observed as {
      vaults: string[];
      notes: Array<{ vault: string; rel: string; chars: number; urls: string[]; marked: boolean }>;
      truncated: boolean;
    };
    const invented = ['a.example/1', 'b.example/2', 'c.example/3'];
    const text = invented.map((u) => `https://${u}`).join('\n');
    const kid = d.facts.jobs.find((j) => j.id !== d.facts.rootId)!.id;
    const facts: TreeFacts = {
      ...d.facts,
      toolCalls: [
        ...d.facts.toolCalls,
        tool('file_write', { path: 'Nodal Bench/x.md', content: text }, { ok: true }, kid),
        tool('file_read', { path: 'Nodal Bench/x.md' }, { ok: true, content: text }, kid),
      ],
    };
    expect(judge(d, facts, { ...obs, notes: [{ ...obs.notes[0]!, urls: invented }] })).toEqual([
      'none of the 3 source links of the note was seen in a web result',
    ]);
  });

  it('recipe: a photo is from the recipe site only if a page of that site was READ, not just asked for', () => {
    const r = fixture('recipe-red-file');
    const PHOTO = 'https://assets.marmiton.org/recipe/caviar.jpg';
    const PAGE = 'https://www.marmiton.org/recettes/caviar.aspx';
    const withImages = (extra: TreeFacts['toolCalls']): TreeFacts => ({
      ...r.facts,
      toolCalls: [
        ...r.facts.toolCalls.map((c) =>
          c.toolName.endsWith('__request_print')
            ? {
                ...c,
                input: JSON.stringify({ text: 'Caviar' }),
                output: JSON.stringify({
                  ...(JSON.parse(c.output!) as object),
                  images: { embedded: [{ origin: PHOTO }] },
                }),
              }
            : c,
        ),
        ...extra,
      ],
    });
    const reader = (value: unknown) =>
      tool('mcp_fetch__fetch_html', { url: PAGE }, value, r.facts.rootId);
    const notRead = `the photo does not come from the recipe site (${PHOTO} vs no page read)`;
    expect(judge(r, withImages([reader({ outcome: 'error', error: 'fetch failed' })]))).toEqual([
      notRead,
    ]);
    expect(judge(r, withImages([reader(`Request to ${PAGE} timed out after 60000ms`)]))).toEqual([
      notRead,
    ]);
    expect(judge(r, withImages([reader(`<html><img src="${PHOTO}">${REAL_PAGE}</html>`)]))).toEqual(
      [],
    );
  });
});
