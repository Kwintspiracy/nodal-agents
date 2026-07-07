// @nodal-agents/adapter-gmail — bounded-concurrency helper
//
// audit#2026-07-07 F3: gmail_list_messages/gmail_list_drafts fan out a GET per
// stub via Promise.all — with max_results up to 500, that is 500 concurrent
// Gmail API calls fired from one tool execution (rate-limit trigger + memory
// spike). No `p-limit` dependency is available here (CLAUDE.md invariant #7 —
// don't hand-roll what an official SDK provides, but don't pull in a new
// dependency for a 15-line utility either), so this runs the work in waves of
// `limit` items, each wave fully in-flight before the next starts.

/**
 * Map over `items` with at most `limit` calls to `fn` in flight at once.
 * Processes items in fixed-size chunks (waves), not a rolling window — simple
 * and sufficient for the bounded per-page sizes this adapter deals with.
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  for (let start = 0; start < items.length; start += limit) {
    const chunk = items.slice(start, start + limit);
    const chunkResults = await Promise.all(chunk.map((item, i) => fn(item, start + i)));
    for (let i = 0; i < chunkResults.length; i++) {
      results[start + i] = chunkResults[i]!;
    }
  }
  return results;
}
