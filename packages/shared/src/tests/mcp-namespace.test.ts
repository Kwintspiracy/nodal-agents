// mcp-namespace.test.ts — one tool name, one MCP server (#661).

import { describe, it, expect } from 'vitest';
import {
  MCP_SERVER_SLUG_HTML_PATTERN,
  MCP_SERVER_SLUG_PATTERN,
  findMcpNamespaceOverlap,
  findMcpToolNameCollision,
  isToolOfMcpServer,
  mcpExposedToolNames,
  attributeMcpTool,
  mcpToolNameCollisionMessage,
  mcpNamespaceOverlapMessage,
  mcpToolNamespacesOverlap,
} from '../mcp-namespace';
import { mcpToolPrefix } from '../mcp-tool-prefix';
import { MCP_CATALOG } from '../mcp-catalog';

describe('the canonical MCP slug grammar @cap:connecter-un-service/moteur', () => {
  it('accepts words joined by single hyphens, every catalog-style slug', () => {
    for (const ok of ['a', 'guide-srv', 'cogni-cortex', 'mcp-fetch', 'x1-y2-z3', '42']) {
      expect(MCP_SERVER_SLUG_PATTERN.test(ok), ok).toBe(true);
    }
  });

  it('refuses a doubled, leading or trailing hyphen, and anything but [a-z0-9-]', () => {
    for (const bad of ['guide--srv', '-a', 'a-', '-', '', 'A', 'a_b', 'a b', 'a.b']) {
      expect(MCP_SERVER_SLUG_PATTERN.test(bad), bad).toBe(false);
    }
  });

  it('every catalog slug is canonical: the catalog is a creation path too', () => {
    for (const entry of MCP_CATALOG) {
      expect(MCP_SERVER_SLUG_PATTERN.test(entry.slug), entry.slug).toBe(true);
    }
  });

  it('the HTML pattern says the same thing, anchored as a browser anchors it', () => {
    const html = new RegExp(`^(?:${MCP_SERVER_SLUG_HTML_PATTERN})$`);
    for (const s of ['a', 'guide-srv', 'guide--srv', '-a', 'a-', 'A']) {
      expect(html.test(s), s).toBe(MCP_SERVER_SLUG_PATTERN.test(s));
    }
  });

  it('two different canonical slugs never overlap: the prefix is a bijection without `__`', () => {
    const slugs = ['a', 'a-b', 'a-b-c', 'ab', 'b', 'guide-srv', 'guide', 'srv-guide', 'a1', '1a'];
    for (const s of slugs) {
      expect(mcpToolPrefix(s)).not.toContain('__');
      expect(mcpToolPrefix(s).endsWith('_')).toBe(false);
    }
    for (const x of slugs) {
      for (const y of slugs) {
        expect(mcpToolNamespacesOverlap(x, y), `${x} / ${y}`).toBe(x === y);
      }
    }
  });
});

describe('mcpToolNamespacesOverlap @cap:connecter-un-service/moteur', () => {
  it('same slug: two instances of one catalog server', () => {
    expect(mcpToolNamespacesOverlap('cogni-cortex', 'cogni-cortex')).toBe(true);
  });

  it('slugs that fold onto the same prefix', () => {
    expect(mcpToolNamespacesOverlap('guide-srv', 'guide--srv')).toBe(true);
  });

  it('one namespace extending the other (a trailing hyphen)', () => {
    expect(mcpToolNamespacesOverlap('a', 'a-')).toBe(true);
    expect(mcpToolNamespacesOverlap('a-', 'a')).toBe(true);
    // …which is exactly the name that starts with both.
    expect(isToolOfMcpServer('a', 'a___ping')).toBe(true);
    expect(isToolOfMcpServer('a-', 'a___ping')).toBe(true);
  });

  it('distinct namespaces, even when one slug starts with the other', () => {
    expect(mcpToolNamespacesOverlap('a', 'a-b')).toBe(false);
    expect(mcpToolNamespacesOverlap('a', 'ab')).toBe(false);
    expect(mcpToolNamespacesOverlap('a', 'a--b')).toBe(false); // a_b: the run folds
  });
});

describe('findMcpNamespaceOverlap @cap:connecter-un-service/moteur', () => {
  it('names the first overlapping pair, or null', () => {
    const s = (slug: string, name = slug) => ({ slug, name });
    expect(findMcpNamespaceOverlap([s('a'), s('b'), s('c')])).toBeNull();
    expect(findMcpNamespaceOverlap([])).toBeNull();
    const pair = findMcpNamespaceOverlap([s('x'), s('guide-srv', 'One'), s('guide--srv', 'Two')]);
    expect(pair?.map((p) => p.name)).toEqual(['One', 'Two']);
  });

  it('the refusal names both servers and the way out', () => {
    const msg = mcpNamespaceOverlapMessage(
      { slug: 'cogni-cortex', name: 'Cortex perso' },
      { slug: 'cogni-cortex', name: 'Cortex boulot' },
    );
    expect(msg).toContain('"Cortex perso" (cogni-cortex)');
    expect(msg).toContain('"Cortex boulot" (cogni-cortex)');
    expect(msg).toContain('cogni_cortex__');
    expect(msg).toContain('detach one');
  });
});

