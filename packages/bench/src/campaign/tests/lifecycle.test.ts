// lifecycle.test.ts — démarrer puis effacer une campagne ne laisse ni processus, ni dossier, ni entrée de registre.
//
// Le CLI du produit est remplacé par un faux qui fait ce que fait le vrai, vu
// du dehors : `up` lance un VRAI processus qui écoute sur les trois ports de
// l'instance et inscrit l'instance au registre (`registerNodalInstance`, la
// porte du produit) ; `down` le tue ; `reset --yes` fait down, efface le
// dossier et retire l'entrée. Ce que le test vérifie est réel : le processus
// est mort (process.kill(pid, 0) échoue), les ports ne répondent plus, le
// dossier n'existe plus, le registre ne nomme plus l'instance. Le dossier
// personnel est temporaire : le registre de la machine n'est jamais touché.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NodalConfigSchema } from '@nodal-agents/shared/nodal-config';
import { defaultNodalHome } from '@nodal-agents/shared/nodal-home';
import { readNodalInstances } from '@nodal-agents/shared/nodal-instances';
import { campaignHome, campaignsRoot } from '../home';
import {
  campaignEnv,
  createInstanceFiles,
  devServerHolding,
  eraseInstance,
  instancePaths,
  planInstance,
  portAnswers,
  notServing,
  startInstance,
  stopInstance,
  sweepLeftoverCampaigns,
  type CampaignInstance,
  type LifecycleDeps,
  type NodalCli,
} from '../instance';
import { isInside } from '../keys';
import { TEST_KEYS, fakeCli, freePorts, isolateUserHome, launcherExited, until } from './harness';

const home = isolateUserHome();
const userHome = home.userHome;
const stackDir = mkdtempSync(join(tmpdir(), 'bench-campaign-checkout-'));
const spawned: number[] = [];

afterAll(() => {
  for (const pid of spawned) {
    try {
      process.kill(pid);
    } catch {
      /* déjà mort */
    }
  }
  rmSync(stackDir, { recursive: true, force: true });
  home.restore();
});

/** L'environnement du shell du propriétaire : des réglages de SON Nodal, qui ne doivent jamais atteindre l'instance. */
const OWNER_SHELL = {
  PATH: process.env['PATH'] ?? '',
  NODALAI_HOME: 'C:\\Users\\owner\\.nodalai',
  NODALAI_WORKSPACES_ROOT: 'C:\\Users\\owner\\.nodalai\\workspaces',
  NODALAI_CONFIG_PATH: 'C:\\Users\\owner\\.nodalai\\config.json',
  LLM_API_KEY: 'sk-owner-secret',
  LLM_PROVIDER: 'openrouter',
  DATABASE_URL: 'postgresql://nodalai:owner@localhost:25444/nodalai',
  TELEGRAM_POLLER_ENABLED: '1',
  REFLECTION_ENABLED: '1',
  NODAL_MCP_AGENT_ID: 'owner-agent',
};

function deps(cli: NodalCli): LifecycleDeps {
  return { cli, baseEnv: OWNER_SHELL, userHome, log: () => undefined, quietWaitMs: 3_000 };
}

async function newInstance(id: string): Promise<CampaignInstance> {
  const instance = planInstance(id, await freePorts(), stackDir, userHome);
  createInstanceFiles(instance, TEST_KEYS);
  return instance;
}

const registered = (instance: CampaignInstance): boolean =>
  readNodalInstances(userHome).some((r) => isInside(r.home, instance.home));

