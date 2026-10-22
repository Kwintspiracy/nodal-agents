// tests/harness.ts — une instance neuve, telle que `up` la laisse, sur un vrai schéma (PGlite).
//
// Ce que `up` a fait avant que le banc n'applique sa configuration, et rien
// d'autre : l'utilisateur local et son espace (`seedLocalUser`), les skills
// système semés par le runner (`seed-default-skills`, createdBy='system'). Le
// dossier personnel de l'utilisateur est un dossier temporaire : le registre
// des instances, la clé maîtresse et le dossier de Nodal par défaut des tests
// n'atteignent jamais ceux de la machine.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodalConfigSchema } from '@nodal-agents/shared/nodal-config';
import {
  registerNodalInstance,
  unregisterNodalInstance,
} from '@nodal-agents/shared/nodal-instances';
import { benchAlive, type InstancePorts, type NodalCli } from '../instance';
import * as d from '@nodal-agents/db';
import type { AnyDrizzleDb } from '@nodal-agents/db';
import { spinUpTestDb } from '@nodal-agents/db/test-utils';
import { systemSkills } from '@nodal-agents/catalog';
import type { CampaignKeys } from '../keys';

export const TEST_KEYS: CampaignKeys = {
  providers: { openrouter: 'sk-or-test-NEVER-SENT-1234' },
  connectors: { tavily: 'tvly-test-NEVER-SENT', firecrawl: 'fc-test-NEVER-SENT' },
  services: {},
};

/**
 * Un dossier personnel jetable : `USERPROFILE`/`HOME` (os.homedir les lit),
 * et `NODALAI_HOME` dessous (la clé maîtresse que chiffre une clé d'API).
 * À appeler avant tout chiffrement du fichier de test.
 */
export function isolateUserHome(): { userHome: string; restore(): void } {
  const userHome = mkdtempSync(join(tmpdir(), 'bench-campaign-home-'));
  const saved = {
    USERPROFILE: process.env['USERPROFILE'],
    HOME: process.env['HOME'],
    NODALAI_HOME: process.env['NODALAI_HOME'],
  };
  process.env['USERPROFILE'] = userHome;
  process.env['HOME'] = userHome;
  process.env['NODALAI_HOME'] = join(userHome, 'test-nodal-home');
  return {
    userHome,
    restore() {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(userHome, { recursive: true, force: true });
    },
  };
}

/** Une base neuve, semée comme `up` la sème. */
export async function freshInstanceDb(): Promise<{ db: AnyDrizzleDb; localEntityId: string }> {
  const { db } = await spinUpTestDb();
  const t = db as unknown as AnyDrizzleDb;
  const [user] = await t.insert(d.users).values({ email: 'local@nodalai.local' }).returning();
  const [ent] = await t
    .insert(d.entities)
    .values({ userId: user!.id, name: 'Local', slug: 'local' })
    .returning();
  await t.insert(d.entityMembers).values({ entityId: ent!.id, userId: user!.id, role: 'owner' });
  for (const skill of systemSkills) {
    await t.insert(d.agentSkills).values({
      entityId: ent!.id,
      slug: skill.slug,
      name: skill.name,
      description: skill.description,
      content: skill.content,
      defaultContent: skill.content,
      contentOverridden: false,
      requiredBuiltins: skill.requiredBuiltins ?? [],
      active: true,
      createdBy: 'system',
    });
  }
  return { db: t, localEntityId: ent!.id };
}

/**
 * Ce que la route `/api/skills/install` du runner fait d'une source
 * communautaire, vu de la base : une ligne de skill dans l'espace. Les appels
 * sont gardés, pour que le test dise ce qui a été demandé.
 */
export function fakeCommunityInstaller(db: AnyDrizzleDb): {
  install: (source: string, entityId: string) => Promise<void>;
  calls: Array<{ source: string; entityId: string }>;
} {
  const calls: Array<{ source: string; entityId: string }> = [];
  return {
    calls,
    async install(source, entityId) {
      calls.push({ source, entityId });
      const slug = source.split('/').pop()!;
      const r = await d.createSkillRepo(db, entityId, {
        slug,
        name: slug,
        content: `# ${slug}\nInstalled from ${source}.`,
        description: null,
      });
      if ('error' in r) throw new Error(`fake install failed: ${r.error}`);
    },
  };
}

// ─── Un faux CLI de Nodal, qui démarre un vrai processus ─────────────────────

/**
 * Trois ports libres, et DISTINCTS : les trois écouteurs restent ouverts
 * jusqu'à ce que le dernier ait le sien. Fermé tout de suite, un port libéré
 * pouvait être rendu deux fois (le runner et le Postgres sur le même port, CI
 * Linux du 22/10 : EADDRINUSE).
 */
