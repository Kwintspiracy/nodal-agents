/// <reference types="vitest/globals" />

// Vitest setup — mock Next.js server-only so tests can import server modules
// without throwing "Client Component" errors. In the real app, server-only
// prevents accidental client-side imports; in Vitest (Node, no RSC runtime)
// we just no-op it.
vi.mock('server-only', () => ({}));
