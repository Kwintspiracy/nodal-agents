// init.ts — interactive wizard to configure Nodal-Agents

import chalk from 'chalk';
import prompts from 'prompts';
import ora from 'ora';
import { randomBytes } from 'crypto';
import { writeConfig, readConfig, type Config } from '../lib/config.ts';
import { LLM_PRESETS, fetchModels, isEndpointReachable } from '../lib/llm-presets.ts';

function generateSecret(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/**
 * Run the interactive init wizard.
 * If a config already exists and force=false, asks whether to overwrite.
 *
 * `nonInteractive` writes a sensible default (lan bind, local-auth, no LLM
 * preset) and returns — used by headless / CI environments where there is
 * no TTY. The user finishes LLM config from the dashboard.
 */
export async function runInit(
  options: { force?: boolean; nonInteractive?: boolean } = {},
): Promise<Config> {
  const existing = readConfig();

  if (existing && !options.force) {
    if (options.nonInteractive) return existing;
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: chalk.yellow('A config already exists. Overwrite it?'),
      initial: false,
    });
    if (!overwrite) {
      console.log(chalk.gray('Init cancelled — keeping existing config.'));
      return existing;
    }
  }

  if (options.nonInteractive) {
    const config: Config = {
      ports: { web: 3000, runner: 3001, postgres: 25432 },
      workerSecret: generateSecret(32),
      serverActionsKey: randomBytes(32).toString('base64'),
      bind: 'lan',
      auth: { mode: 'local-auth' },
    };
    writeConfig(config);
    console.log(chalk.green('  Default config written for container boot.'));
    return config;
  }

  console.log('');
  console.log(chalk.bold('Nodal-Agents — Setup Wizard'));
  console.log(chalk.gray('Configure your local AI agent platform.\n'));

  // ── Step 1: Pick LLM provider ─────────────────────────────────────────────

  const { providerIndex } = await prompts({
    type: 'select',
    name: 'providerIndex',
    message: 'Which LLM do you want to use?',
    choices: LLM_PRESETS.map((p, i) => ({
      title: p.label,
      value: i,
      description: p.defaultBaseURL,
    })),
    initial: 0,
  });

  if (providerIndex === undefined) {
    process.exit(1);
  }

  const preset = LLM_PRESETS[providerIndex as number]!;

  // ── Step 2: Base URL ──────────────────────────────────────────────────────

  const { baseURL } = await prompts({
    type: 'text',
    name: 'baseURL',
    message: 'Endpoint URL:',
    initial: preset.defaultBaseURL,
    validate: (v: string) => {
      try {
        new URL(v);
        return true;
      } catch {
        return 'Please enter a valid URL (e.g. http://localhost:11434)';
      }
    },
  });

  if (!baseURL) process.exit(1);

  // ── Step 3: Model ─────────────────────────────────────────────────────────

  const spinner = ora('Fetching available models…').start();
  const models = await fetchModels(baseURL as string, preset.provider, undefined);
  spinner.stop();

  let model: string;

  if (models && models.length > 0) {
    const defaultIndex = models.findIndex((m) => m === preset.defaultModel);
    const { chosen } = await prompts({
      type: 'select',
      name: 'chosen',
      message: 'Select a model:',
      choices: models.map((m) => ({ title: m, value: m })),
      initial: defaultIndex >= 0 ? defaultIndex : 0,
    });
    if (!chosen) process.exit(1);
    model = chosen as string;
  } else {
    const { typed } = await prompts({
      type: 'text',
      name: 'typed',
      message: 'Model name:',
      initial: preset.defaultModel,
      validate: (v: string) => (v.length > 0 ? true : 'Model name cannot be empty'),
    });
    if (!typed) process.exit(1);
    model = typed as string;
  }

  // ── Step 4: API key (only for remote providers) ───────────────────────────

  let apiKey: string | undefined;

  if (preset.requiresApiKey) {
    const { key } = await prompts({
      type: 'password',
      name: 'key',
      message: `API key for ${preset.label}:`,
      validate: (v: string) => (v.length > 0 ? true : 'API key is required for this provider'),
    });
    if (!key) process.exit(1);
    apiKey = key as string;
  }

  // ── Step 5: Bind mode ─────────────────────────────────────────────────────

  const { bind } = await prompts({
    type: 'select',
    name: 'bind',
    message: 'Network mode:',
    choices: [
      {
        title: 'Loopback (localhost only, no auth required)',
        value: 'loopback',
        description: 'Recommended for single-user local use',
      },
      {
        title: 'LAN (accessible on your network, sign up with email + password)',
        value: 'lan',
        description: 'Use when accessing from other devices on your network',
      },
    ],
    initial: 0,
  });

  if (!bind) process.exit(1);

  // ── Build config ──────────────────────────────────────────────────────────

  const workerSecret = generateSecret(32);

  const config: Config = {
    llm: {
      provider: preset.provider,
      baseURL: baseURL as string,
      model,
      apiKey,
    },
    ports: {
      web: 3000,
      runner: 3001,
      postgres: 25432,
    },
    workerSecret,
    bind: bind as 'loopback' | 'lan',
  };

  // ── Warn if endpoint not reachable ────────────────────────────────────────

  const reachable = await isEndpointReachable(baseURL as string, preset.provider);
  if (!reachable) {
    console.log('');
    console.log(
      chalk.yellow(
        `  Warning: ${baseURL} is not reachable right now.\n  Config saved anyway — start your LLM server before running \`nodal-agents up\`.`,
      ),
    );
  }

  writeConfig(config);

  console.log('');
  console.log(chalk.green('  Config saved to ~/.nodalai/config.json'));

  if ((bind as string) === 'lan') {
    console.log('');
    console.log(chalk.bold.cyan('  LAN mode: sign up at http://<your-ip>:3000/login'));
    console.log(chalk.gray('  The first user to sign up becomes the admin.'));
  }

  console.log('');
  console.log(chalk.gray('  Run `nodal-agents up` to start Nodal-Agents.'));
  console.log('');

  return config;
}
