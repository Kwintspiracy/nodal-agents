// deny-data-dir.test.ts — une commande confinée ne peut pas LIRE le dossier de
// données de Nodal (secrets.key, config.json, pg-data), tandis que son dossier
// de travail reste lisible, inscriptible, et que git y marche (#628, D1).
//
// LA DISPOSITION DE PRODUCTION, pas un dossier temporaire à côté : c'est
// l'écart par lequel la casse de git est passée (16/10). Les tests ordinaires
// mettent les workspaces hors de `~/.nodalai` ; ici, USERPROFILE pointe sur un
// home temporaire et tout y est placé comme chez un utilisateur : `.nodalai/`
// avec secrets.key, config.json, pg-data, workspaces/<entité>/<ws>,
// tool-cache, checkpoints, sandbox — et `homedir()` comme
// `sandboxDeniedPaths()` visent `<home>/.nodalai`.
//
// D1 refuse chaque ENFANT du dossier sauf ceux que le conteneur doit atteindre
// (policy.ts) : le contenu reste refusé, seuls les NOMS des enfants sont
// visibles dans le listage (accepté le 16/10). Refuser le dossier ENTIER
// cassait git : `git init`, `commit` et `branch` échouaient dans le workspace.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobProcessScope, createSandbox, mxcBackend, openNodalPrograms } from '../index';

const isWindows = process.platform === 'win32';

let home: string;
let dataDir: string;
let ws: string;
let store: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  saved[k] = process.env[k];
  process.env[k] = v;
}

if (isWindows) {
  home = mkdtempSync(join(tmpdir(), 'nodal-deny-home-'));
  dataDir = join(home, '.nodalai');
  ws = join(dataDir, 'workspaces', 'entity-1', 'ws1');
  store = join(dataDir, 'checkpoints');
  const pg = join(dataDir, 'pg-data');
  for (const d of [ws, pg, store, join(dataDir, 'tool-cache'), join(dataDir, 'sandbox')])
    mkdirSync(d, { recursive: true });
  writeFileSync(join(dataDir, 'secrets.key'), 'MASTER-KEY');
  writeFileSync(join(dataDir, 'config.json'), '{"workerSecret":"S"}');
  writeFileSync(join(pg, 'pg_hba.conf'), 'secret-pg');
  writeFileSync(join(ws, 'in.txt'), 'ws-content');
  // homedir() lit USERPROFILE sous Windows ; les sous-dossiers par leurs
  // variables, sous le dossier de données, comme en production.
  setEnv('USERPROFILE', home);
  setEnv('NODALAI_SANDBOX_DIR', join(dataDir, 'sandbox'));
  setEnv('NODALAI_TOOL_CACHE_ROOT', join(dataDir, 'tool-cache'));
  setEnv('NODALAI_WORKSPACES_ROOT', join(dataDir, 'workspaces'));
}

const sandbox = isWindows
  ? createSandbox(mxcBackend(undefined, 'deny-all'), { log: () => {} })
  : undefined;
const status = sandbox ? await sandbox.status() : undefined;
// Le palier MXC de CETTE machine. Là où il permet le bac à sable, un statut
// indisponible est un ÉCHEC, jamais une suite sautée : refuser le dossier de
// données entier rend la sonde indisponible (son script vit dessous), et une
// suite qui se saute alors ne prouverait rien.
const tier = isWindows
  ? (await import('@microsoft/mxc-sdk/v1')).getPlatformSupport().isolationTier
  : undefined;

describe.runIf(isWindows && tier === 'base-container')(
  'production layout: the sandbox is available with Nodal’s data dir in place @cap:executer-une-commande/moteur (Windows, MXC base-container)',
  () => {
    it('the probe, whose scripts live under the data dir, says available', () => {
      expect(status, JSON.stringify(status)).toMatchObject({ state: 'available' });
    });
  },
);

/** Le git de la machine, par son chemin absolu. */
function gitPath(): string {
  return execFileSync('where', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/)
    .find((l) => l.trim() !== '')!
    .trim();
}

function baseEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const n of [
    'SYSTEMROOT',
    'WINDIR',
    'PATH',
    'COMSPEC',
    'LOCALAPPDATA',
    'USERPROFILE',
    'PATHEXT',
  ])
    env[n] = process.env[n];
  return env;
}

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // Best-effort : le Node dédié du courtier, sous `home`, reste tenu par le
  // processus courtier jusqu'à la fin du worker vitest (EPERM).
  if (home) {
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* laissé au nettoyage de l'OS */
    }
  }
});

