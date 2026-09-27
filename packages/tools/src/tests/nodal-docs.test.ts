// nodal-docs.test.ts — what the support-desk tool actually answers.
//
// The incident (2026-09-21, fresh install): asked whether Telegram could be
// configured, the root agent said Telegram was not supported and offered to
// build an MCP server. Every assertion below runs against the REAL shipped
// index — not a fixture — because a fixture would prove the scoring function
// and nothing about whether the product's own documentation answers the
// question someone actually asked.
//
// No model, no network: the tool reads a JSON file and ranks it.

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  nodalDocsTool,
  NODAL_DOCS_MAX_SECTIONS,
  NODAL_DOCS_MAX_CHARS,
} from '../builtin/nodal-docs';
import {
  loadDocsIndex,
  searchDocs,
  queryTerms,
  docsIndexCandidatePaths,
} from '../builtin/docs-index';
import { createToolRegistry, registerBuiltins } from '../index';
import { computeToolWhitelist } from '../whitelist';
import { WhitelistDriftError } from '../errors';
import type { ToolContext } from '../types';

/** The tool never touches the DB or the network — an empty context is honest. */
const ctx = {} as ToolContext;

const ask = async (question: string): Promise<Awaited<ReturnType<typeof run>>> => run(question);
const run = (question: string) => nodalDocsTool.execute({ question }, ctx);

