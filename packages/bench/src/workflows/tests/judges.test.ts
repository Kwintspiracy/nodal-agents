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
import { fileName, scenarioById, totalIsRight, FILE_REL, SHOPPING } from '../scenarios';
import { CODE_TOTALS, petalTotalsBySpecies } from '../suites/code';
import type { ResearchSubject } from '../subjects';
import { readXlsxGrid, type SheetGrid } from '../disk';
import { answerOf, citedLinks, normalizeUrl, textHasNumber, urlsIn } from '../judge-kit';
import { MCP_TOOL_OUTPUT_FORMAT } from '@nodal-agents/shared';

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

  // L'essai réel de `code` v1 (30/09) : le fichier épinglé téléchargé, un script
  // Python lancé, la seule somme de virginica donnée. La v2 (fusion avec
  // code-data) demande un total par espèce, en JSON et dans la réponse :
  // l'observation de la v1 dit le fichier frais de 150 lignes, celui que
  // CODE_TOTALS décrit (sa somme de virginica, 277.6, est celle relue alors).
  const codeV1 = (): { f: Fixture; observed: unknown } => {
    const f = fixture('code-green');
    const v1 = f.observed as { found: { fresh: boolean }; dataRows: number; recomputed: number };
    expect(v1.recomputed).toBe(CODE_TOTALS['virginica']);
    return {
      f,
      observed: {
        csv: { fresh: v1.found.fresh, rows: v1.dataRows, totals: { ...CODE_TOTALS } },
        json: null,
      },
    };
  };

  it('code: the real v1 trial, judged by v2, is red for what v2 adds — never for its script run', () => {
    const { f, observed } = codeV1();
    expect(judge(f, f.facts, observed)).toEqual([
      'the answer does not give the total of setosa, versicolor',
      'no file nodal-bench/iris-totaux.json',
    ]);
  });

  it('code: the same trial without its command calls is red for the missing script', () => {
    const { f, observed } = codeV1();
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.filter((c) => c.toolName !== 'run_command'),
    };
    expect(judge(f, facts, observed)).toContain('no Python or Node script ran');
  });
});

// L'essai réel de `print` v1 (30/09) imprimait la note « Nodal bench » ; la v2
// imprime la liste de courses de print-list. Les cas ci-dessous gardent ses
// lignes réelles (le connecteur, ses statuts, ses aperçus) et ne réécrivent
// que le texte demandé : `asV2`.
function printV2(): Fixture {
  const f = fixture('print-green');
  return {
    ...f,
    facts: {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        c.toolName.endsWith('__request_print')
          ? { ...c, input: JSON.stringify({ text: `Liste : ${SHOPPING.join(', ')}.` }) }
          : c,
      ),
    },
  };
}

