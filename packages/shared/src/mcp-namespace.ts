/**
 * Which MCP server a tool name designates — and the two rules that make the
 * answer unique inside a job (#661).
 *
 * A server lends its tools under `<mcpToolPrefix(slug)>__<tool>`. Two things
 * used to break the link between a name and ONE server:
 *   - the prefix folded different slugs together (`guide-srv` / `guide--srv`
 *     both give `guide_srv`) or let one namespace extend another (`a-` gives
 *     `a_`, so its `a___ping` also starts with `a__`, the namespace of `a`);
 *   - several instances of one catalog server (same slug, by design since
 *     migration 0017) could be attached to the same agent.
 * The job then routed the call to whichever server came last, the approval
 * card named another, and the prompt carried guidance of a server the agent
 * did not hold.
 *
 * The rules: a slug is written in the canonical grammar below (every creation
 * path), and an agent never holds two servers whose namespaces overlap (every
 * attach path, and the runner for rows that predate the rule).
 */
import { mcpToolPrefix } from './mcp-tool-prefix';

/**
 * Lowercase letters and digits, words joined by single hyphens. With it,
 * `mcpToolPrefix` is a bijection, and a prefix never contains `__` nor ends in
 * `_`: the namespace of one canonical slug never overlaps another's.
 */
export const MCP_SERVER_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The same grammar for an HTML `pattern` attribute (anchored by the browser). */
export const MCP_SERVER_SLUG_HTML_PATTERN = '[a-z0-9]+(-[a-z0-9]+)*';

/** What the grammar is, said to whoever typed a slug it refuses. */
export const MCP_SERVER_SLUG_RULE =
  'Slug must be lowercase letters and digits, words joined by single hyphens (no leading, trailing or doubled hyphen).';

/** The `<prefix>__` every tool of the server named `slug` starts with. */
export function mcpToolNamespace(slug: string): string {
  return `${mcpToolPrefix(slug)}__`;
}

/** Does `toolName` belong to the server named `slug`? */
export function isToolOfMcpServer(slug: string, toolName: string): boolean {
  return toolName.startsWith(mcpToolNamespace(slug));
}

/**
 * Could one tool name belong to both servers? True when their namespaces are
 * equal or one extends the other — the only ways a name starts with both.
 */
export function mcpToolNamespacesOverlap(slugA: string, slugB: string): boolean {
  const a = mcpToolNamespace(slugA);
  const b = mcpToolNamespace(slugB);
  return a.startsWith(b) || b.startsWith(a);
}

/** The first pair of servers in `servers` whose namespaces overlap, or null. */
export function findMcpNamespaceOverlap<T extends { slug: string }>(
  servers: readonly T[],
): [T, T] | null {
  for (let i = 0; i < servers.length; i++) {
    for (let j = i + 1; j < servers.length; j++) {
      if (mcpToolNamespacesOverlap(servers[i]!.slug, servers[j]!.slug)) {
        return [servers[i]!, servers[j]!];
      }
    }
  }
  return null;
}

/** The refusal, the same words on every surface: both servers, and the way out. */
export function mcpNamespaceOverlapMessage(
  a: { slug: string; name: string },
  b: { slug: string; name: string },
): string {
  return (
    `The MCP servers "${a.name}" (${a.slug}) and "${b.name}" (${b.slug}) would lend ` +
    `tools under the same names (${mcpToolNamespace(a.slug)}…), so a call could not ` +
    `tell them apart. An agent holds only one of them: detach one, or give the other ` +
    `to a different agent.`
  );
}