describe('nodal_docs @cap:consulter-l-aide/moteur', () => {
  it('answers "configure Telegram" with the Telegram guide and the Channels tab', async () => {
    const hits = await ask('configure Telegram');

    expect(hits.length).toBeGreaterThan(0);
    // The guide comes FIRST — not a connector page, not a changelog entry.
    expect(hits[0]?.page).toBe('Telegram');
    expect(hits[0]?.url.startsWith('/nodal-agents/docs/guides/telegram')).toBe(true);
    // And the answer says WHERE: the agent's Channels tab. This is the exact
    // sentence the agent had no way of knowing on 21/09.
    expect(hits[0]?.text).toContain('Channels tab');
  });

  it('answers "how do I set up a Telegram bot" with the setup steps, tab and field', async () => {
    const hits = await ask('how do I set up a Telegram bot');

    expect(hits[0]?.title).toBe('Set up the bot');
    expect(hits[0]?.url).toBe('/nodal-agents/docs/guides/telegram#set-up-the-bot');
    expect(hits[0]?.text).toContain('Channels tab');
    expect(hits[0]?.text).toContain('Bot token');
  });

  it('answers "cron" with the automations guide', async () => {
    const hits = await ask('cron');

    expect(hits.length).toBeGreaterThan(0);
    for (const hit of hits) {
      expect(hit.url.startsWith('/nodal-agents/docs/guides/automations')).toBe(true);
    }
    // One of them says where an automation is created, which is the point.
    expect(hits.map((h) => h.text).join(' ')).toContain('Run board');
  });

  it('says nothing rather than something, when the documentation has no answer', async () => {
    // A question about a product that is not this one must come back empty, so
    // the agent reports it honestly instead of dressing up the nearest page.
    const hits = await ask('zzqqxx');
    expect(hits).toEqual([]);
  });

  it('returns a bounded result — three passages, each clipped', async () => {
    // This runs inside an LLM turn on every "how do I": unbounded, consulting
    // the manual would be the expensive option and agents would stop doing it.
    const hits = await ask('agent');
    expect(hits.length).toBeLessThanOrEqual(NODAL_DOCS_MAX_SECTIONS);
    for (const hit of hits) {
      expect(hit.text.length).toBeLessThanOrEqual(NODAL_DOCS_MAX_CHARS);
    }
  });

  it('is deterministic — the same question twice gives the same passages', async () => {
    const a = await ask('how do I connect Slack');
    const b = await ask('how do I connect Slack');
    expect(a).toEqual(b);
  });

  it('ranks a heading match above a passing mention in the prose', () => {
    const index = {
      generator: 'test',
      sections: [
        {
          page: 'a',
          pageTitle: 'A',
          heading: 'Webhook triggers',
          url: '/a#webhook-triggers',
          text: 'Short.',
        },
        {
          page: 'b',
          pageTitle: 'B',
          heading: 'Something else',
          url: '/b#something-else',
          text: 'A webhook, and a webhook, and one more webhook for luck.',
        },
      ],
    };
    const hits = searchDocs(index, 'webhook', 2);
    expect(hits[0]?.url).toBe('/a#webhook-triggers');
  });

  it('prefers a section that answers the WHOLE question over one that answers half of it loudly', () => {
    // Reviewer C, pass 1 P2-11(a) then pass 2 C3. The first version of this
    // test passed with a fixture that repeated one word six times, and the
    // reviewer showed why: coverage was a bonus of at most three points against
    // a heading weight of six, so it decided nothing outside a band that only
    // repetition could reach. Coverage now SCALES the score, and the rule holds
    // without a thumb on the scale: `/heading` says one of the two words, in
    // the strongest field there is; `/both` says both, in the weakest.
    const index = {
      generator: 'test',
      sections: [
        {
          page: 'heading',
          pageTitle: 'P',
          heading: 'Telegram',
          url: '/heading',
          text: 'A paragraph about nothing in particular.',
        },
        {
          page: 'both',
          pageTitle: 'P',
          heading: 'Elsewhere',
          url: '/both',
          text: 'Connect a telegram bot here.',
        },
      ],
    };
    expect(searchDocs(index, 'connect telegram', 2)[0]?.url).toBe('/both');
  });

  it('never serves one index the words of another', () => {
    // The split words are memoised per index (Reviewer C, pass 2, P2-10), so
    // the wrong key would answer a question about one index out of another's
    // vocabulary. Keyed by identity, and proven by asking two in a row.
    const first = {
      generator: 'test',
      sections: [
        { page: 'a', pageTitle: 'A', heading: 'Webhooks', url: '/a', text: 'About webhooks.' },
      ],
    };
    const second = {
      generator: 'test',
      sections: [
        { page: 'b', pageTitle: 'B', heading: 'Schedules', url: '/b', text: 'About schedules.' },
      ],
    };
    expect(searchDocs(first, 'webhooks', 2).map((h) => h.url)).toEqual(['/a']);
    expect(searchDocs(second, 'webhooks', 2)).toEqual([]);
    expect(searchDocs(second, 'schedules', 2).map((h) => h.url)).toEqual(['/b']);
    expect(searchDocs(first, 'schedules', 2)).toEqual([]);
  });

  it('breaks a tie on the URL, never on the order the index was written in', () => {
    // Reviewer C, pass 1, P2-11(b). Two identical sections under different
    // URLs: without the tie-break the answer depends on which page the walker
    // reached first, so adding an unrelated page could silently change what the
    // agent is told.
    const section = { pageTitle: 'P', heading: 'Same', text: 'Identical words here.' };
    const index = {
      generator: 'test',
      sections: [
        { ...section, page: 'z', url: '/z' },
        { ...section, page: 'a', url: '/a' },
      ],
    };
    expect(searchDocs(index, 'identical words', 2).map((h) => h.url)).toEqual(['/a', '/z']);
    const reversed = { generator: 'test', sections: [...index.sections].reverse() };
    expect(searchDocs(reversed, 'identical words', 2).map((h) => h.url)).toEqual(['/a', '/z']);
  });

  it('matches a plural by prefix, and refuses to prefix-match a short word', () => {
    // Reviewer C, pass 1, P1-8 asked for a prefix counter-example in the real
    // vocabulary of these pages. There is none: the only words a query term
    // prefixes are its own plural ("webhook" into "webhooks", eleven times in
    // the guides) and `agentId`. What makes that safe is the length floor, and
    // that is what is pinned here.
    const index = {
      generator: 'test',
      sections: [
        { page: 'a', pageTitle: 'A', heading: 'Webhooks', url: '/a', text: 'About webhooks.' },
        { page: 'b', pageTitle: 'B', heading: 'Tokens', url: '/b', text: 'About a token.' },
      ],
    };
    // Long enough: the plural is the same topic.
    expect(searchDocs(index, 'webhook', 2)[0]?.url).toBe('/a');
    // Too short to prefix: "tok" must not reach "token", or a three-letter
    // fragment of a question would match every page that mentions one.
    expect(searchDocs(index, 'tok', 2)).toEqual([]);
  });

  it('drops the words every question carries, and keeps the ones that matter', () => {
    expect(queryTerms('how do I set up a Telegram bot')).toEqual(['set', 'up', 'telegram', 'bot']);
    // Every word a stopword: no terms, and the caller returns nothing rather
    // than the whole index.
    expect(queryTerms('how do I')).toEqual([]);
  });

  it('probes sibling first, then the dev layout — the shipped pack, then the repo', () => {
    // Same rule as packages/db/src/migrate.ts for migrations/: in the pack this
    // module is inlined at the root and the index sits beside it; in the repo it
    // is two levels above src/builtin/.
    const probed = docsIndexCandidatePaths('/pack');
    expect(probed[0]?.replace(/\\/g, '/')).toBe('/pack/docs-index.json');
    expect(probed[1]?.replace(/\\/g, '/')).toBe('/docs-index.json');
    expect(probed).toHaveLength(2);
  });

  it('rejects an empty question at the schema, before any search', () => {
    const schema = nodalDocsTool.inputSchema as z.ZodTypeAny;
    expect(schema.safeParse({ question: '' }).success).toBe(false);
    expect(schema.safeParse({ question: 'x'.repeat(401) }).success).toBe(false);
    expect(schema.safeParse({ question: 'configure Telegram' }).success).toBe(true);
  });

  it('shows its results as a search card, with each passage and its URL', async () => {
    const hits = await ask('how do I set up a Telegram bot');
    const payload = nodalDocsTool.present?.({
      input: { question: 'how do I set up a Telegram bot' },
      output: hits,
    });
    expect(payload?.card).toBe('search');
    const search = payload as { hits: { title: string; ref?: string }[] };
    expect(search.hits[0]?.title).toBe('Set up the bot');
    expect(search.hits[0]?.ref).toBe('/nodal-agents/docs/guides/telegram#set-up-the-bot');
  });
});