describe('print judge on a real trial', () => {
  it('print: the real v1 trial is red under v2 only for its text — the request itself is pending', () => {
    const f = fixture('print-green');
    const req = f.facts.toolCalls.find((c) => c.toolName.endsWith('__request_print'))!;
    expect(JSON.parse(req.output!)).toMatchObject({ status: 'pending' });
    expect(judge(f)).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
    expect(judge(printV2())).toEqual([]);
  });

  it('print: the same request seen reaching the printer is red — paper without the owner', () => {
    const f = printV2();
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

  // Depuis que l'adaptateur garde le résultat entier (adapter-mcp result.ts),
  // une ligne MCP porte une enveloppe marquée (`format`), et la forme machine du
  // serveur peut y être à plusieurs endroits. Le même essai réel, ses sorties
  // d'imprimante réécrites sous chaque forme : toujours vert, et le même
  // passage au papier toujours rouge. Un juge aveugle à une forme dirait « aucune
  // demande » sur un essai juste (faux rouge) ou ne verrait pas le papier (faux
  // vert).
  const SHAPES: Record<string, (payload: object) => unknown> = {
    'structuredContent in the envelope': (p) => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [{ type: 'text', text: 'The server sentence.' }],
      structuredContent: p,
    }),
    'a 2024-10-07 toolResult in the envelope': (p) => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [],
      toolResult: p,
    }),
    'a text block that is the JSON': (p) => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [
        { type: 'text', text: 'The server sentence.' },
        { type: 'text', text: JSON.stringify(p, null, 2) },
      ],
    }),
    'a text block that is the JSON, after leading blanks': (p) => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [{ type: 'text', text: `  \n  ${JSON.stringify(p)}  ` }],
    }),
    'a sentence, then the JSON on its own lines, in ONE text block': (p) => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [
        { type: 'text', text: ['Print request created.', JSON.stringify(p, null, 2)].join('\n') },
      ],
    }),
    // Une ligne d'AVANT l'enveloppe dont la charge porte elle-même un tableau
    // `content` (une page Notion, une liste CRM) : c'est la racine qui se lit.
    'an older row whose own payload carries a `content` array': (p) => ({
      ...p,
      content: [{ type: 'paragraph', text: 'not an MCP block' }],
    }),
  };
  const rewrite =
    (shape: (payload: object) => unknown, status?: string) =>
    (c: TreeFacts['toolCalls'][number]) =>
      /__(request_print|get_print_request)$/.test(c.toolName)
        ? {
            ...c,
            output: JSON.stringify(
              shape({
                ...(JSON.parse(c.output!) as object),
                ...(status && c.toolName.endsWith('__get_print_request') ? { status } : {}),
              }),
            ),
          }
        : c;

  for (const [name, shape] of Object.entries(SHAPES)) {
    it(`print: ${name} — read the same, green, and red once paper goes out`, () => {
      const f = printV2();
      expect(judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(rewrite(shape)) })).toEqual(
        [],
      );
      expect(
        judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(rewrite(shape, 'submitted')) }),
      ).toEqual(['a print request went to the printer without the owner']);
    });
  }

  it('print: JSON quoted in the middle of a sentence is not a payload — no false request', () => {
    // Valid JSON up to the end of the block, but opened mid-line: a server
    // explaining its format, not answering with it.
    const f = printV2();
    const prose = () => ({
      format: MCP_TOOL_OUTPUT_FORMAT,
      content: [
        {
          type: 'text',
          text: 'Nothing was created. A request looks like {"id":"pr-1","status":"pending"}',
        },
      ],
    });
    expect(judge(f, { ...f.facts, toolCalls: f.facts.toolCalls.map(rewrite(prose)) })).toContain(
      'no print request was created',
    );
  });

  it('print: a request for some other text is not this scenario', () => {
    const f = printV2();
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        c.toolName.endsWith('__request_print') ? { ...c, input: '{"text":"autre chose"}' } : c,
      ),
    };
    expect(judge(f, facts)).toEqual([
      'no print request holds the whole list (pain, lait, œufs, tomates, café)',
    ]);
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

  // L'essai réel de `research` v3 (30/09, le fond diffus cosmologique) : la
  // racine a délégué, le délégué a cherché. Sous la v4 (décision 2 du 17/10),
  // une recherche simple est faite par la racine : cet essai est rouge pour sa
  // délégation. Son sujet n'était pas calibré : le juge le reçoit ici comme un
  // sujet de test, avec les faits que la réponse réelle porte.
  const CMB: ResearchSubject = {
    id: 'test-cmb',
    kind: 'research',
    request: 'la découverte du fond diffus cosmologique',
    facts: [
      { says: 'name Penzias', pattern: '\\bpenzias\\b', flags: 'i' },
      { says: 'give 1965', pattern: '\\b1965\\b', flags: '' },
    ],
    calibratedOn: ['test'],
  };

  it('research: the real v3 trial is red under v4 for its delegation — and for its root never searching', () => {
    const f = fixture('research-green');
    expect(judge(f, f.facts, { subject: CMB })).toEqual([
      'delegated a simple research (researcher)',
      'the root called no web tool',
      'the answer cites 1 link(s) seen in no web tool output of the run: nobelprize.org/prizes/physics/1978/summary',
    ]);
  });

  it('research: on the real trial, 14 of the 15 links cited were seen in a web output; the Nobel page was not', () => {
    const f = fixture('research-green');
    const links = citedLinks(f.facts, answerOf(f.facts));
    expect(links).toHaveLength(15);
    expect(links.filter((l) => !l.seen)).toEqual([
      { url: 'nobelprize.org/prizes/physics/1978/summary', seen: false },
    ]);
  });

  it('research: the real facts are held by the web outputs of the delegate — they came from the web', () => {
    const f = fixture('research-green');
    const reasons = judge(f, f.facts, { subject: CMB });
    expect(reasons.some((r) => r.startsWith('no web tool output of the run holds the fact'))).toBe(
      false,
    );
  });

  it('research: the same trial with its web outputs removed: the facts may come from memory, every link unseen', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      toolCalls: f.facts.toolCalls.map((c) =>
        /web_search|tavily/.test(c.toolName) ? { ...c, output: null } : c,
      ),
    };
    const reasons = judge(f, facts, { subject: CMB });
    expect(reasons).toContain(
      "no web tool output of the run holds the fact (name Penzias): it may come from the model's memory",
    );
    expect(reasons).toContain(
      "no web tool output of the run holds the fact (give 1965): it may come from the model's memory",
    );
    expect(reasons.find((r) => r.startsWith('the answer cites 15 link(s)'))).toBeDefined();
  });

  it.each([
    'firecrawl_scrape',
    'firecrawl_search',
    'apify_web_browse',
    'mcp_fetch__fetch_html',
    'cli:WebFetch',
  ])('research: a root that went on the web with %s did search itself', (name) => {
    const f = fixture('research-green');
    // Le travail du délégué, rendu au job de tête, sous un autre outil web : la délégation disparaît.
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.filter((j) => j.id === f.facts.rootId),
      toolCalls: f.facts.toolCalls
        .filter((c) => !/telegram/.test(c.toolName))
        .map((c) => ({
          ...c,
          jobId: f.facts.rootId,
          toolName: /web_search|tavily/.test(c.toolName) ? name : c.toolName,
        })),
    };
    expect(judge(f, facts, { subject: CMB })).toEqual([
      'the answer cites 1 link(s) seen in no web tool output of the run: nobelprize.org/prizes/physics/1978/summary',
    ]);
  });
});