describe('the campaign instance: where it lives, what it is given', () => {
  it('its folder, config and work folders all resolve under the campaign folder, never under ~/.nodalai', async () => {
    const instance = await newInstance('20261022-100000-aaaa');
    expect(instance.home).toBe(campaignHome('20261022-100000-aaaa', userHome));
    expect(isInside(instance.home, campaignsRoot(userHome))).toBe(true);
    for (const path of Object.values(instancePaths(instance))) {
      expect(isInside(path, instance.home)).toBe(true);
      expect(isInside(path, defaultNodalHome(userHome))).toBe(false);
    }
    const cfg = NodalConfigSchema.parse(
      JSON.parse(readFileSync(instancePaths(instance).config, 'utf8')),
    );
    expect(cfg.ports).toEqual(instance.ports);
    expect(cfg.bind).toBe('loopback');
    expect(cfg.auth?.mode).toBe('local-trust');
    expect(JSON.parse(readFileSync(instancePaths(instance).benchConfig, 'utf8'))).toEqual({
      services: {},
    });
    rmSync(instance.home, { recursive: true, force: true });
  });

  it('the CLI receives the campaign folder, and nothing of the owner’s Nodal settings', () => {
    const env = campaignEnv(OWNER_SHELL, 'D:\\bench\\campaign');
    expect(env['NODALAI_HOME']).toBe('D:\\bench\\campaign');
    expect(env['NODALAI_NO_BROWSER']).toBe('1');
    // La première compilation de `next dev` d'un dépôt neuf : 15 min, pas les 300 s par défaut.
    expect(env['NODALAI_WEB_HEALTH_MS']).toBe('900000');
    expect(env['PATH']).toBe(OWNER_SHELL.PATH);
    for (const k of [
      'NODALAI_WORKSPACES_ROOT',
      'NODALAI_CONFIG_PATH',
      'LLM_API_KEY',
      'LLM_PROVIDER',
      'DATABASE_URL',
      'TELEGRAM_POLLER_ENABLED',
      'REFLECTION_ENABLED',
      'NODAL_MCP_AGENT_ID',
    ]) {
      expect(env[k]).toBeUndefined();
    }
  });

  it('refuses a campaign folder that already exists: a campaign never reuses another one’s data', async () => {
    const instance = await newInstance('20261022-100100-bbbb');
    expect(() => createInstanceFiles(instance, TEST_KEYS)).toThrow(/campaign_home_exists/);
    rmSync(instance.home, { recursive: true, force: true });
  });
});

