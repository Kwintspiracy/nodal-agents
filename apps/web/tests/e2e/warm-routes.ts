/**
 * Warm the dashboard's routes once, before any journey (#748).
 *
 * The e2e stack runs `next dev`, which compiles a route the FIRST time anything
 * asks for it. On a 2-vCPU CI runner one cold route costs seconds, and the
 * heavy ones more than a journey's wait: the smoke journey "create an agent,
 * send a task" failed its first try in every run of main, because it was the
 * first thing to open `/chat/runs/[id]` (web.log: "Compiling /chat/runs/[id]"
 * and no answer for the 15 s the journey waited; the retry, on a compiled
 * route, got it in 480 ms). Whichever journey reached an uncompiled route first
 * paid for it, and which one that was changed with every new journey.
 *
 * So the cost is paid ONCE, here, for every route the app has, not in one
 * journey's timeout and not for a hand-kept list of the routes someone
 * remembered. The list is READ from `src/app`: a page added tomorrow is warmed
 * tomorrow, with no edit here.
 *
 * Only pages (`page.tsx`) are asked. A route handler (`route.ts`) is an API a
 * GET may act on, and a warm-up must never do anything.
 */

import { readdirSync } from 'node:fs';
import path from 'node:path';
import { request } from '@playwright/test';

/** What stands in for a dynamic segment: compiling a route does not need a row. */
export const WARM_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The URL path of every page under `appDir` (Next's App Router layout).
 *
 * - `(group)` folders and `@slot` folders are not part of the URL;
 * - `[id]` becomes a placeholder id, `[...rest]` and `[[...rest]]` one segment;
 * - the answer is sorted and without duplicates, so two runs ask in one order.
 */
export function appRoutes(appDir: string): string[] {
  const found = new Set<string>();
  const walk = (dir: string, segments: string[]): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...segments, entry.name]);
      } else if (entry.name === 'page.tsx') {
        const url = segments
          .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'))
          .map((s) => (/^\[.+\]$/.test(s) ? (s.includes('...') ? 'warm' : WARM_ID) : s));
        found.add('/' + url.join('/'));
      }
    }
  };
  walk(appDir, []);
  return [...found].sort();
}

export interface WarmReport {
  routes: number;
  elapsedMs: number;
  slowest: { route: string; ms: number }[];
}

/**
 * Ask every route once, `concurrency` at a time (ONE by default), with the session of
 * `storageState`.
 *
 * One at a time on purpose: it is how the journeys compile routes, so the stack
 * meets no load shape it does not meet anyway. Four at once was measured on the
 * CI runner (#748): the runner itself was shut down in three runs of four.
 *
 * The STATUS of an answer is not judged: a placeholder id is a 404 by design,
 * and a page that redirects has still compiled. What is judged is the absence
 * of an answer: a route that does not answer within `timeoutMs` (or a refused
 * connection) means the stack is not the one the journeys will meet, and that
 * stops the run here with the route's name, rather than as thirty confusing
 * navigation timeouts (invariant #4).
 */
export async function warmRoutes(opts: {
  baseURL: string;
  appDir: string;
  storageState: string;
  concurrency?: number;
  timeoutMs?: number;
}): Promise<WarmReport> {
  const routes = appRoutes(opts.appDir);
  const concurrency = opts.concurrency ?? 1;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  const api = await request.newContext({
    baseURL: opts.baseURL,
    storageState: opts.storageState,
  });
  const started = Date.now();
  const took: { route: string; ms: number }[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const route = routes[next++];
      if (route === undefined) return;
      const t0 = Date.now();
      try {
        // `maxRedirects: 0`: the page that redirects is what compiles here;
        // following it would only warm what another entry of the list warms.
        const res = await api.get(route, { timeout: timeoutMs, maxRedirects: 0 });
        await res.body();
      } catch (err) {
        throw new Error(
          `Warm-up: ${route} gave no answer within ${timeoutMs} ms (${(err as Error).message}). ` +
            `The stack is up (/api/health answered) but cannot serve this page: check web.log.`,
        );
      }
      took.push({ route, ms: Date.now() - t0 });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, routes.length) }, worker));
  } finally {
    await api.dispose();
  }
  took.sort((a, b) => b.ms - a.ms);
  return { routes: routes.length, elapsedMs: Date.now() - started, slowest: took.slice(0, 3) };
}
