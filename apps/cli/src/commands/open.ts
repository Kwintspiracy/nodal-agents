// open.ts — `nodal-agents open`: open this install's dashboard in a browser.
//
// In the mode with no password, the dashboard lets a browser in only through
// a launch link made from the install's secret, which only this account can
// read (lib/dashboard-link.ts). `up` opens one when the stack is ready; this
// command makes another, for a browser that has not been let in yet: another
// profile, a link that expired, a bookmark opened before `up`. The page such a
// browser gets names this command.
//
//   nodal-agents open           opens the link, and prints it
//   nodal-agents open --print   prints it only (a browser on another session)
//
// The link is printed to this terminal only: never written to a log.

import chalk from 'chalk';
import open from 'open';
import { CONFIG_FILE, readConfig } from '../lib/config.ts';
import { LAUNCH_TTL_MINUTES, dashboardBaseUrl, dashboardEntry } from '../lib/dashboard-link.ts';
import { installProof } from '../lib/install-proof.ts';

export interface OpenOptions {
  print?: boolean;
}

/** Does this install's dashboard answer? Asked with the install's proof. */
async function dashboardAnswers(baseUrl: string, workerSecret: string): Promise<boolean> {
  try {
    const res = await fetch(new URL('/api/health', baseUrl), {
      headers: installProof(workerSecret),
      signal: AbortSignal.timeout(3_000),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

export async function runOpen(opts: OpenOptions = {}): Promise<number> {
  const config = readConfig();
  if (!config) {
    console.error(
      chalk.red(`No Nodal install found (${CONFIG_FILE} is missing). Run \`nodal-agents up\`.`),
    );
    return 1;
  }
  if (!(await dashboardAnswers(dashboardBaseUrl(config), config.workerSecret))) {
    console.error(
      chalk.red(
        `The dashboard does not answer at ${dashboardBaseUrl(config)}. Start Nodal with \`nodal-agents up\`.`,
      ),
    );
    return 1;
  }
  const entry = dashboardEntry(config);
  if (!opts.print && !process.env['NODALAI_NO_BROWSER']) {
    try {
      await open(entry.url);
    } catch {
      /* best-effort: the link is printed below */
    }
  }
  console.log('');
  console.log(chalk.bold('  Open the dashboard:'));
  console.log(`  ${entry.url}`);
  if (entry.oneTime) {
    console.log(
      chalk.gray(
        `  This link works once, within ${LAUNCH_TTL_MINUTES} minutes. The browser that opens it stays in.`,
      ),
    );
  }
  console.log('');
  return 0;
}
