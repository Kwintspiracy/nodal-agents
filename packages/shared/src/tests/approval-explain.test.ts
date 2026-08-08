// approval-explain.test.ts — the card must be readable.
//
// Every case here is a real approval the owner received on 2026-08-07 and could
// not interpret. The old card labelled both of them "irreversible or destructive
// action" — one was fetching a CHANGELOG off GitHub.

import { describe, it, expect } from 'vitest';
import { explainApproval, parseMcpToolName, renderExplanationText } from '../approval-explain';

describe('parseMcpToolName', () => {
  it('splits a namespaced MCP tool name', () => {
    expect(parseMcpToolName('mcp_fetch__fetch_markdown')).toEqual({
      prefix: 'mcp_fetch',
      tool: 'fetch_markdown',
    });
  });

  it('returns null for a built-in — builtins are bare snake_case', () => {
    expect(parseMcpToolName('run_command')).toBeNull();
    expect(parseMcpToolName('file_write')).toBeNull();
  });

  it('returns null when `__` is at position 0 (no server prefix)', () => {
    expect(parseMcpToolName('__weird')).toBeNull();
  });
});

describe('explainApproval — the two requests the owner could not read', () => {
  it('explains mcp_fetch__fetch_markdown in plain language, not as "destructive"', () => {
    const x = explainApproval({
      toolName: 'mcp_fetch__fetch_markdown',
      toolInput: {
        url: 'https://raw.githubusercontent.com/Kwintspiracy/nodal-agents/main/CHANGELOG.md',
        max_length: 20000,
      },
      mcp: {
        slug: 'mcp-fetch',
        name: 'Fetch',
        endpoint: 'npx',
        toolDescription: 'Fetch a URL and return its content as markdown.',
      },
    });

    expect(x.what).toContain('fetch markdown');
    expect(x.what).toContain('Fetch');
    // The old wording. It must never come back for a third-party tool.
    expect(x.what.toLowerCase()).not.toContain('irreversible');
    expect(x.effectLabel.toLowerCase()).not.toContain('destruct');

    // The destination is what makes this decidable.
    expect(x.target).toBe(
      'https://raw.githubusercontent.com/Kwintspiracy/nodal-agents/main/CHANGELOG.md',
    );

    // Provenance is the load-bearing field: WHOSE tool is this.
    expect(x.provenance.kind).toBe('mcp');
    expect(x.provenance.name).toBe('Fetch');
    expect(x.provenance.endpoint).toBe('npx');
    expect(x.provenance.supplied).toContain('Fetch a URL');

    // The product wrote none of this tool, so it claims no impact of its own.
    expect(x.impact).toBeNull();

    // Real arguments, both of them, verbatim.
    expect(x.args.map((a) => a.key).sort()).toEqual(['max_length', 'url']);
  });

  it('explains cogni_cortex_tatooine__get_home with its server and endpoint', () => {
    const x = explainApproval({
      toolName: 'cogni_cortex_tatooine__get_home',
      toolInput: {},
      mcp: {
        slug: 'cogni-cortex-tatooine',
        name: 'cogni-cortex-tatooine',
        endpoint: 'https://cogni-web-psi.vercel.app/api/mcp',
      },
    });
    expect(x.what).toContain('get home');
    expect(x.target).toBe('https://cogni-web-psi.vercel.app/api/mcp');
    expect(x.effect).toBe('external');
    expect(x.args).toEqual([]);
    expect(x.impact).toBeNull();
  });

  it('honours a server-declared readOnlyHint in the WORDING only', () => {
    // The hint softens the label so a read is not shown as an outside effect —
    // but the approval was still required to reach this point, which is the
    // security decision. A hostile server can lie here and gain nothing.
    const x = explainApproval({
      toolName: 'srv__list_items',
      toolInput: {},
      mcp: { slug: 'srv', name: 'Srv', endpoint: 'https://srv.test', readOnlyHint: true },
    });
    expect(x.effect).toBe('read');
    expect(x.effectLabel).toContain('déclarée par le serveur');
  });

  it('says so when the MCP server cannot be resolved, instead of inventing a verdict', () => {
    const x = explainApproval({
      toolName: 'ghost_server__do_thing',
      toolInput: { a: 1 },
      mcp: null,
    });
    expect(x.effect).toBe('unknown');
    expect(x.what).toContain('non identifié');
    expect(x.impact).toBeNull();
  });
});

describe('explainApproval — built-in tools keep their deterministic impact', () => {
  it('keeps the impact sentence for run_command', () => {
    const x = explainApproval({ toolName: 'run_command', toolInput: { command: 'rm -rf /tmp/x' } });
    expect(x.provenance.kind).toBe('builtin');
    expect(x.effect).toBe('destructive');
    expect(x.impact).toBeTruthy();
    expect(x.impact).toContain('rm');
  });

  it('names the file a write lands on', () => {
    const x = explainApproval({
      toolName: 'file_write',
      toolInput: { path: 'shared/rapport.md', content: 'x' },
    });
    expect(x.target).toBe('shared/rapport.md');
    expect(x.effect).toBe('write');
  });
});

