// suites-answers.test.ts — les juges des questions, recherches et recherches approfondies.
//
// Chaque juge a un cas vert et un cas rouge par vérification. Les réponses
// vertes sont écrites comme un modèle les écrirait (phrases, liens Markdown,
// nombres avec espaces) : un juge trop étroit serait un faux rouge.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { play, KID_ID } from './harness';

const WEB = { name: 'web_search', input: { query: 'x' } };
const WEB_KID = { ...WEB, job: KID_ID };

describe('question judges', () => {
  it('question-percent: 397,8 written the French way is green; 398 is red', async () => {
    expect(
      (await play('question-percent', { result: '17 % de 2 340 font **397,8**.' })).reasons,
    ).toEqual([]);
    expect((await play('question-percent', { result: 'Environ 398.' })).reasons).toEqual([
      'the answer does not give 397.8',
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

  it('question-seconds: 604 800 with a space is green', async () => {
    expect(
      (await play('question-seconds', { result: 'Une semaine compte 604 800 secondes.' })).reasons,
    ).toEqual([]);
    expect((await play('question-seconds', { result: '86 400 secondes.' })).reasons).toEqual([
      'the answer does not give 604800',
    ]);
  });

  it('question-river: a delegated answer is red even when right', async () => {
    expect((await play('question-river', { result: 'La Loire.' })).reasons).toEqual([]);
    expect(
      (await play('question-river', { result: 'La Loire.', delegated: true })).reasons,
    ).toEqual(['delegated a direct question (helper)']);
  });

  it('an approval asked is red, whatever the answer', async () => {
    expect((await play('question-river', { result: 'La Loire.', approvals: 1 })).reasons).toEqual([
      'asked an approval (run_command)',
    ]);
  });
});

describe('research judges', () => {
  const PEN =
    'Alexander Fleming a découvert la pénicilline en 1928, par hasard, sur une culture contaminée. ' +
    'Sources : [Wikipédia](https://fr.wikipedia.org/wiki/P%C3%A9nicilline), https://www.britannica.com/science/penicillin.';

  it('research-penicillin: facts, a web call by any job and two sites is green', async () => {
    expect(
      (await play('research-penicillin', { result: PEN, tools: [WEB_KID], delegated: true }))
        .reasons,
    ).toEqual([]);
    // Sans délégation : le root a cherché lui-même, c'est vert aussi.
    expect((await play('research-penicillin', { result: PEN, tools: [WEB] })).reasons).toEqual([]);
  });

  it('research-penicillin: no web call is red, whatever the answer says', async () => {
    expect((await play('research-penicillin', { result: PEN })).reasons).toEqual([
      'no job of the run called a web tool',
    ]);
  });

  it('research-penicillin: two links on ONE site count as one site', async () => {
    const oneSite = PEN.replace(
      'https://www.britannica.com/science/penicillin',
      'https://fr.wikipedia.org/wiki/Fleming',
    );
    expect((await play('research-penicillin', { result: oneSite, tools: [WEB] })).reasons).toEqual([
      'the answer links 1 site(s), fewer than 2',
    ]);
  });

  it('research-transistor: each missing fact is named', async () => {
    const r = await play('research-transistor', {
      result: 'Shockley, aux Bell Labs. https://a.example/x https://b.example/y',
      tools: [WEB],
    });
    expect(r.reasons).toEqual([
      'the answer does not name Bardeen',
      'the answer does not name Brattain',
      'the answer does not give 1947',
    ]);
  });
});

describe('deep research judges', () => {
  const report = (extra = ''): string =>
    [
      '# La double hélice',
      '## Les équipes',
      'Watson et Crick, à Cambridge, publient en 1953. '.repeat(30),
      '## Les données',
      'Rosalind Franklin obtient la Photo 51 au King’s College. '.repeat(30),
      '## Sources',
      '- https://fr.wikipedia.org/wiki/ADN',
      '- https://www.nature.com/articles/171737a0',
      '- https://www.britannica.com/biography/Rosalind-Franklin',
      '- https://www.science.org/doi/10.1126/science.1',
      extra,
    ].join('\n');

  const write =
    (text: string) =>
    (root: string): void => {
      mkdirSync(join(root, 'nodal-bench'), { recursive: true });
      writeFileSync(join(root, 'nodal-bench', 'rapport-adn.md'), text);
    };

  it('deep-research-dna: a long sourced report with sections and the facts is green', async () => {
    expect(
      (await play('deep-research-dna', { tools: [WEB_KID], delegated: true }, write(report())))
        .reasons,
    ).toEqual([]);
  });

  it('deep-research-dna: no report written is red, and says where', async () => {
    expect((await play('deep-research-dna', { tools: [WEB] })).reasons).toEqual([
      'no report nodal-bench/rapport-adn.md in any workspace folder',
    ]);
  });

  it('deep-research-dna: short, flat, under-sourced and missing a fact: each said', async () => {
    const thin = '# ADN\nWatson et Crick, 1953, Franklin. https://a.example/x';
    expect((await play('deep-research-dna', { tools: [WEB] }, write(thin))).reasons).toEqual([
      `the report holds ${thin.length} characters, fewer than 3000`,
      'the report has 1 section heading(s), fewer than 3',
      'the report links 1 site(s) (1 link(s)), fewer than 4',
      'the report does not name Photo 51',
    ]);
  });
});