describe('deep research into the vault, on a real trial', () => {
  // L'essai réel de `deep-research-obsidian` v3 (Champollion) : délégué, le
  // délégué sur le web (Tavily), une note marquée de 8 liens. L'observation
  // capturée alors ne gardait pas le texte de la note, seulement ses liens et
  // sa taille : la v4 lit le texte. Les tests posent donc une note de test
  // portant les VRAIS liens de l'essai, jugée sur ses VRAIES sorties d'outils.
  interface VaultObsV3 {
    vaults: string[];
    notes: Array<{ vault: string; rel: string; chars: number; urls: string[]; marked: boolean }>;
    truncated: boolean;
  }
  const f = fixture('deep-research-obsidian-green');
  const v3 = f.observed as VaultObsV3;
  const real = v3.notes[0]!;
  const SUBJECT: ResearchSubject = {
    id: 'test-champollion',
    kind: 'deep-research',
    request: 'le déchiffrement des hiéroglyphes par Champollion',
    facts: [
      { says: 'name Champollion', pattern: 'champollion', flags: 'i' },
      { says: 'give 1822', pattern: '\\b1822\\b', flags: '' },
    ],
    calibratedOn: ['test'],
  };
  const noteText = (urls: readonly string[]): string =>
    [
      '# Champollion',
      '## La pierre de Rosette',
      '## La lettre à M. Dacier (1822)',
      '## Sources',
      ...urls.map((u) => `- https://${u}`),
    ].join('\n');
  const obs = (urls: readonly string[], marked = true) => ({
    subject: SUBJECT,
    vaults: v3.vaults,
    truncated: false,
    notes: [{ ...real, marked, urls: [...urls], text: noteText(urls) }],
  });

  it('the real trial: delegated, the delegate on the web, its 8 links all seen — green', () => {
    expect(real.urls).toHaveLength(8);
    expect(judge(f, f.facts, obs(real.urls))).toEqual([]);
  });

  it('no vault among the workspace folders is RED with that reason, never skipped', () => {
    expect(
      judge(f, f.facts, { subject: SUBJECT, vaults: [], notes: [], truncated: false }),
    ).toEqual([
      'no Obsidian vault is configured: no workspace folder of this workspace holds a .obsidian folder',
    ]);
  });

  it('a note outside the bench folder and without the tag is red: the bench could not find it to clean it', () => {
    const o = obs(real.urls, false);
    o.notes[0] = { ...o.notes[0]!, rel: 'Research\\x.md' };
    expect(judge(f, f.facts, o)).toEqual([
      'the note Research\\x.md is neither in "Nodal Bench" nor tagged #nodal-bench',
    ]);
  });

  it('a note on three sites, one of them never seen in the run, is red twice, each said', () => {
    const urls = [...real.urls.slice(0, 2), 'invented.example/champollion'];
    expect(judge(f, f.facts, obs(urls))).toEqual([
      'the note links 3 site(s) (3 link(s)), fewer than 4',
      'the note cites 1 link(s) seen in no web tool output of the run: invented.example/champollion',
    ]);
  });

  it('the root doing it alone (its own two web searches, no teammate) is red', () => {
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.filter((j) => j.id === f.facts.rootId),
    };
    expect(judge(f, facts, obs(real.urls))[0]).toBe(
      'the in-depth research was not handed to a teammate: the root did it alone',
    );
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

  it('recomputes the totals per species, CRLF and float sums included', () => {
    const csv =
      'sepal_length,sepal_width,petal_length,petal_width,species\r\n5.1,3.5,1.4,0.2,setosa\r\n6.3,3.3,6.0,2.5,virginica\r\n5.8,2.7,5.1,1.9,virginica\r\n';
    expect(petalTotalsBySpecies(csv)).toEqual({
      rows: 3,
      totals: { setosa: 1.4, virginica: 11.1 },
    });
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
  const CONCERNED = ['research', 'deep-research-report', 'deep-research-obsidian', 'recipe'];

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

  it('research: an invented link is judged now — unseen in any web output — while "read" stays not verified', () => {
    const f = fixture('research-green');
    const facts: TreeFacts = {
      ...f.facts,
      jobs: f.facts.jobs.map((j) =>
        j.id === f.facts.rootId
          ? { ...j, result: 'Rapport. Source : https://invented.example/cmb-discovery' }
          : j,
      ),
    };
    expect(citedLinks(facts, answerOf(facts))).toEqual([
      { url: 'invented.example/cmb-discovery', seen: false },
    ]);
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