describe('argument rendering', () => {
  it('flags a truncated argument rather than cutting it silently', () => {
    const long = 'x'.repeat(1000);
    const x = explainApproval({ toolName: 'srv__t', toolInput: { blob: long }, mcp: null });
    const arg = x.args.find((a) => a.key === 'blob');
    expect(arg?.truncated).toBe(true);
    expect(arg?.value.length).toBeLessThan(long.length);
    expect(arg?.value.endsWith('…')).toBe(true);
  });
});

describe('renderExplanationText — the channel card', () => {
  it('carries provenance, endpoint and the server-supplied text, attributed', () => {
    const text = renderExplanationText(
      explainApproval({
        toolName: 'mcp_fetch__fetch_markdown',
        toolInput: { url: 'https://example.test/a.md' },
        mcp: {
          slug: 'mcp-fetch',
          name: 'Fetch',
          endpoint: 'npx',
          toolDescription: 'Fetch a URL.',
        },
      }),
    );
    expect(text).toContain('Serveur MCP');
    expect(text).toContain('Fetch');
    expect(text).toContain('npx');
    // The third party's text must be labelled as theirs — it is untrusted
    // content reaching a human who is about to authorise something.
    expect(text).toContain('texte tiers, non vérifié');
    expect(text).toContain('https://example.test/a.md');
  });
});

// ─── Stated purpose ──────────────────────────────────────────────────────────
//
// Both the Telegram card and the dashboard used to pull `toolInput.purpose`
// themselves — the same rule written twice, free to drift. It now lives here.

describe('purpose', () => {
  it('carries the agent’s reason verbatim', () => {
    const x = explainApproval({
      toolName: 'run_command',
      toolInput: { command: 'ls', purpose: 'Lister le dossier avant la copie' },
    });
    expect(x.purpose).toBe('Lister le dossier avant la copie');
  });

  it('is null when absent, blank, or not a string — never a synthesised sentence', () => {
    // Invariant #2: the platform does not speak for the agent. A caller that
    // gets null says so; it must not receive something plausible-looking.
    for (const toolInput of [
      { command: 'ls' },
      { command: 'ls', purpose: '   ' },
      { command: 'ls', purpose: 42 },
    ]) {
      expect(explainApproval({ toolName: 'run_command', toolInput }).purpose).toBeNull();
    }
  });

  it('is NOT repeated in args — it was printed twice on every run_command card', () => {
    const x = explainApproval({
      toolName: 'run_command',
      toolInput: { command: 'ls', purpose: 'Lister le dossier' },
    });
    expect(x.args.map((a) => a.key)).toEqual(['command']);
  });

  it('reaches the MCP branch too — that is the one that had none', () => {
    const x = explainApproval({
      toolName: 'mcp_fetch__fetch_markdown',
      toolInput: { url: 'https://example.com/a.md', purpose: 'Lire le CHANGELOG' },
      mcp: { slug: 'mcp-fetch', name: 'Fetch', endpoint: 'npx' },
    });
    expect(x.purpose).toBe('Lire le CHANGELOG');
    expect(x.args.map((a) => a.key)).toEqual(['url']);
  });

  it('renders the reason on text surfaces without leaking it into the arg list', () => {
    const x = explainApproval({
      toolName: 'mcp_fetch__fetch_markdown',
      toolInput: { url: 'https://example.com/a.md', purpose: 'Lire le CHANGELOG' },
      mcp: { slug: 'mcp-fetch', name: 'Fetch', endpoint: 'npx' },
    });
    const text = renderExplanationText(x);
    expect(text).not.toContain('purpose =');
    expect(text).not.toContain('purpose:');
  });
});

// ─── PRIVILEGE-003 : la troncature doit se chiffrer ──────────────────────────

describe('troncature des arguments', () => {
  it('annonce la longueur RÉELLE, pas seulement « tronqué »', () => {
    const long = 'a'.repeat(1234);
    const x = explainApproval({ toolName: 'run_command', toolInput: { command: long } });
    const arg = x.args.find((a) => a.key === 'command')!;

    expect(arg.truncated).toBe(true);
    expect(arg.fullLength).toBe(1234);
    // Le reviewer doit savoir qu'il lit un quart de ce qui va s'exécuter.
    expect(renderExplanationText(x)).toContain('1234 caractères');
  });

  it('ne prétend pas tronquer ce qui tient', () => {
    const x = explainApproval({ toolName: 'run_command', toolInput: { command: 'ls -la' } });
    const arg = x.args.find((a) => a.key === 'command')!;
    expect(arg.truncated).toBe(false);
    expect(arg.fullLength).toBe(6);
    expect(renderExplanationText(x)).not.toContain('caractères,');
  });
});
