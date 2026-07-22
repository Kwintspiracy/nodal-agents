// Shared Graph client mock builder for adapter-outlook-mail tool tests.
// The real @microsoft/microsoft-graph-client GraphRequest is a fluent builder
// (select/top/filter/search/expand all return `this`) terminating in
// get/post/patch/delete. This mock reproduces that shape so tool code under
// test can call the SDK's real method chain unmodified.
//
// Not a *.test.ts file — vitest does not collect it, and architecture.test.ts
// excludes the whole `tests/` directory from its source-file scan.

import { vi } from 'vitest';
import type { Client } from '@microsoft/microsoft-graph-client';

export interface MockGraphRequest {
  select: ReturnType<typeof vi.fn>;
  top: ReturnType<typeof vi.fn>;
  filter: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
  expand: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

export function makeMockRequest(): MockGraphRequest {
  const req = {} as MockGraphRequest;
  req.select = vi.fn().mockReturnValue(req);
  req.top = vi.fn().mockReturnValue(req);
  req.filter = vi.fn().mockReturnValue(req);
  req.search = vi.fn().mockReturnValue(req);
  req.expand = vi.fn().mockReturnValue(req);
  req.get = vi.fn();
  req.post = vi.fn();
  req.patch = vi.fn();
  req.delete = vi.fn();
  return req;
}

/**
 * Builds a mock Client whose `.api(path)` is routed by the test via
 * `routes: Record<pathOrPrefix, MockGraphRequest>` — matched by exact path
 * first, then by the longest startsWith prefix (for dynamic
 * /me/messages/{id}/... paths). Any unmatched path gets a fresh throwaway
 * request whose terminal methods resolve to `undefined` if awaited —
 * surfacing as a loud assertion failure rather than a silently-passing test.
 */
export function makeMockClient(routes: Record<string, MockGraphRequest> = {}): {
  client: Client;
  api: ReturnType<typeof vi.fn>;
} {
  const api = vi.fn((path: string) => {
    if (routes[path]) return routes[path];
    const prefixMatches = Object.keys(routes)
      .filter((k) => path.startsWith(k))
      .sort((a, b) => b.length - a.length);
    if (prefixMatches.length > 0) return routes[prefixMatches[0]!]!;
    return makeMockRequest();
  });
  return { client: { api } as unknown as Client, api };
}