// #452 — run fb60655b : « le changelog de la 0.9.2 », 7 tours, 290 154 jetons,
// 5 min 17 s, parce que le changelog était exclu de l'index et que l'agent a
// dû aller le chercher sur GitHub. Il revient, une section par version,
// éligible SEULEMENT quand la question parle de versions.
describe('nodal_docs answers "what changed in version X" @cap:consulter-l-aide/moteur', () => {
  it('answers "what changed in 0.9.2" with the v0.9.2 release section first', async () => {
    const hits = await ask('what changed in 0.9.2');
    expect(hits[0]?.title).toMatch(/^v0\.9\.2\b/);
    expect(hits[0]?.url).toMatch(/^\/nodal-agents\/docs\/changelog#v092/);
  });

  it('answers "changelog" and "nouveautés de la 0.9.1" from the release notes', async () => {
    expect((await ask('changelog'))[0]?.url).toMatch(/^\/nodal-agents\/docs\/changelog#/);
    expect((await ask('nouveautés de la 0.9.1'))[0]?.title).toMatch(/^v0\.9\.1\b/);
  });

  // Word matching alone puts the wrong release first for these (measured with
  // the version rule disabled: v0.9.0, v0.8.0, v0.9.1): digits split into
  // single-character terms every release heading shares.
  for (const [question, version] of [
    ['changelog 0.8.9', '0.8.9'],
    ['release notes 0.8.11', '0.8.11'],
    ['version 0.9.0', '0.9.0'],
  ] as const) {
    it(`answers "${question}" with the v${version} section, whatever the words`, async () => {
      expect((await ask(question))[0]?.title.startsWith(`v${version} `)).toBe(true);
    });
  }

  // Revue Codex de #452, passe 2 : un numéro rattaché à un AUTRE produit n'est
  // pas une version de Nodal, même précédé d'un « v » ou du mot « version ».
  for (const question of [
    'Does Node v22.0 support this connector?',
    'Which OAuth version 2.0 does the Gmail connector use?',
    // Shaped like a Nodal version, but another product's number: the word
    // before it decides, not the shape (without this case the shape alone
    // would make the product check look proven).
    'Does the shell step work with ffmpeg 0.9.2?',
    'Is Node v0.9.1 enough to run a script?',
  ]) {
    it(`does not read "${question}" as a question about Nodal releases`, async () => {
      const hits = await ask(question);
      expect(hits.some((h) => h.url.startsWith('/nodal-agents/docs/changelog'))).toBe(false);
      expect(hits.some((h) => h.title.startsWith('No release notes'))).toBe(false);
    });
  }

  // Revue Codex de #452, passe 3 : un MOT de version ou un « v » collé au
  // numéro suffit, quel que soit le format du numéro — sauf produit nommé juste
  // avant. Le format ne décide que sans mot ni « v ». Deux parties = une version.
  it('a version word or a "v" makes it a Nodal release question, whatever the number', async () => {
    expect((await ask('what changed in version 1.0.0?'))[0]?.title).toBe(
      'No release notes for 1.0.0',
    );
    expect((await ask('v1.0.0'))[0]?.title).toBe('No release notes for 1.0.0');
  });

  // Revue Codex de #452, passe 4 (P2) : seule la PREMIÈRE version était lue,
  // et la limite de trois résultats pouvait faire disparaître la seconde série.
  it('reads EVERY version a question names, and shares the limit between the series', async () => {
    const hits = await ask('what changed between versions 0.8 and 0.9?');
    expect(hits.length).toBeLessThanOrEqual(NODAL_DOCS_MAX_SECTIONS);
    expect(hits.some((h) => /^v0\.8\.\d+ /.test(h.title))).toBe(true);
    expect(hits.some((h) => /^v0\.9\.\d+ /.test(h.title))).toBe(true);
    // One series present, one absent: the section AND the notice.
    const mixed = await ask('what changed between version 0.9.2 and 0.9.99?');
    expect(mixed.some((h) => h.title.startsWith('v0.9.2 '))).toBe(true);
    expect(mixed.some((h) => h.title === 'No release notes for 0.9.99')).toBe(true);
  });

  it('a two-part version covers its releases: "version 0.9?" serves a v0.9.x section', async () => {
    const hits = await ask('version 0.9?');
    expect(hits[0]?.title).toMatch(/^v0\.9\.\d+ /);
    expect(hits.some((h) => h.title.startsWith('No release notes'))).toBe(false);
  });

  it('says a version named WITH the product has no notes ("nodal 0.9.99")', async () => {
    const hits = await ask('nodal 0.9.99');
    expect(hits[0]?.title).toBe('No release notes for 0.9.99');
    // A number outside the shape of published versions still counts when the
    // question names the product.
    expect((await ask('is there a nodal 1.0.0'))[0]?.title).toBe('No release notes for 1.0.0');
  });

  // Revue Codex de #452, P1 : une version nommée et absente de l'index était
  // servie par ses voisines (« 0.9.99 » → v0.9.0, v0.9.1, v0.9.2). Elle le DIT.
  it('says a named version has no release notes, and names the latest, instead of serving its neighbours', async () => {
    const hits = await ask('what changed in 0.9.99');
    expect(hits[0]?.title).toBe('No release notes for 0.9.99');
    expect(hits[0]?.text).toMatch(/latest documented release is v\d+\.\d+\.\d+/);
    expect(hits.slice(1).some((h) => h.url.startsWith('/nodal-agents/docs/changelog'))).toBe(false);
  });

  // Revue Codex de #452, P1 : un nombre décimal nu n'est pas une question de
  // version. L'intention vient des MOTS, ou d'un « v » devant le numéro.
  for (const question of ['GPT-5.2', 'OAuth 2.0', 'temperature 0.7']) {
    it(`does not read "${question}" as a question about releases`, async () => {
      const hits = await ask(question);
      expect(hits.some((h) => h.url.startsWith('/nodal-agents/docs/changelog'))).toBe(false);
    });
  }

  it('reads a "v" before the number as a question about that release', async () => {
    expect((await ask('v0.9.1'))[0]?.title.startsWith('v0.9.1 ')).toBe(true);
  });

  it('keeps release notes out of a how-to question: its ranking is the one without them', () => {
    // The ticket's own example; the property proven is the general one — for a
    // question that does not ask about releases, the release sections change
    // nothing, so the how-to ranking stays whatever the pages make it.
    const index = loadDocsIndex();
    expect(index.sections.some((s) => s.release === true)).toBe(true);
    const withoutReleases = { ...index, sections: index.sections.filter((s) => !s.release) };
    for (const question of ['schedule a task every morning', 'configure Telegram', 'cron']) {
      const hits = searchDocs(index, question, NODAL_DOCS_MAX_SECTIONS);
      expect(hits.some((h) => h.url.startsWith('/nodal-agents/docs/changelog'))).toBe(false);
      expect(hits.map((h) => h.url)).toEqual(
        searchDocs(withoutReleases, question, NODAL_DOCS_MAX_SECTIONS).map((h) => h.url),
      );
    }
  });
});

describe('the words a person actually types @cap:consulter-l-aide/moteur', () => {
  // Issue #332, remainder of #316. `nodal_docs` scores on the words of the
  // pages, so a page only answers a question asked in its own vocabulary:
  // "remember something for later" reached a getting-started section about
  // sending something, and "how do I approve a command" reached the section
  // listing the commands that can NEVER be approved. The fix is in the
  // documentation, the single source — a synonym table in the tool would be
  // exactly the hand-written list #316 removed.
  //
  // FIVE of the six cases below fail on the documentation as it stood before
  // this change; "remember this" already reached the memory page and is pinned
  // here so the word cannot be dropped from it. (Verified by running this file
  // against main's docs-index.json: 5 failed, 1 passed.)
  //
  // Each case pins the page reached FIRST for a phrase a person types, so the
  // vocabulary cannot be edited back out of the pages without a red test.
  //
  // "approve a command" lands on the shell-commands guide and not on the
  // dashboard's Approvals screen, and that is the ranking working, not a miss:
  // on that page the word "commands" is in the title, in the path AND in the
  // heading, which no section of `reference/dashboard` can match. The guide
  // section is the one titled after the question and it links to the screen.
  const cases: [question: string, firstUrl: RegExp][] = [
    ['remember something for later', /^\/nodal-agents\/docs\/concepts\/memory(#|$)/],
    ['remember this', /^\/nodal-agents\/docs\/concepts\/memory(#|$)/],
    ['for later', /^\/nodal-agents\/docs\/concepts\/memory(#|$)/],
    ['next time', /^\/nodal-agents\/docs\/concepts\/memory(#|$)/],
    [
      'how do I approve a command',
      /^\/nodal-agents\/docs\/guides\/shell-commands#how-approval-works/,
    ],
    ['allow this command', /^\/nodal-agents\/docs\/reference\/dashboard#approvals/],
  ];

  for (const [question, firstUrl] of cases) {
    it(`answers "${question}" with the page that has the answer`, async () => {
      const hits = await ask(question);
      expect(hits[0]?.url).toMatch(firstUrl);
    });
  }
});

describe('nodal_docs on an agent whitelist @cap:assigner-outils/moteur', () => {
  it('is refused to an agent whose list does not carry it', () => {
    const registry = createToolRegistry();
    // Nothing registered: the name resolves to nothing, and the whitelist says
    // so loudly instead of handing the agent a silently empty toolset.
    expect(() =>
      computeToolWhitelist(
        { agentId: 'agent-1', configuredTools: ['nodal_docs'], alwaysOn: [] },
        registry,
      ),
    ).toThrow(WhitelistDriftError);

    const registered = createToolRegistry();
    registerBuiltins(registered);
    const withoutIt = computeToolWhitelist(
      { agentId: 'agent-1', configuredTools: ['query_memory'], alwaysOn: [] },
      registered,
    );
    expect(withoutIt.map((t) => t.name)).not.toContain('nodal_docs');

    const withIt = computeToolWhitelist(
      { agentId: 'agent-1', configuredTools: [], alwaysOn: ['nodal_docs'] },
      registered,
    );
    expect(withIt.map((t) => t.name)).toEqual(['nodal_docs']);
  });

  it('is in the registry and in the always-on list the runner passes', async () => {
    const registry = createToolRegistry();
    registerBuiltins(registry);
    expect(registry.get('nodal_docs')?.riskLevel).toBe('read');

    const { ALWAYS_ON_TOOLS, ALWAYS_ON_TOOL_DOCS } = await import('../builtin/index');
    expect(ALWAYS_ON_TOOLS).toContain('nodal_docs');
    // The prompt block is built from the docs array: out of sync, the agent is
    // told about a tool it does not have, or holds one it never hears about.
    expect(ALWAYS_ON_TOOL_DOCS.map((d) => d.name)).toContain('nodal_docs');
    expect(ALWAYS_ON_TOOL_DOCS).toHaveLength(ALWAYS_ON_TOOLS.length);
  });
});

describe('the shipped documentation index @cap:consulter-l-aide/moteur', () => {
  it('loads from the package and covers every channel and the automations', () => {
    const index = loadDocsIndex();
    const pages = new Set(index.sections.map((s) => s.page));
    for (const page of [
      'guides/telegram',
      'guides/discord',
      'guides/slack',
      'guides/whatsapp',
      'guides/automations',
      'guides/root-agent',
      'reference/dashboard',
    ]) {
      expect(pages, page).toContain(page);
    }
    expect(index.sections.length).toBeGreaterThan(100);
  });
});