describe('a tool name is attributed to the server that LENDS it @cap:connecter-un-service/moteur', () => {
  const tools = [{ name: 'ping' }, { name: 'pong' }];

  it('mcpExposedToolNames: discovered tools narrowed by the whitelist, prefixed', () => {
    expect(mcpExposedToolNames('guide-srv', tools, null)).toEqual([
      'guide_srv__ping',
      'guide_srv__pong',
    ]);
    expect(mcpExposedToolNames('guide-srv', tools, ['pong', 'gone'])).toEqual(['guide_srv__pong']);
    expect(mcpExposedToolNames('guide--srv', tools, [])).toEqual([]);
    // Unknown discovery: the whitelist alone says what is lent; neither known: null.
    expect(mcpExposedToolNames('a-', null, ['ping'])).toEqual(['a___ping']);
    expect(mcpExposedToolNames('a-', null, null)).toBeNull();
  });

  it('attributeMcpTool: namespace AND list — the namespace alone cannot tell guide-srv from guide--srv', () => {
    const lends = { slug: 'guide-srv', exposed: ['guide_srv__ping'] };
    const lendsNothing = { slug: 'guide--srv', exposed: [] as string[] };
    expect(attributeMcpTool([lendsNothing, lends], 'guide_srv__ping')).toEqual({
      server: lends,
      ambiguous: false,
    });
    // `a___ping` starts with `a__`, but `a` lends only `a__ping`.
    const a = { slug: 'a', exposed: ['a__ping'] };
    const aDash = { slug: 'a-', exposed: ['a___ping'] };
    expect(attributeMcpTool([a, aDash], 'a___ping')).toEqual({ server: aDash, ambiguous: false });
    expect(attributeMcpTool([a, aDash], 'a__ping')).toEqual({ server: a, ambiguous: false });
    // Alone in its namespace, a server is the one, whatever its list says.
    expect(attributeMcpTool([{ slug: 'a-', exposed: null }], 'a___ping')).toEqual({
      server: { slug: 'a-', exposed: null },
      ambiguous: false,
    });
    expect(attributeMcpTool([{ slug: 'b', exposed: null }], 'a___ping')).toBeNull();
  });

  it('attributeMcpTool: an unknown list next to another server is never a certainty (review pass 2)', () => {
    // `a`'s known list may be stale (it does not name the tool), `a-`'s is
    // unknown: either could lend it. Named, but flagged — never the wrong
    // server without the flag.
    const stale = { slug: 'a', exposed: ['a__other'] };
    const unknown = { slug: 'a-', exposed: null };
    expect(attributeMcpTool([stale, unknown], 'a___ping')?.ambiguous).toBe(true);
    // Two known lists that both lend it: flagged too.
    expect(
      attributeMcpTool(
        [
          { slug: 'x', exposed: ['x__ping'] },
          { slug: 'x', exposed: ['x__ping'] },
        ],
        'x__ping',
      )?.ambiguous,
    ).toBe(true);
    // No list names it, two servers share the namespace: flagged.
    expect(
      attributeMcpTool(
        [
          { slug: 'g-s', exposed: [] },
          { slug: 'g--s', exposed: [] },
        ],
        'g_s__ping',
      )?.ambiguous,
    ).toBe(true);
  });

  it('findMcpToolNameCollision: only a name lent by two servers', () => {
    const s = (slug: string, name: string, exposed: string[]) => ({ slug, name, exposed });
    expect(
      findMcpToolNameCollision([
        s('guide-srv', 'Guide', ['guide_srv__ping']),
        s('guide--srv', 'Guide bis', []),
        s('a', 'A', ['a__ping']),
        s('a-', 'A dash', ['a___ping']),
      ]),
    ).toBeNull();
    const hit = findMcpToolNameCollision([
      s('cogni-cortex', 'Perso', ['cogni_cortex__get_home', 'cogni_cortex__search']),
      s('cogni-cortex', 'Boulot', ['cogni_cortex__search']),
    ]);
    expect(hit?.toolName).toBe('cogni_cortex__search');
    expect(hit?.servers.map((x) => x.name)).toEqual(['Perso', 'Boulot']);
    expect(mcpToolNameCollisionMessage(hit!.toolName, ...hit!.servers)).toContain(
      '"Perso" (cogni-cortex) and "Boulot" (cogni-cortex) both lend this agent a tool named "cogni_cortex__search"',
    );
  });
});