describe('start, then erase: no process, no folder, no registry entry', () => {
  afterEach(() => rmSync(campaignsRoot(userHome), { recursive: true, force: true }));

  it('start launches `up --dev` in the foreground with the campaign env, waits for real health; stop and erase leave nothing', async () => {
    const cli = fakeCli(userHome, spawned);
    const instance = await newInstance('20261022-100200-cccc');
    const launched = await startInstance(instance, deps(cli));
    expect(cli.commands).toEqual(['up --dev']);
    expect(cli.envs[0]!['NODALAI_HOME']).toBe(instance.home);
    expect(cli.envs[0]!['LLM_API_KEY']).toBeUndefined();
    expect(launcherExited(launched.pid)).toBe(false);
    // Sain veut dire : le runner répond 200 à /api/health, web et Postgres écoutent.
    const health = await fetch(`http://127.0.0.1:${instance.ports.runner}/api/health`);
    expect(health.status).toBe(200);
    expect(await notServing(instance.ports)).toEqual([]);
    expect(registered(instance)).toBe(true);

    await stopInstance(instance, deps(cli), launched);
    expect((await launched.exited).code).not.toBeUndefined();
    expect(launcherExited(launched.pid)).toBe(true);
    await eraseInstance(instance, deps(cli));
    expect(cli.commands).toEqual(['up --dev', 'down', 'reset --yes']);
    for (const port of Object.values(instance.ports)) expect(await portAnswers(port)).toBe(false);
    expect(existsSync(instance.home)).toBe(false);
    expect(registered(instance)).toBe(false);
  });

  it('a launcher that outlives `down` is stopped by the bench, which started it', async () => {
    const cli = fakeCli(userHome, spawned, { downKeepsAlive: true });
    const instance = await newInstance('20261022-100250-keep');
    const launched = await startInstance(instance, deps(cli));
    const logs: string[] = [];
    await stopInstance(
      instance,
      { ...deps(cli), log: (l) => logs.push(l), launcherExitMs: 500 },
      launched,
    );
    await launched.exited;
    expect(launcherExited(launched.pid)).toBe(true);
    expect(logs).toContain(
      `The launcher (pid ${launched.pid}) outlived \`down\`: its tree is stopped.`,
    );
    await eraseInstance(instance, deps(cli));
    expect(registered(instance)).toBe(false);
  });

  it('a reset that stops but erases nothing is completed by the bench: folder and registry entry gone', async () => {
    const cli = fakeCli(userHome, spawned, { resetForgets: true });
    const instance = await newInstance('20261022-100300-dddd');
    await startInstance(instance, deps(cli));
    await eraseInstance(instance, deps(cli));
    expect(existsSync(instance.home)).toBe(false);
    expect(registered(instance)).toBe(false);
  });

  it('a process that survives the erase is named, never reported erased', async () => {
    const cli = fakeCli(userHome, spawned, { downKeepsAlive: true });
    const instance = await newInstance('20261022-100400-eeee');
    await startInstance(instance, deps(cli));
    const { pid } = JSON.parse(readFileSync(join(instance.home, 'pids', 'fake.json'), 'utf8')) as {
      pid: number;
    };
    await expect(eraseInstance(instance, deps(cli))).rejects.toThrow(
      new RegExp(
        `campaign_erase_incomplete: campaign ${instance.id}:\\n  - ports still answering: web :${instance.ports.web}, runner :${instance.ports.runner}, postgres :${instance.ports.postgres}`,
      ),
    );
    process.kill(pid);
    await until(() => launcherExited(pid));
  });

  it('an `up` that exits before serving is an error carrying its output, never a started instance', async () => {
    const cli = fakeCli(userHome, spawned, { up: 'exit' });
    const instance = await newInstance('20261022-100450-exit');
    await expect(startInstance(instance, deps(cli))).rejects.toThrow(
      /campaign_up_failed: nodal-agents up exited 1 before serving \(runner :\d+ \/api\/health, web :\d+, postgres :\d+ missing\)\nError: Port conflict with a process that is not ours/,
    );
    await eraseInstance(instance, deps(cli));
    expect(registered(instance)).toBe(false);
  });

  it('an `up` that never serves is stopped at the deadline, and the error says what never answered', async () => {
    const cli = fakeCli(userHome, spawned, { up: 'silent' });
    const instance = await newInstance('20261022-100460-mute');
    const before = spawned.length;
    await expect(startInstance(instance, { ...deps(cli), upTimeoutMs: 1_500 })).rejects.toThrow(
      /campaign_up_timeout: the instance did not serve within 2 s \(runner :\d+ \/api\/health, web :\d+, postgres :\d+ missing\); its launcher was stopped/,
    );
    const launcher = spawned[before]!;
    await until(() => launcherExited(launcher));
    await eraseInstance(instance, deps(cli));
    expect(registered(instance)).toBe(false);
  });

  it('every port answering is not health: a runner whose database is dead (503) is never a started instance', async () => {
    const cli = fakeCli(userHome, spawned, { up: 'unhealthy' });
    const instance = await newInstance('20261022-100470-sick');
    await expect(startInstance(instance, { ...deps(cli), upTimeoutMs: 1_500 })).rejects.toThrow(
      /campaign_up_timeout: the instance did not serve within 2 s \(runner \/api\/health HTTP 503 missing\)/,
    );
    await eraseInstance(instance, deps(cli));
    expect(registered(instance)).toBe(false);
  });

  it('start refuses before launching anything when a port of the instance already answers', async () => {
    const cli = fakeCli(userHome, spawned);
    const instance = await newInstance('20261022-100500-ffff');
    const squatter = createServer((s) => s.end()).listen(instance.ports.runner, '127.0.0.1');
    try {
      await until(() => portAnswers(instance.ports.runner));
      await expect(startInstance(instance, deps(cli))).rejects.toThrow(
        new RegExp(`campaign_ports_busy: runner :${instance.ports.runner} already answers`),
      );
      expect(cli.commands).toEqual([]);
    } finally {
      squatter.close();
    }
  });

  it('start refuses a checkout whose web folder already serves a next dev: Next would refuse the second', async () => {
    const cli = fakeCli(userHome, spawned);
    const instance = await newInstance('20261022-100600-abcd');
    const lockDir = join(stackDir, 'apps', 'web', '.next', 'dev');
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, 'lock'),
      JSON.stringify({ pid: process.pid, port: 3000, appUrl: 'http://localhost:3000' }),
    );
    try {
      expect(devServerHolding(stackDir)).toMatchObject({ pid: process.pid });
      await expect(startInstance(instance, deps(cli))).rejects.toThrow(
        /campaign_checkout_in_use: .* already serves a next dev \(pid \d+, http:\/\/localhost:3000\)/,
      );
      expect(cli.commands).toEqual([]);
    } finally {
      rmSync(join(stackDir, 'apps'), { recursive: true, force: true });
    }
  });
});

