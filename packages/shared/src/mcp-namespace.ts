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
 * The rules:
 *   - a slug is written in the canonical grammar below (every creation path);
 *   - a NEW attachment never gives an agent two servers whose namespaces
 *     overlap (every attach path) — strict, because what a server exposes
 *     moves on its own (it publishes a new tool, a whitelist widens);
 *   - a tool name is attributed to the server that EXPOSES it — namespace AND
 *     the server's own list — by every reader: the runner (what each server
 *     actually put in the job), the approval card (`attributeMcpTool`). A job is refused only when one name is
 *     exposed by two servers (`findMcpToolNameCollision`), which is the only
 *     case no reader can resolve. An attachment written before the rule whose
 *     namespaces overlap but whose exposed tools do not keeps working.
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

/**
 * The full tool names a server lends an agent, from what the database knows:
 * its discovered tools (`mcp_servers.available_tools`) narrowed by the agent's
 * whitelist (`agent_mcp_servers.enabled_tools`, null = all). Null when neither
 * is known — the server may lend anything in its namespace.
 */
export function mcpExposedToolNames(
  slug: string,
  availableTools: unknown,
  enabledTools: readonly string[] | null,
): string[] | null {
  const ns = mcpToolNamespace(slug);
  const discovered = Array.isArray(availableTools)
    ? availableTools
        .map((t) => (t && typeof t === 'object' ? (t as { name?: unknown }).name : undefined))
        .filter((n): n is string => typeof n === 'string')
    : null;
  const names =
    enabledTools === null
      ? discovered
      : discovered === null
        ? [...enabledTools]
        : discovered.filter((n) => enabledTools.includes(n));
  return names === null ? null : names.map((n) => ns + n);
}

/**
 * Which of an agent's servers lends `toolName`, and whether that is certain.
 *
 * In its namespace AND in its own list: `guide-srv` and a pre-#661
 * `guide--srv` share `guide_srv__`, and only the lists say which one lends
 * `guide_srv__ping`. A list read from the database can be stale or unknown
 * (`null`), so the answer is certain only when the server is alone in its
 * namespace, or when exactly one known list names the tool and no list beside
 * it is unknown. Otherwise one server is still named — a lender first — but
 * flagged `ambiguous`: never the wrong server without the flag.
 */
export function attributeMcpTool<T extends { slug: string; exposed: readonly string[] | null }>(
  servers: readonly T[],
  toolName: string,
): { server: T; ambiguous: boolean } | null {
  const inNamespace = servers.filter((s) => isToolOfMcpServer(s.slug, toolName));
  if (inNamespace.length === 0) return null;
  if (inNamespace.length === 1) return { server: inNamespace[0]!, ambiguous: false };
  const lenders = inNamespace.filter((s) => s.exposed !== null && s.exposed.includes(toolName));
  const unknown = inNamespace.filter((s) => s.exposed === null);
  if (lenders.length === 1 && unknown.length === 0) {
    return { server: lenders[0]!, ambiguous: false };
  }
  return { server: [...lenders, ...unknown, ...inNamespace][0]!, ambiguous: true };
}

/** The first tool name two of `servers` both lend, with the two servers; or null. */
export function findMcpToolNameCollision<T extends { slug: string; exposed: readonly string[] }>(
  servers: readonly T[],
): { toolName: string; servers: [T, T] } | null {
  const lentBy = new Map<string, T>();
  for (const server of servers) {
    for (const toolName of server.exposed) {
      const first = lentBy.get(toolName);
      if (first && first !== server) return { toolName, servers: [first, server] };
      lentBy.set(toolName, server);
    }
  }
  return null;
}

/** The refusal of a job whose agent is lent one tool name by two servers. */
export function mcpToolNameCollisionMessage(
  toolName: string,
  a: { slug: string; name: string },
  b: { slug: string; name: string },
): string {
  return (
    `The MCP servers "${a.name}" (${a.slug}) and "${b.name}" (${b.slug}) both lend this ` +
    `agent a tool named "${toolName}", so a call could not tell them apart. Untick it on ` +
    `one of them in the agent's Connectors tab, detach one, or give the other to a ` +
    `different agent.`
  );
}
