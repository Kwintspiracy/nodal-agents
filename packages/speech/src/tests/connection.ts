import type { SpeechConnection } from '../speech-adapter.ts';

/**
 * A connection whose `fetch` is the global one, read AT CALL TIME, so a test's
 * `vi.stubGlobal('fetch', …)` or `globalThis.fetch = …` still catches the
 * request. The adapters never touch the global `fetch` themselves: that
 * `connection.fetch` is what they call is proven in `connection.test.ts`.
 */
export function conn(apiKey = 'k'): SpeechConnection {
  return { apiKey, fetch: (input, init) => globalThis.fetch(input, init) };
}
