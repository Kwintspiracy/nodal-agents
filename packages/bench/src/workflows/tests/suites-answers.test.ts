// suites-answers.test.ts — les juges des questions, recherches et recherches approfondies.
//
// Chaque juge a un cas vert et un cas rouge par vérification. Les réponses
// vertes sont écrites comme un modèle les écrirait (phrases, liens Markdown,
// nombres avec espaces) : un juge trop étroit serait un faux rouge.
//
// Une recherche joue un sujet CALIBRÉ (subjects.ts) : les tests en posent un,
// inventé pour eux (le phare de Kerbénec n'existe pas, aucun modèle ne le
// connaît de mémoire), comme le fichier des sujets le donnerait.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ResearchSubject } from '../subjects';
import { play, KID_ID } from './harness';

/** Un sujet calibré tel que `readResearchSubjects` le rend. */
function subject(kind: ResearchSubject['kind']): ResearchSubject {
  return {
    id: `test-${kind}`,
    kind,
    request: 'la mise en service du phare de Kerbénec',
    facts: [
      { says: 'give 1897', pattern: '\\b1897\\b', flags: '' },
      { says: 'name Kerbénec', pattern: 'kerb[ée]nec', flags: 'i' },
    ],
    calibratedOn: ['model-a', 'model-b'],
  };
}
const RESEARCH = { subject: subject('research') };
const DEEP = { subject: subject('deep-research') };

/** Une recherche web dont la sortie rend des résultats : adresses et extraits, comme Tavily ou web_search. */
function search(urls: string[], content: string, job?: string) {
  return {
    name: 'web_search',
    input: { query: 'phare Kerbénec mise en service' },
    output: JSON.stringify({ results: urls.map((url) => ({ url, content })) }),
    ...(job ? { job } : {}),
  };
}
const FOUND = 'Le phare de Kerbénec est mis en service en 1897.';
const A = 'https://fr.wikipedia.org/wiki/Phare_de_Kerbenec';
const B = 'https://www.phares-bretagne.example/kerbenec';
const ANSWER = `Le phare de Kerbénec a été mis en service en 1897. Sources : [Wikipédia](${A}), ${B}.`;

describe('question judges', () => {
  it('question: Canberra is green; a delegated answer is red even when right', async () => {
    expect((await play('question', { result: 'Canberra.' })).reasons).toEqual([]);
    expect((await play('question', { result: 'Canberra.', delegated: true })).reasons).toEqual([
      'delegated a direct question (helper)',
    ]);
    expect((await play('question', { result: 'Sydney.' })).reasons).toEqual([
      'the answer does not name Canberra',
    ]);
  });

  it('question-weekday: mardi is green; naming another weekday too is red', async () => {
    expect(
      (await play('question-weekday', { result: 'Le 14 juillet 1789 était un mardi.' })).reasons,
    ).toEqual([]);
    expect(
      (await play('question-weekday', { result: 'C’était un mardi, ou peut-être un mercredi.' }))
        .reasons,
    ).toEqual(['the answer names another weekday']);
  });

  it('an approval asked is red, whatever the answer', async () => {
    expect((await play('question', { result: 'Canberra.', approvals: 1 })).reasons).toEqual([
      'asked an approval (run_command)',
    ]);
  });
});

