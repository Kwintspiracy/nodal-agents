// builtin/child-env.ts — the scrubbed environment of every child process.
//
// The list lives in `@nodal-agents/shared/child-env` since Nodal's own git
// needs it too (`@nodal-agents/shared/internal-git`), and `packages/checkpoints`
// and `apps/web` do not depend on this package: ONE allowlist for the
// processes agents start and for the git Nodal starts for itself, never two.
export { buildChildEnv, safeEnvAllowlistSnapshot } from '@nodal-agents/shared/child-env';
