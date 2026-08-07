// approval-explain.ts — a structured, human-readable explanation of ONE gated
// tool call, so a reviewer can decide without reading the code.
//
// WHY this exists
// ---------------
// `computeApprovalImpactLine` produces one sentence, and its `default:` branch
// says "<tool>: irreversible or destructive action." for every tool it does not
// recognise. That branch swallows EVERY MCP tool — so a call that merely reads a
// CHANGELOG off GitHub was presented to the owner as an irreversible destructive
// action, with a tool name (`mcp_fetch__fetch_markdown`) and nothing else.
// Reported live: "je ne comprends pas ce que j'approuve".
//
// An approval the reviewer cannot read is not a control. It trains them to click
// the green button, which is worse than no gate at all because it looks like
// oversight. So the card has to answer four questions, in this order:
//
//   QUI    — which agent, and through which third party
//   QUOI   — in plain language, not a symbol
//   EFFET  — reads / writes / has an outside effect, and where
//   DÉTAIL — the real arguments, verbatim
//
// The output is structured rather than a string so each surface (dashboard card,
// Telegram/Discord/Slack message) renders it its own way without the wording
// drifting between them.

import { computeApprovalImpactLine } from './approval-impact';

/** How consequential the call is, as far as the PLATFORM can tell. */
export type ApprovalEffect =
  /** Reads or inspects; no state changes anywhere. */
  | 'read'
  /** Changes state locally (files, DB rows, config). */
  | 'write'
  /** Reaches a third party — a network call leaving this machine. */
  | 'external'
  /** Destroys or is irreversible. */
  | 'destructive'
  /** The platform genuinely cannot tell — say so rather than guess. */
  | 'unknown';

export interface ApprovalExplanation {
  /** One line, plain language, no tool symbol. The headline of the card. */
  what: string;
  effect: ApprovalEffect;
  /** Short label for the effect, for a badge. */
  effectLabel: string;
  /**
   * Where the action lands: a file path, a URL, a host. Null when it stays
   * inside this install.
   */
  target: string | null;
  /**
   * Origin of the tool when it is NOT built into the product — the third party
   * that supplied it. This is the single most load-bearing field on the card:
   * "an agent wants to call a tool from a server you added on 18 June" is a
   * different decision from "an agent wants to write a file".
   */
  provenance: {
    kind: 'builtin' | 'mcp' | 'connector';
    /** Server/connector slug, e.g. `mcp-fetch`. */
    slug?: string;
    /** Human name the user gave it, e.g. "Fetch". */
    name?: string;
    /** Where that third party lives — URL for http, command for stdio. */
    endpoint?: string;
    /** Description the third party supplies. UNTRUSTED — it is their text. */
    supplied?: string;
  };
  /** The real arguments, flattened for display. Never truncated silently. */
  args: Array<{ key: string; value: string; truncated: boolean }>;
  /**
   * The deterministic impact sentence, kept for tools the product ships. Null
   * for third-party tools, where the product has no basis to claim anything.
   */
  impact: string | null;
}

const ARG_MAX = 300;

/** MCP tool names are `<slugPrefix>__<tool>` — nothing else in the product uses `__`. */
export function parseMcpToolName(toolName: string): { prefix: string; tool: string } | null {
  const i = toolName.indexOf('__');
  if (i <= 0) return null;
  return { prefix: toolName.slice(0, i), tool: toolName.slice(i + 2) };
}

const EFFECT_LABEL: Record<ApprovalEffect, string> = {
  read: 'Lecture',
  write: 'Écriture',
  external: 'Appel externe',
  destructive: 'Destructif',
  unknown: 'Effet inconnu',
};

/** Turn a snake_case / camelCase tool name into something readable. */
function humanise(name: string): string {
  return name
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .toLowerCase();
}

function flattenArgs(input: unknown): ApprovalExplanation['args'] {
  if (!input || typeof input !== 'object') return [];
  return Object.entries(input as Record<string, unknown>).map(([key, raw]) => {
    const full = typeof raw === 'string' ? raw : JSON.stringify(raw);
    const value = full ?? String(raw);
    const truncated = value.length > ARG_MAX;
    return { key, value: truncated ? `${value.slice(0, ARG_MAX)}…` : value, truncated };
  });
}