describe.runIf(isWindows && tier === 'base-container')(
  'production layout: a confined command cannot read Nodal’s data dir, its workspace stays usable, git works in it @cap:executer-une-commande/moteur (Windows, MXC)',
  () => {
    let out: Record<string, string>;
    let gitSteps: string[];
    beforeAll(async () => {
      const reader = join(ws, 'reader.cjs');
      writeFileSync(
        reader,
        `const fs=require('fs'),p=require('path');const [dataDir,ws,pg]=process.argv.slice(2);
const r={};const t=(l,f)=>{try{r[l]='OK:'+String(f()).slice(0,200)}catch(e){r[l]=e.code}};
t('secrets',()=>fs.readFileSync(p.join(dataDir,'secrets.key'),'utf8'));
t('config',()=>fs.readFileSync(p.join(dataDir,'config.json'),'utf8'));
t('pgdata',()=>fs.readFileSync(p.join(pg,'pg_hba.conf'),'utf8'));
t('list',()=>fs.readdirSync(dataDir).sort().join(','));
t('readWs',()=>fs.readFileSync(p.join(ws,'in.txt'),'utf8'));
t('writeWs',()=>{fs.writeFileSync(p.join(ws,'out.txt'),'w');return 'written'});
process.stdout.write('RESULT '+JSON.stringify(r));`,
      );
      const env = baseEnv();
      const scope = new JobProcessScope('deny-data-dir-job', sandbox!);
      try {
        const container = await scope.container([ws], env);
        const proc = await container.start({
          target: { file: process.execPath, args: [reader, dataDir, ws, join(dataDir, 'pg-data')] },
          cwd: ws,
          env,
        });
        let s = '';
        proc.stdout?.on('data', (d: Buffer) => (s += String(d)));
        proc.stderr?.on('data', (d: Buffer) => (s += String(d)));
        await proc.done;
        out = JSON.parse(/RESULT (\{.*\})/.exec(s)?.[1] ?? '{}');
        // git, comme un agent l'utilise dans son workspace.
        gitSteps = [];
        const git = gitPath();
        for (const args of [
          ['init', '-q'],
          ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x'],
          ['branch', 'feature'],
          ['status', '--porcelain'],
        ]) {
          const p = await container.start({ target: { file: git, args }, cwd: ws, env });
          let e = '';
          p.stderr?.on('data', (d: Buffer) => (e += String(d)));
          const end = await p.done;
          gitSteps.push(
            `${args.find((a) => !a.startsWith('-') && !a.includes('='))}=${end.kind === 'exit' ? end.exitCode : end.kind}${e ? ` [${e.trim().split('\n')[0]}]` : ''}`,
          );
        }
      } finally {
        await scope.close();
      }
    }, 120_000);

    it('secrets.key, config.json and pg-data stay unreadable; only the children NAMES are listed', () => {
      expect(out.secrets, JSON.stringify(out)).toBe('EPERM');
      expect(out.config).toBe('EPERM');
      expect(out.pgdata).toBe('EPERM');
      // Accepté (D1, 16/10) : les noms, jamais le contenu.
      expect(out.list).toBe(
        'OK:checkpoints,config.json,pg-data,sandbox,secrets.key,tool-cache,workspaces',
      );
    });

    it('the workspace is readable and writable', () => {
      expect(out.readWs).toBe('OK:ws-content');
      expect(out.writeWs).toBe('OK:written');
    });

    it('git init, commit, branch and status work in a workspace under the data dir', () => {
      expect(gitSteps, gitSteps.join(' | ')).toEqual([
        'init=0',
        'commit=0',
        'branch=0',
        'status=0',
      ]);
    });

    it('the checkpoints container (Nodal’s own git) writes a ref in the store under the data dir', async () => {
      // Les gestes de `snapshot` : magasin nu créé sur l'hôte, puis add,
      // write-tree, commit-tree et update-ref DANS le conteneur, l'arbre de
      // travail et le magasin inscriptibles. `update-ref` échouait (« unable to
      // create directory ») quand le dossier entier était refusé.
      const git = gitPath();
      const gitDir = join(store, 'store');
      execFileSync(git, ['init', '--bare', '--quiet', gitDir]);
      const env = {
        ...process.env,
        GIT_DIR: gitDir,
        GIT_WORK_TREE: ws,
        GIT_INDEX_FILE: join(store, 'index'),
        GIT_CONFIG_GLOBAL: join(store, 'gitconfig'),
        GIT_CONFIG_SYSTEM: join(store, 'gitconfig'),
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      };
      const programs = await openNodalPrograms(sandbox);
      try {
        expect(programs.confined).toBe(true);
        const run = async (args: string[]): Promise<string> =>
          (
            await programs.execFile(git, args, {
              env,
              writableRoots: [ws, store],
              readableRoots: [],
            })
          ).stdout.trim();
        await run(['add', '-A']);
        const tree = await run(['write-tree']);
        const sha = await run(['commit-tree', tree, '-m', 'probe']);
        await run(['update-ref', 'refs/nodal/probe', sha]);
        expect(await run(['rev-parse', 'refs/nodal/probe'])).toBe(sha);
      } finally {
        await programs.close();
      }
    }, 120_000);
  },
);
