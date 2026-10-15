// deny-data-dir.test.ts — une commande confinée ne peut ni lire ni lister le
// dossier de données de Nodal (secrets.key, config.json, pg-data), tandis que
// son dossier de travail reste lisible ET inscriptible (#628, D1).
//
// On reproduit la vraie disposition : USERPROFILE pointe sur un home
// temporaire, donc `homedir()` et `sandboxDeniedPaths()` visent
// `<temp>/.nodalai` ; les sous-dossiers (sandbox, tool-cache, workspaces) y
// sont placés par leurs variables, comme en production. Le courtier tourne sur
// le Node du runner de test (D5 est prouvé ailleurs).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobProcessScope, createSandbox, mxcBackend } from '../index';

const isWindows = process.platform === 'win32';

let home: string;
let dataDir: string;
let ws: string;
const saved: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  saved[k] = process.env[k];
  process.env[k] = v;
}

if (isWindows) {
  home = mkdtempSync(join(tmpdir(), 'nodal-deny-home-'));
  dataDir = join(home, '.nodalai');
  ws = join(dataDir, 'workspaces', 'ws1');
  const pg = join(dataDir, 'pg-data');
  for (const d of [ws, pg, join(dataDir, 'tool-cache'), join(dataDir, 'sandbox')])
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
  ? createSandbox(mxcBackend(undefined, 'closed', process.execPath), { log: () => {} })
  : undefined;
const status = sandbox ? await sandbox.status() : undefined;

afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe.runIf(isWindows && status?.state === 'available')(
  'a confined command cannot read Nodal’s data dir, but its workspace stays usable @cap:executer-une-commande/moteur (Windows, MXC)',
  () => {
    let out: Record<string, string>;
    beforeAll(async () => {
      const reader = join(ws, 'reader.cjs');
      writeFileSync(
        reader,
        `const fs=require('fs'),p=require('path');const [dataDir,ws,pg]=process.argv.slice(2);
const r={};const t=(l,f)=>{try{r[l]='OK:'+String(f()).slice(0,20)}catch(e){r[l]=e.code}};
t('secrets',()=>fs.readFileSync(p.join(dataDir,'secrets.key'),'utf8'));
t('config',()=>fs.readFileSync(p.join(dataDir,'config.json'),'utf8'));
t('pgdata',()=>fs.readFileSync(p.join(pg,'pg_hba.conf'),'utf8'));
t('list',()=>fs.readdirSync(dataDir).join(','));
t('readWs',()=>fs.readFileSync(p.join(ws,'in.txt'),'utf8'));
t('writeWs',()=>{fs.writeFileSync(p.join(ws,'out.txt'),'w');return 'written'});
process.stdout.write('RESULT '+JSON.stringify(r));`,
      );
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
      } finally {
        await scope.close();
      }
    }, 60_000);

    it('secrets.key, config.json and pg-data are refused, and the data dir cannot be listed', () => {
      expect(out.secrets, JSON.stringify(out)).toBe('EPERM');
      expect(out.config).toBe('EPERM');
      expect(out.pgdata).toBe('EPERM');
      expect(out.list).toBe('EPERM');
    });

    it('the workspace is readable and writable', () => {
      expect(out.readWs).toBe('OK:ws-content');
      expect(out.writeWs).toBe('OK:written');
    });
  },
);
