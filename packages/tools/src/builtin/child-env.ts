// builtin/child-env.ts — build a scrubbed environment for spawned child
// processes (run_command, run_skill_script).
//
// WHY: both builtins used to spawn with `env: process.env`, which hands the
// child EVERY variable the runner process holds — DATABASE_URL, WORKER_SECRET,
// every LLM provider key, etc. A perfectly ordinary approved command
// (`env`, `printenv`, `node -e process.env`) would exfiltrate all of it. Fix:
// build a minimal, ALLOWLISTED env — only the OS/shell plumbing a command or
// script actually needs to resolve and run normally — instead of inheriting
// the whole parent env.
//
// VERSIONNÉE : ENV_ALLOWLIST_VERSION (@nodal-agents/shared) entre dans le hash
// du manifeste d'une commande de preuve (plan « Vérifier & Corriger », D1).
// Élargir cette liste expose davantage au code du dépôt — c'est une nouvelle
// version, donc une nouvelle approbation. Un test-snapshot (child-env.test.ts)
// épingle l'empreinte de la liste par version : la modifier sans bumper
// rougit.

/**
 * Variable names safe to hand to a child process: OS/shell plumbing only,
 * never credentials. Matched case-insensitively — Windows env names are
 * case-insensitive, and POSIX names are conventionally upper-case anyway.
 */
const SAFE_ENV_ALLOWLIST = new Set(
  [
    // POSIX / cross-platform
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'SHELL',
    'USER',
    'LOGNAME',
    'TERM',
    // Windows
    'SYSTEMROOT',
    'WINDIR',
    'PATHEXT',
    'COMSPEC',
    'HOMEDRIVE',
    'HOMEPATH',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'PUBLIC',
    'PROGRAMDATA',
    'PROGRAMFILES',
    'PROGRAMFILES(X86)',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
    'COMPUTERNAME',
    'USERNAME',
    'USERDOMAIN',
    // Interpreter/toolchain path plumbing — NOT secrets (paths, not credentials),
    // but load-bearing for skill scripts that run inside a venv or link against
    // native libs (e.g. a ComfyUI Python skill). Without these a script that ran
    // fine as a human-launched process can silently fail to import/link once
    // spawned from a scrubbed env.
    'PYTHONPATH',
    'PYTHONHOME',
    'VIRTUAL_ENV',
    'LD_LIBRARY_PATH',
    'PKG_CONFIG_PATH',
    'NODE_PATH',
  ].map((k) => k.toUpperCase()),
);

/** LC_* (locale) is a whole family of variables — allow the prefix, not just LC_ALL. */
const SAFE_ENV_PREFIXES = ['LC_'];

/**
 * La liste EXACTE, triée, de ce que l'allowlist laisse passer (noms + préfixes)
 * — pour le test-snapshot qui l'épingle à ENV_ALLOWLIST_VERSION. Lecture seule.
 */
export function safeEnvAllowlistSnapshot(): readonly string[] {
  return [...[...SAFE_ENV_ALLOWLIST].sort(), ...SAFE_ENV_PREFIXES.map((p) => `${p}*`).sort()];
}

/**
 * Belt-and-braces denylist ON TOP of the allowlist above: any variable whose
 * NAME looks secret-shaped is dropped even if it somehow matched the allowlist
 * (defense in depth — e.g. a careless future edit widening the allowlist).
 * None of the allowlisted names above match this on purpose.
 */
const SECRET_NAME_PATTERN = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|DATABASE_URL|AUTH)/i;

/**
 * Build a scrubbed env object for a spawned child: system/shell plumbing only
 * (PATH, HOME/USERPROFILE, TMPDIR/TEMP, locale, Windows shell essentials…),
 * never a runner secret. Pure function — no I/O — so it's directly
 * unit-testable without spawning anything.
 *
 * Typed as `Record<string, string | undefined>` rather than `NodeJS.ProcessEnv`
 * on purpose: some workspace packages (Next.js apps) globally augment
 * `NodeJS.ProcessEnv` with required fields (e.g. `NODE_ENV`), which would make
 * an empty accumulator object fail to typecheck here even though this module
 * has nothing to do with Next. `child_process.spawn`'s `env` option accepts
 * this shape directly.
 */
export function buildChildEnv(
  sourceEnv: Record<string, string | undefined>,
  extras?: Record<string, string>,
  opts?: {
    /**
     * EXACT extra names allowed through DESPITE matching SECRET_NAME_PATTERN.
     * The one legitimate use is deliberately handing a child a credential the
     * runner owns — e.g. ANTHROPIC_API_KEY for a coding CLI's BYO-API-key mode
     * (D0 of the subscription-runtimes plan). Named exemptions only — never a
     * pattern, never a widening of the allowlist.
     */
    allowSecretExtras?: string[];
  },
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    const allowed =
      SAFE_ENV_ALLOWLIST.has(upper) || SAFE_ENV_PREFIXES.some((prefix) => upper.startsWith(prefix));
    if (!allowed) continue;
    if (SECRET_NAME_PATTERN.test(key)) continue; // should never trigger — see comment above
    result[key] = value;
  }
  // Runner-authored additions (e.g. NODAL_SHARED_WORKSPACE — the shared
  // workspace path handed to scripts so generation artifacts land there, not
  // in the skill bundle). These are paths/config the caller chooses to expose,
  // so they bypass the allowlist — but a secret-shaped NAME must be either
  // EXPLICITLY exempted (allowSecretExtras) or a loud error. It used to be
  // silently dropped, which turned "inject ANTHROPIC_API_KEY for API-billing
  // mode" into "silently bill the subscription instead" — a textbook
  // invariant-#4 violation (audit A-bis, 2026-08-19).
  const exempt = new Set(opts?.allowSecretExtras ?? []);
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (SECRET_NAME_PATTERN.test(key) && !exempt.has(key)) {
      throw new Error(
        `buildChildEnv: extra "${key}" matches SECRET_NAME_PATTERN and is not in ` +
          `allowSecretExtras — refusing to silently drop it. Either rename the variable ` +
          `or exempt it BY NAME on purpose.`,
      );
    }
    result[key] = value;
  }
  return result;
}
