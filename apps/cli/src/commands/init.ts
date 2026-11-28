// init.ts — interactive wizard to configure Nodal-Agents

import chalk from 'chalk';
import prompts from 'prompts';
import ora from 'ora';
import {
  writeConfig,
  readConfig,
  createConfig,
  newInstallConfig,
  CONFIG_FILE,
  type Config,
} from '../lib/config.ts';
import { LLM_PRESETS, fetchModels, isEndpointReachable } from '../lib/llm-presets.ts';

/**
 * Run the interactive init wizard.
 *
 * On an EXISTING install it edits, it does not replace (B38-01): the answers
 * change the LLM and the network mode, and everything else in the config is
 * kept as it was, the database password above all, with the secrets, the
 * ports, the auth settings and any key this version does not know. Re-running
 * it is therefore safe by construction, which is what the docs promise. A
 * config that exists but cannot be read stops `init` with the reader's error:
 * it is never taken for "no config" and written over.
 *
 * `force` skips the confirmation. `nonInteractive` asks nothing: on a new
 * install it writes a default for container boot (lan bind, local-auth, no LLM
 * preset); on an existing one it returns the config untouched unless `force`
 * is given, in which case it applies those same two choices to it.
 */
export async function runInit(
  options: { force?: boolean; nonInteractive?: boolean } = {},
): Promise<Config> {
  const existing = readConfig();

  if (existing && !options.force) {
    if (options.nonInteractive) return existing;
    const { proceed } = await prompts({
      type: 'confirm',
      name: 'proceed',
      message: chalk.yellow(
        'A config already exists. Change its LLM and network settings? ' +
          '(The database password, secrets and ports are kept.)',
      ),
      initial: false,
    });
    if (!proceed) {
      console.log(chalk.gray('Init cancelled — keeping existing config.'));
      return existing;
    }
  }

  if (options.nonInteractive) {
    const choices: Partial<Config> = {
      bind: 'lan',
      auth: { ...existing?.auth, mode: 'local-auth' },
    };
    const config = save(existing, choices);
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

  const lan = (bind as string) === 'lan';
  const choices: Partial<Config> = {
    llm: {
      provider: preset.provider,
      baseURL: baseURL as string,
      model,
      apiKey,
    },
    bind: bind as 'loopback' | 'lan',
    // LAN is offered as "sign up with email + password": an existing
    // `auth.mode: local-trust` would be the combination `up` refuses to start.
    ...(lan && existing?.auth?.mode === 'local-trust'
      ? { auth: { ...existing.auth, mode: 'local-auth' as const } }
      : {}),
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

  const config = save(existing, choices);

  console.log('');
  console.log(chalk.green(`  Config saved to ${CONFIG_FILE}`));

  if (lan) {
    console.log('');
    console.log(chalk.bold.cyan('  LAN mode: sign up at http://<your-ip>:3000/login'));
    console.log(chalk.gray('  The first user to sign up becomes the admin.'));
  }

  console.log('');
  console.log(chalk.gray('  Run `nodal-agents up` to start Nodal-Agents.'));
  console.log('');

  return config;
}

/**
 * Apply `choices` to the existing config (an edit: every other key is kept),
 * or create the config of a new install with them.
 */
function save(existing: Config | null, choices: Partial<Config>): Config {
  if (existing) {
    const config: Config = { ...existing, ...choices };
    writeConfig(config);
    return config;
  }
  const config = newInstallConfig(choices);
  createConfig(config);
  return config;
}
