// lib/runner-auth-context.ts — Hono ContextVariableMap augmentation for the
// per-request caller-trust context.
//
// requireRunnerAuth (server.ts) sets these on every request that reaches
// /api/chat, /api/agent, /api/approve, /api/cron; the entity-scoped routes
// (chat.ts, agent.ts, approve.ts) read them to decide whether the body's ids
// can be trusted as-is or must be checked against the caller's own entity.
//
// callerTrusted=true: local-trust pass-through, or a valid WORKER_SECRET
//   bearer — the web has already scoped the entity from the user's session
//   before calling the runner, so the body is trusted.
// callerTrusted=false: a bare session bearer-token caller (external API
//   client, bearer-token mode) — the entity in the request MUST be verified
//   against callerEntityId (the session's own entity).
declare module 'hono' {
  interface ContextVariableMap {
    callerTrusted: boolean;
    callerEntityId: string | undefined;
  }
}

export {};
