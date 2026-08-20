// @nodal-agents/adapter-cloudflare — cloudflare_deploy.
//
// Publishes a BUILT static site/app directory from the agent workspace to
// Cloudflare Workers (assets-only Worker) so the user can preview it online
// seconds after the agent finished coding. Mechanics:
//   - the directory is resolved through the SAME workspace confinement as the
//     file_* tools (resolveAndCheckPath — symlink-escape safe);
//   - the upload itself is delegated to `wrangler` (Cloudflare's official
//     CLI, spawned via npx with a pinned major) — reimplementing the assets
//     upload protocol (manifest, hashes, upload sessions) by hand would be
//     drift-prone for zero benefit (invariant #7: official tooling);
//   - the API token travels ONLY via a NAMED env exemption
//     (buildChildEnv allowSecretExtras) — never argv, never inherited env;
//   - the preview URL is DERIVED from the account's workers.dev subdomain
//     (resolved through the official SDK), never scraped from CLI output.

import { stat, readdir } from 'node:fs/promises';
import { z } from 'zod';
import type { ToolDefinition } from '@nodal-agents/tools';
import { resolveAndCheckPath, resolveCliPath, runCli, buildChildEnv } from '@nodal-agents/tools';
import { CloudflareApiError } from '../errors.ts';
import type { CloudflareAccountContext } from '../client.ts';

/** Cloudflare Worker names: lowercase alphanumerics and dashes, 1–54 chars,
 *  no leading/trailing dash (the API's own constraint). Also our anti-injection
 *  guarantee: a name matching this can never carry shell metacharacters. */
export const WORKER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/;

/** Pinned wrangler MAJOR — npx resolves the latest 4.x at first use and caches
 *  it. A major bump is a deliberate edit here, never silent drift. */
export const WRANGLER_SPEC = 'wrangler@4';

/**
 * Pinned Workers compatibility date, passed as a flag on EVERY deploy —
 * wrangler REFUSES an upload without one (proven live on the first user run,
 * 2026-08-20: the agent had to hand-write a wrangler config to work around
 * it). Passing it here means no wrangler.toml/jsonc is ever needed in the
 * deployed directory. Mostly inert for assets-only Workers; bumping it is a
 * deliberate edit, never silent drift.
 */
export const COMPATIBILITY_DATE = '2026-08-15';

const DEPLOY_TIMEOUT_MS = 300_000; // first run downloads wrangler via npx

const DeployInput = z.object({
  name: z
    .string()
    .regex(
      WORKER_NAME_RE,
      'Worker name must be 1-54 chars of lowercase letters, digits and dashes (no leading/trailing dash).',
    )
    .describe(
      'The Worker name — becomes the public URL https://<name>.<account>.workers.dev. ' +
        'Redeploying the same name updates the same URL.',
    ),
  directory: z
    .string()
    .min(1)
    .describe(
      'Workspace path of the BUILT static output to publish (e.g. "dist" or "myapp/build") — ' +
        'NOT the source directory. Build first (run_command / code_task), then deploy the output.',
    ),
});

export type DeployOutput = {
  name: string;
  /** The live preview URL — share it with the user. */
  url: string;
  accountId: string;
  /** wrangler's own deploy summary (first lines) — upload counts, version id. */
  summary: string;
};

/**
 * Build the wrangler argv tail — pure, unit-tested. `name` is regex-validated
 * upstream and `assetsDir` is a workspace-confined absolute path; neither can
 * carry cmd.exe metacharacters onto the npx .cmd shim path (which
 * buildSpawnArgv additionally validates, fail loud).
 */
export function buildWranglerDeployArgs(name: string, assetsDir: string): string[] {
  return [
    '--yes',
    WRANGLER_SPEC,
    'deploy',
    '--name',
    name,
    '--assets',
    assetsDir,
    '--compatibility-date',
    COMPATIBILITY_DATE,
  ];
}

export function makeCloudflareDeployTool(
  account: CloudflareAccountContext,
): ToolDefinition<typeof DeployInput, DeployOutput> {
  return {
    name: 'cloudflare_deploy',
    description:
      'Publish a BUILT static site/app directory from the workspace to Cloudflare Workers. ' +
      'The site is live at https://<name>.<account>.workers.dev within seconds — include that ' +
      'URL in your answer so the user can preview immediately. Build the project first ' +
      '(the directory must contain the final index.html/assets, not sources). Redeploying ' +
      'the same name updates the same URL. First run may take ~1 min (wrangler download).',
    inputSchema: DeployInput,
    riskLevel: 'write',
    // Publishing to the public internet is outward-facing — safe-by-default,
    // same posture as run_command/code_task; a per-agent auto_approve rule
    // (Yolo) or per-operation rule overrides.
    defaultApproval: 'require_approval',
    async execute(input, ctx) {
      const assetsDir = await resolveAndCheckPath(ctx, input.directory);

      // Fail loud on an empty/missing directory — deploying nothing is always
      // a mistake (usually: the build step was skipped).
      const dirStat = await stat(assetsDir).catch(() => null);
      if (!dirStat?.isDirectory()) {
        throw new CloudflareApiError(
          'cloudflare_validation_error',
          `cloudflare_deploy: "${input.directory}" is not a directory in the workspace. ` +
            'Build the project first, then deploy its output directory.',
        );
      }
      const entries = await readdir(assetsDir);
      if (entries.length === 0) {
        throw new CloudflareApiError(
          'cloudflare_validation_error',
          `cloudflare_deploy: "${input.directory}" is empty — nothing to publish. ` +
            'Build the project first (run_command / code_task), then deploy its output.',
        );
      }

      // Account + workers.dev subdomain resolved BEFORE spawning — a missing
      // subdomain fails loud with the exact fix instead of a wrangler stderr.
      const { accountId, subdomain } = await account.resolve();

      const npx = resolveCliPath('npx');
      if (!npx) {
        throw new CloudflareApiError(
          'cloudflare_deploy_failed',
          'cloudflare_deploy: "npx" was not found on the runner machine PATH — a Node.js ' +
            'installation with npm is required to run wrangler.',
        );
      }

      const run = await runCli(npx, buildWranglerDeployArgs(input.name, assetsDir), {
        cwd: assetsDir,
        timeoutMs: DEPLOY_TIMEOUT_MS,
        env: buildChildEnv(
          process.env,
          {
            CLOUDFLARE_API_TOKEN: account.apiToken,
            CLOUDFLARE_ACCOUNT_ID: accountId,
            // wrangler telemetry off + non-interactive: a headless deploy must
            // never wait on a prompt.
            WRANGLER_SEND_METRICS: 'false',
            CI: 'true',
          },
          { allowSecretExtras: ['CLOUDFLARE_API_TOKEN'] },
        ),
      });

      if (run.timedOut) {
        throw new CloudflareApiError(
          'cloudflare_deploy_failed',
          `cloudflare_deploy: wrangler exceeded ${String(DEPLOY_TIMEOUT_MS / 1000)}s and was killed. ` +
            `Partial output: ${run.stdout.slice(-400)}`,
        );
      }
      if (run.exitCode !== 0) {
        throw new CloudflareApiError(
          'cloudflare_deploy_failed',
          `cloudflare_deploy: wrangler exited ${String(run.exitCode)}. ` +
            `stderr: ${run.stderr.slice(0, 600)} stdout: ${run.stdout.slice(-300)}`,
        );
      }

      return {
        name: input.name,
        url: `https://${input.name}.${subdomain}.workers.dev`,
        accountId,
        summary: run.stdout.trim().split('\n').slice(0, 6).join('\n').slice(0, 600),
      };
    },
  };
}