/** First URL-looking argument, so the card can name the destination. */
function firstUrl(args: ApprovalExplanation['args']): string | null {
  for (const a of args) {
    const m = a.value.match(/https?:\/\/[^\s"']+/);
    if (m) return m[0];
  }
  return null;
}

/** Context the caller looks up (the DB knows the server; this module does not). */
export interface McpServerContext {
  slug: string;
  name: string;
  /** URL for http transport, command for stdio. */
  endpoint: string;
  /** Description this server supplies for the tool. Third-party text. */
  toolDescription?: string;
  /**
   * Whether the server declared the tool read-only. A HINT from the third
   * party, never a security decision — it only softens the WORDING, and the
   * approval is required either way.
   */
  readOnlyHint?: boolean;
}

export interface ExplainOptions {
  toolName: string;
  toolInput: unknown;
  /** Resolved by the caller from `mcp_servers` when the tool name carries `__`. */
  mcp?: McpServerContext | null;
}

/**
 * Explain one gated call.
 *
 * Deliberately conservative about third-party tools: the product does not know
 * what `cogni_cortex__get_home` does, so it says the tool's name in plain words,
 * names the server it comes from, and shows the arguments — rather than
 * inventing a verdict. Claiming "irreversible or destructive action" about a
 * tool nobody has inspected is exactly the failure this replaces.
 */
export function explainApproval(opts: ExplainOptions): ApprovalExplanation {
  const args = flattenArgs(opts.toolInput);
  const mcpName = parseMcpToolName(opts.toolName);

  if (mcpName && opts.mcp) {
    const url = firstUrl(args);
    // An MCP call always leaves this process — stdio spawns a subprocess, http
    // crosses the network. `external` is the honest floor whatever the tool does.
    const effect: ApprovalEffect = opts.mcp.readOnlyHint ? 'read' : 'external';
    return {
      what: `« ${humanise(mcpName.tool)} » via ${opts.mcp.name}`,
      effect,
      effectLabel: opts.mcp.readOnlyHint
        ? 'Lecture (déclarée par le serveur)'
        : EFFECT_LABEL.external,
      target: url ?? opts.mcp.endpoint,
      provenance: {
        kind: 'mcp',
        slug: opts.mcp.slug,
        name: opts.mcp.name,
        endpoint: opts.mcp.endpoint,
        ...(opts.mcp.toolDescription ? { supplied: opts.mcp.toolDescription } : {}),
      },
      args,
      // No impact sentence: the product did not write this tool and has no
      // basis to characterise it. The server's own description is carried in
      // `provenance.supplied`, clearly attributed.
      impact: null,
    };
  }

  if (mcpName) {
    // Namespaced tool whose server could not be resolved — say that, do not
    // fall back to a scary generic line.
    return {
      what: `« ${humanise(mcpName.tool)} » via un serveur MCP non identifié (${mcpName.prefix})`,
      effect: 'unknown',
      effectLabel: EFFECT_LABEL.unknown,
      target: firstUrl(args),
      provenance: { kind: 'mcp', slug: mcpName.prefix },
      args,
      impact: null,
    };
  }

  // Built-in tool: the deterministic impact line is authoritative here.
  const impact = computeApprovalImpactLine(opts.toolName, opts.toolInput);
  const input = (opts.toolInput ?? {}) as Record<string, unknown>;
  let effect: ApprovalEffect = 'write';
  let target: string | null = null;

  switch (opts.toolName) {
    case 'file_write':
    case 'file_edit':
      effect = 'write';
      target = typeof input['path'] === 'string' ? input['path'] : null;
      break;
    case 'run_command':
    case 'run_skill_script':
      effect = 'destructive';
      break;
    case 'skill_file_write':
      effect = 'write';
      break;
    default:
      effect = 'write';
  }

  return {
    what: humanise(opts.toolName),
    effect,
    effectLabel: EFFECT_LABEL[effect],
    target,
    provenance: { kind: 'builtin' },
    args,
    impact,
  };
}

/**
 * Flat text rendering, for surfaces without layout (channel messages).
 * The dashboard renders the structure itself.
 */
export function renderExplanationText(x: ApprovalExplanation): string {
  const lines: string[] = [];
  lines.push(`➤ ${x.what}`);
  lines.push(`⚠️ ${x.effectLabel}${x.target ? ` → ${x.target}` : ''}`);
  if (x.provenance.kind === 'mcp') {
    lines.push(
      `🔌 Serveur MCP « ${x.provenance.name ?? x.provenance.slug} »` +
        (x.provenance.endpoint ? ` (${x.provenance.endpoint})` : ''),
    );
    if (x.provenance.supplied) {
      lines.push(`   Description fournie par ce serveur (texte tiers, non vérifié) :`);
      lines.push(`   « ${x.provenance.supplied.slice(0, 200)} »`);
    }
  }
  if (x.impact) lines.push(`   ${x.impact}`);
  if (x.args.length > 0) {
    lines.push('', 'Arguments :');
    for (const a of x.args) {
      lines.push(`  ${a.key} = ${a.value}${a.truncated ? ' (tronqué)' : ''}`);
    }
  }
  return lines.join('\n');
}