describe('a stopped or crashed campaign leaves nothing behind for the next', () => {
  afterEach(() => rmSync(campaignsRoot(userHome), { recursive: true, force: true }));

  it('the next campaign erases one left by a dead bench, process and registry entry included', async () => {
    const cli = fakeCli(userHome, spawned);
    const left = await newInstance('20261022-090000-dead');
    await startInstance(left, deps(cli));
    const { pid } = JSON.parse(readFileSync(join(left.home, 'pids', 'fake.json'), 'utf8')) as {
      pid: number;
    };
    // Le banc qui l'a posée est mort : son pid ne vit plus.
    const marker = JSON.parse(readFileSync(instancePaths(left).marker, 'utf8')) as Record<
      string,
      unknown
    >;
    writeFileSync(instancePaths(left).marker, JSON.stringify({ ...marker, pid: 999_999_999 }));

    const erased = await sweepLeftoverCampaigns({
      ...deps(cli),
      stackDir,
      ports: left.ports,
      isAlive: () => false,
    });
    expect(erased).toEqual(['20261022-090000-dead']);
    expect(launcherExited(pid)).toBe(true);
    expect(existsSync(left.home)).toBe(false);
    expect(registered(left)).toBe(false);
  });

  it('a campaign whose bench still lives is never erased: the next one refuses', async () => {
    const cli = fakeCli(userHome, spawned);
    const running = await newInstance('20261022-090100-live');
    await expect(
      sweepLeftoverCampaigns({ ...deps(cli), stackDir, ports: running.ports, isAlive: () => true }),
    ).rejects.toThrow(
      /campaign_running: campaign 20261022-090100-live \(bench pid \d+\) is still running/,
    );
    expect(existsSync(running.home)).toBe(true);
  });

  it('a second campaign never sees the first one’s data', async () => {
    const cli = fakeCli(userHome, spawned);
    const a = await newInstance('20261022-090200-aaaa');
    await startInstance(a, deps(cli));
    mkdirSync(join(instancePaths(a).workspaces, 'x', 'shared'), { recursive: true });
    writeFileSync(join(instancePaths(a).workspaces, 'x', 'shared', 'from-a.txt'), 'a');
    const secretA = NodalConfigSchema.parse(
      JSON.parse(readFileSync(instancePaths(a).config, 'utf8')),
    ).workerSecret;
    await eraseInstance(a, deps(cli));

    const b = await newInstance('20261022-090300-bbbb');
    expect(b.home).not.toBe(a.home);
    expect(existsSync(join(instancePaths(b).workspaces, 'x', 'shared', 'from-a.txt'))).toBe(false);
    const secretB = NodalConfigSchema.parse(
      JSON.parse(readFileSync(instancePaths(b).config, 'utf8')),
    ).workerSecret;
    expect(secretB).not.toBe(secretA);
  });
});