describe('research (the root alone, a calibrated subject, facts and links seen on the web)', () => {
  it('green: the root searched, the facts and both links are in its search output', async () => {
    const r = await play(
      'research',
      { result: ANSWER, tools: [search([A, B], FOUND)] },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual([]);
  });

  it('a delegated research is red (decision 2), even when the answer is right', async () => {
    const r = await play(
      'research',
      { result: ANSWER, tools: [search([A, B], FOUND)], delegated: true },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual(['delegated a simple research (helper)']);
  });

  it('a web call made only by a delegate is not the root searching', async () => {
    const r = await play(
      'research',
      { result: ANSWER, tools: [search([A, B], FOUND, KID_ID)], delegated: true },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual([
      'delegated a simple research (helper)',
      'the root called no web tool',
    ]);
  });

  it('the facts given from memory are red: no web output holds them, and the links were never seen', async () => {
    const r = await play('research', { result: ANSWER }, undefined, RESEARCH);
    expect(r.reasons).toEqual([
      'the root called no web tool',
      "no web tool output of the run holds the fact (give 1897): it may come from the model's memory",
      "no web tool output of the run holds the fact (name Kerbénec): it may come from the model's memory",
      'the answer cites 2 link(s) seen in no web tool output of the run: fr.wikipedia.org/wiki/Phare_de_Kerbenec, phares-bretagne.example/kerbenec',
    ]);
  });

  it('a search that found the pages but not the fact: the fact is red, the links are seen', async () => {
    const r = await play(
      'research',
      { result: ANSWER, tools: [search([A, B], 'Un phare breton, sur une pointe rocheuse.')] },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual([
      "no web tool output of the run holds the fact (give 1897): it may come from the model's memory",
    ]);
  });

  it('a link the search never returned is unseen, and named', async () => {
    const invented = `${ANSWER} Voir aussi https://invented.example/kerbenec-1897.`;
    const r = await play(
      'research',
      { result: invented, tools: [search([A, B], FOUND)] },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual([
      'the answer cites 1 link(s) seen in no web tool output of the run: invented.example/kerbenec-1897',
    ]);
  });

  it('a page fetched from memory that only echoes its own address is not seen (the 404 leak of #634)', async () => {
    const C = 'https://memoire.example/phare';
    const fetch404 = {
      name: 'mcp_fetch__fetch_html',
      input: { url: C },
      output: `Error: 404 Not Found for ${C}`,
    };
    const r = await play(
      'research',
      { result: `${ANSWER} ${C}`, tools: [search([A, B], FOUND), fetch404] },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual([
      'the answer cites 1 link(s) seen in no web tool output of the run: memoire.example/phare',
    ]);
  });

  it('a link that only a non-web tool returned (reading back its own file) is not seen', async () => {
    const reread = { name: 'file_read', input: { path: 'notes.md' }, output: `${A} ${B} ${FOUND}` };
    const r = await play('research', { result: ANSWER, tools: [reread] }, undefined, RESEARCH);
    expect(r.reasons).toContain(
      'the answer cites 2 link(s) seen in no web tool output of the run: fr.wikipedia.org/wiki/Phare_de_Kerbenec, phares-bretagne.example/kerbenec',
    );
  });

  it('a JSON output escaping its accents still holds the fact', async () => {
    const escaped = {
      name: 'tavily_search',
      input: { query: 'phare' },
      output: `{"results":[{"url":"${A}","content":"Kerb\\u00e9nec, 1897"},{"url":"${B}","content":"x"}]}`,
    };
    const r = await play('research', { result: ANSWER, tools: [escaped] }, undefined, RESEARCH);
    expect(r.reasons).toEqual([]);
  });

  it('two links on ONE site count as one site', async () => {
    const C = 'https://fr.wikipedia.org/wiki/Kerbenec';
    const r = await play(
      'research',
      { result: `Kerbénec, 1897. ${A} ${C}`, tools: [search([A, C], FOUND)] },
      undefined,
      RESEARCH,
    );
    expect(r.reasons).toEqual(['the answer links 1 site(s), fewer than 2']);
  });
});

describe('deep research (handed to the specialist, a calibrated subject, a report)', () => {
  const SITES = [
    'https://fr.wikipedia.org/wiki/Phare_de_Kerbenec',
    'https://www.phares-bretagne.example/kerbenec',
    'https://archives.finistere.example/phares/kerbenec',
    'https://www.patrimoine.example/kerbenec-1897',
  ];
  const report = (sites = SITES): string =>
    [
      '# Le phare de Kerbénec',
      '## La construction',
      'Le chantier dure quatre ans.',
      '## La mise en service',
      'Le feu est allumé en 1897.',
      '## Sources',
      ...sites.map((u) => `- ${u}`),
    ].join('\n');
  const write =
    (text: string) =>
    (root: string): void => {
      mkdirSync(join(root, 'nodal-bench'), { recursive: true });
      writeFileSync(join(root, 'nodal-bench', 'rapport.md'), text);
    };
  const kidSearch = search(SITES, FOUND, KID_ID);

  it('green: delegated, the delegate searched, sections, four sites seen, the facts seen', async () => {
    const r = await play(
      'deep-research-dna',
      { tools: [kidSearch], delegated: true },
      write(report()),
      DEEP,
    );
    expect(r.reasons).toEqual([]);
  });

  it('the root doing the in-depth research alone is red (decision 2)', async () => {
    const r = await play(
      'deep-research-dna',
      { tools: [search(SITES, FOUND)] },
      write(report()),
      DEEP,
    );
    expect(r.reasons).toEqual([
      'the in-depth research was not handed to a teammate: the root did it alone',
    ]);
  });

  it('a delegate that never went on the web is red, whatever the root searched', async () => {
    const r = await play(
      'deep-research-dna',
      { tools: [search(SITES, FOUND)], delegated: true },
      write(report()),
      DEEP,
    );
    expect(r.reasons).toEqual(['no delegated job called a web tool']);
  });

  it('no report written is red, and says where', async () => {
    const r = await play(
      'deep-research-dna',
      { tools: [kidSearch], delegated: true },
      undefined,
      DEEP,
    );
    expect(r.reasons).toEqual(['no report nodal-bench/rapport.md in any workspace folder']);
  });

  it('flat, under-sourced, unseen and missing a fact: each said', async () => {
    const thin = '# Kerbénec\nUn phare. https://a.example/x';
    const r = await play(
      'deep-research-dna',
      { tools: [kidSearch], delegated: true },
      write(thin),
      DEEP,
    );
    expect(r.reasons).toEqual([
      'the report has 1 section heading(s), fewer than 3',
      'the report links 1 site(s) (1 link(s)), fewer than 4',
      'the report cites 1 link(s) seen in no web tool output of the run: a.example/x',
      'the report does not give 1897',
    ]);
  });

  it('the Obsidian note follows the same rules: green, then red on a site never seen', async () => {
    const vault =
      (text: string) =>
      (root: string): void => {
        mkdirSync(join(root, '.obsidian'), { recursive: true });
        mkdirSync(join(root, 'Nodal Bench'), { recursive: true });
        writeFileSync(join(root, 'Nodal Bench', 'Kerbenec.md'), text);
      };
    const green = await play(
      'deep-research-obsidian',
      { tools: [kidSearch], delegated: true },
      vault(report()),
      DEEP,
    );
    expect(green.reasons).toEqual([]);
    const other = [...SITES.slice(0, 3), 'https://ailleurs.example/kerbenec'];
    const red = await play(
      'deep-research-obsidian',
      { tools: [kidSearch], delegated: true },
      vault(report(other)),
      DEEP,
    );
    expect(red.reasons).toEqual([
      'the note cites 1 link(s) seen in no web tool output of the run: ailleurs.example/kerbenec',
    ]);
  });
});