export async function freePorts(): Promise<InstancePorts> {
  const servers = [createServer(), createServer(), createServer()];
  const [web, runner, postgres] = await Promise.all(
    servers.map(
      (s) =>
        new Promise<number>((resolve) =>
          s.listen(0, '127.0.0.1', () => resolve((s.address() as { port: number }).port)),
        ),
    ),
  );
  await Promise.all(servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
  return { web: web!, runner: runner!, postgres: postgres! };
}

/**
 * Les faux lanceurs dont le processus est réellement SORTI (son événement
 * `exit`). Jamais un PID sondé : sous Windows, un PID libéré est réattribué
 * vite, et `process.kill(pid, 0)` dit alors « vivant » d'un autre processus
 * (mesuré sur la CI Windows du 22/10). L'état est celui du DERNIER processus
 * lancé sous ce PID : un PID réattribué à un nouveau lanceur ne se lit jamais
 * « sorti » au nom de l'ancien, même si l'`exit` de l'ancien arrive en retard.
 */
const launchers = new Map<number, { exited: boolean }>();

/** Ce faux lanceur est-il sorti ? (vrai seulement pour un processus lancé par `fakeCli`) */
export const launcherExited = (pid: number): boolean => launchers.get(pid)?.exited === true;

/** Pour un PID qui n'est pas un faux lanceur : la sonde par PID, à n'utiliser qu'à défaut. */
export const dead = (pid: number): boolean => !benchAlive(pid);
export async function until(cond: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const t0 = Date.now();
  while (!(await cond())) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Ce que reçoit le faux CLI, pour que le test dise ce qui a été passé à l'instance. */
export interface FakeCli extends NodalCli {
  readonly envs: Array<Record<string, string>>;
  readonly commands: string[];
}

/**
 * Le script du faux lanceur : il sert `/api/health` en HTTP sur le port du
 * runner (200, comme un runner dont la base répond), écoute sur les deux
 * autres, et vit jusqu'à ce qu'on le tue. `FAKE_MODE=exit` : il sort aussitôt
 * en écrivant une erreur ; `FAKE_MODE=silent` : il vit sans rien servir ;
 * `FAKE_MODE=unhealthy` : tout écoute, mais `/api/health` rend 503 (la base
 * du runner est morte, ce que `up --detach` laissait le 22/10).
 */
const FAKE_LAUNCHER = [
  "const n=require('net'),h=require('http');",
  "if(process.env.FAKE_MODE==='exit'){console.error('Error: Port conflict with a process that is not ours');process.exit(1);}",
  "if(process.env.FAKE_MODE!=='silent'){",
  "const [w,r,p]=process.env.FAKE_PORTS.split(',').map(Number);",
  "const ok=process.env.FAKE_MODE==='unhealthy'?503:200;",
  "h.createServer((q,s)=>{s.statusCode=q.url==='/api/health'?ok:404;s.end(ok===200?'{}':'{\"db\":\"error\"}');}).listen(r,'127.0.0.1');",
  "for(const x of [w,p])n.createServer(s=>s.end()).listen(x,'127.0.0.1');}",
  'setInterval(()=>{},1e6);',
].join('');

/**
 * Un CLI qui démarre un vrai processus, et écrit un journal comme le vrai.
 * `resetForgets` simule un `reset` du produit qui arrête mais n'efface rien ;
 * `downKeepsAlive`, un `down` qui ne tue pas ; `up: 'exit'`, un `up` qui sort
 * avant de servir ; `up: 'silent'`, un `up` qui vit sans jamais servir.
 */
export function fakeCli(
  userHome: string,
  spawned: number[],
  opts: {
    resetForgets?: boolean;
    downKeepsAlive?: boolean;
    up?: 'serve' | 'exit' | 'silent' | 'unhealthy';
  } = {},
): FakeCli {
  const envs: Array<Record<string, string>> = [];
  const commands: string[] = [];
  const pidFile = (env: Record<string, string>) => join(env['NODALAI_HOME']!, 'pids', 'fake.json');
  const down = async (env: Record<string, string>): Promise<void> => {
    if (opts.downKeepsAlive || !existsSync(pidFile(env))) return;
    const { pid } = JSON.parse(readFileSync(pidFile(env), 'utf8')) as { pid: number };
    try {
      process.kill(pid);
    } catch {
      /* déjà mort */
    }
    await until(() => launcherExited(pid));
  };
  return {
    envs,
    commands,
    launch(args, env) {
      envs.push(env);
      commands.push(args.join(' '));
      mkdirSync(join(env['NODALAI_HOME']!, 'logs'), { recursive: true });
      writeFileSync(join(env['NODALAI_HOME']!, 'logs', 'web.log'), 'fake web: compiled\n');
      registerNodalInstance(env, userHome);
      const cfg = NodalConfigSchema.parse(
        JSON.parse(readFileSync(join(env['NODALAI_HOME']!, 'config.json'), 'utf8')),
      );
      const ports = [cfg.ports.web, cfg.ports.runner, cfg.ports.postgres].join(',');
      const child = spawn(process.execPath, ['-e', FAKE_LAUNCHER], {
        env: { ...env, FAKE_PORTS: ports, FAKE_MODE: opts.up ?? 'serve' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      spawned.push(child.pid!);
      const state = { exited: false };
      launchers.set(child.pid!, state);
      child.on('exit', () => (state.exited = true));
      mkdirSync(join(env['NODALAI_HOME']!, 'pids'), { recursive: true });
      writeFileSync(pidFile(env), JSON.stringify({ pid: child.pid }));
      let output = '';
      child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
      child.stderr?.on('data', (d: Buffer) => (output += d.toString()));
      const exited = new Promise<{ code: number; output: string }>((resolve) =>
        child.on('exit', (code) => resolve({ code: code ?? 1, output })),
      );
      return {
        pid: child.pid!,
        exited,
        output: () => output,
        kill: () => {
          try {
            process.kill(child.pid!);
          } catch {
            /* déjà mort */
          }
        },
      };
    },
    async run(args, env) {
      envs.push(env);
      commands.push(args.join(' '));
      if (args[0] === 'down') {
        await down(env);
        return { code: 0, output: '' };
      }
      if (args[0] === 'reset') {
        await down(env);
        if (!opts.resetForgets) {
          rmSync(env['NODALAI_HOME']!, { recursive: true, force: true });
          unregisterNodalInstance(env, userHome);
        }
        return { code: 0, output: '' };
      }
      return { code: 1, output: `unknown ${args.join(' ')}` };
    },
  };
}
