// sandbox-proxy-windows.test.ts — le RÉGIME RÉSEAU du produit (#628, D2),
// éprouvé à travers le vrai backend MXC sous la valeur PRODUIT `proxy`.
//
// Ce que ça prouve, bout en bout : une commande confinée joint un service
// tiers local (un faux ComfyUI sur 127.0.0.1) et un serveur qu'une AUTRE
// commande du même job a lancé, PAR LE PROXY ; elle NE joint PAS les ports de
// Nodal (refusés par le proxy) ; un client NON-HTTP (TCP brut) vers un service
// local n'a pas de route — la limite nommée du régime.
//
// Windows seulement, et SOUS LE PROXY : sur un build où le proxy n'est pas
// joignable (windows-11-arm 9457), le bac à sable est indisponible et toute
// cette suite se saute. Elle est donc prouvée sur une machine où le proxy
// répond (celle de Quentin, 9711, via release:check). Le MUR DES FICHIERS, lui,
// est prouvé sous `deny-all` partout (sandbox-confinement-windows.test.ts).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JobProcessScope, createSandbox, mxcBackend, type JobContainer } from '../index';

const isWindows = process.platform === 'win32';

let comfy: Server;
let nodal: Server;
let rawServer: NetServer;
let comfyPort = 0;
let nodalPort = 0;
let rawPort = 0;
let ws = '';
const savedEnv: Record<string, string | undefined> = {
  PORT: process.env['PORT'],
  WEB_PORT: process.env['WEB_PORT'],
  DATABASE_URL: process.env['DATABASE_URL'],
};

if (isWindows) {
  ws = mkdtempSync(join(tmpdir(), 'nodal-proxy-'));
  comfy = createServer((_q, r) => r.end('comfy-ok'));
  comfy.listen(0, '127.0.0.1');
  nodal = createServer((_q, r) => r.end('NODAL-SECRET'));
  nodal.listen(0, '127.0.0.1');
  rawServer = createNetServer((s) => s.end('raw-ok'));
  rawServer.listen(0, '127.0.0.1');
}

// Le vrai backend sous `proxy` ; le courtier sur le Node du runner de test.
const sandbox = isWindows
  ? createSandbox(mxcBackend(undefined, 'proxy'), { log: () => {} })
  : undefined;

let status: Awaited<ReturnType<NonNullable<typeof sandbox>['status']>> | undefined;

// `once(server, 'listening')` ne résout jamais si le serveur écoute DÉJÀ (ils
// appellent `.listen()` au chargement du module) : on attend donc seulement
// s'il n'écoute pas encore.
const listening = (s: Server | NetServer): Promise<unknown> =>
  s.listening ? Promise.resolve() : once(s, 'listening');

async function setup(): Promise<void> {
  await Promise.all([listening(comfy), listening(nodal), listening(rawServer)]);
  comfyPort = (comfy.address() as { port: number }).port;
  nodalPort = (nodal.address() as { port: number }).port;
  rawPort = (rawServer.address() as { port: number }).port;
  // Les ports de Nodal que le proxy doit refuser, lus de l'env par le backend
  // (nodalDeniedEndpoints). Le port runner = le faux serveur « nodal » ; le web
  // et le Postgres sont des ports à part (non joints par le test).
  process.env['PORT'] = String(nodalPort);
  process.env['WEB_PORT'] = String(nodalPort + 1);
  process.env['DATABASE_URL'] = `postgres://u@127.0.0.1:${nodalPort + 2}/db`;
  status = await sandbox!.status();
}

if (isWindows) beforeAll(setup, 120_000);

afterAll(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  comfy?.close();
  nodal?.close();
  rawServer?.close();
  if (ws) {
    try {
      rmSync(ws, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* laissé au nettoyage de l'OS */
    }
  }
});

// `runIf` est évalué à la collecte, avant beforeAll : on garde juste Windows,
// et on saute DANS le test si le proxy n'est pas joignable (9457).
describe.runIf(isWindows)(
  'sandbox network — the proxy regime: third-party local + internet yes, Nodal no @cap:executer-une-commande/moteur (Windows, proxy reachable)',
  () => {
    const env = (): Record<string, string | undefined> => {
      const e: Record<string, string | undefined> = {};
      for (const n of [
        'SYSTEMROOT',
        'WINDIR',
        'PATH',
        'COMSPEC',
        'LOCALAPPDATA',
        'USERPROFILE',
        'PATHEXT',
      ])
        e[n] = process.env[n];
      return e;
    };
    const unavailable = (): boolean => status?.state !== 'available';

    // release:check (machine de l'owner) pose NODAL_SANDBOX_REQUIRE_PROXY=1 :
    // c'est le SEUL endroit où le filtrage proxy est prouvé, donc la suite doit
    // y TOURNER, pas se sauter. Si le proxy y devenait injoignable, ce test
    // rougit au lieu de laisser release:check vert sans rien prouver (#628,
    // P2-5). La CI 9457 ne pose pas le drapeau : là, les cas ci-dessous se
    // sautent et windows-mxc.test.ts affirme l'indisponibilité codée.
    it('the proxy regime is actually exercised where release:check requires it', () => {
      if (process.env['NODAL_SANDBOX_REQUIRE_PROXY'] !== '1') return;
      expect(status, JSON.stringify(status)).toMatchObject({ state: 'available' });
    });

    async function once_(container: JobContainer, command: string): Promise<string> {
      const p = await container.start({ target: { command }, cwd: ws, env: env() });
      let out = '';
      p.stdout?.on('data', (d: Buffer) => (out += String(d)));
      p.stderr?.on('data', (d: Buffer) => (out += String(d)));
      await p.done;
      return out;
    }

    it('a confined command reaches ComfyUI but not a Nodal port, and raw TCP has no route', async () => {
      if (unavailable()) {
        expect(status).toMatchObject({ code: 'SANDBOX_PROXY_UNREACHABLE' });
        return;
      }
      const node = process.execPath;
      const script = join(ws, 'client.cjs');
      writeFileSync(
        script,
        `const [comfy, nodal, raw] = process.argv.slice(2).map(Number);
const out = {};
const http = (port) => new Promise((r) => { const q = require('http').get('http://127.0.0.1:' + port + '/', (res) => { let b=''; res.on('data', d=>b+=d); res.on('end', ()=>r(res.statusCode + ':' + b)); }); q.on('error', (e)=>r('ERR ' + e.code)); });
const rawTcp = (port) => new Promise((r) => { const s = require('net').connect(port, '127.0.0.1'); s.on('connect', ()=>{ s.end(); r('CONNECTED'); }); s.on('error', (e)=>r('ERR ' + e.code)); setTimeout(()=>{ s.destroy(); r('TIMEOUT'); }, 4000); });
(async () => {
  out.comfy = await http(comfy);
  out.nodal = await http(nodal);
  out.rawToComfy = await rawTcp(comfy);
  process.stdout.write('RES ' + JSON.stringify(out));
})();`,
      );
      const scope = new JobProcessScope('proxy-job-1', sandbox!);
      try {
        const container = await scope.container([ws], env());
        const out = await once_(
          container,
          `"${node}" "${script}" ${comfyPort} ${nodalPort} ${rawPort}`,
        );
        const res = JSON.parse(/RES (\{.*\})/.exec(out)?.[1] ?? '{}') as Record<string, string>;
        expect(res.comfy, out).toBe('200:comfy-ok');
        // Nodal : refusé par le proxy (403) ou injoignable — jamais le secret.
        expect(res.nodal, out).not.toContain('NODAL-SECRET');
        expect(
          res.nodal === '403:nodal endpoint refused by the sandbox' || res.nodal?.startsWith('ERR'),
          out,
        ).toBe(true);
        // TCP brut vers un service local : pas de route (la limite nommée).
        expect(res.rawToComfy, out).toMatch(/^ERR |^TIMEOUT/);
      } finally {
        await scope.close();
      }
    }, 120_000);

    it('a server one command starts is reached by the next command of the same job, through the proxy', async () => {
      if (unavailable()) return;
      const node = process.execPath;
      const serverInfo = join(ws, 'srv.json');
      writeFileSync(
        join(ws, 'srv.cjs'),
        `const fs=require('fs');const s=require('http').createServer((q,r)=>r.end('server-in-job'));s.listen(0,'127.0.0.1',()=>fs.writeFileSync(process.argv[2],String(s.address().port)));`,
      );
      writeFileSync(
        join(ws, 'wait.cjs'),
        `const fs=require('fs');const t=Date.now();(function p(){if(fs.existsSync(process.argv[2]))return;if(Date.now()-t>20000)process.exit(1);setTimeout(p,50)})();`,
      );
      writeFileSync(
        join(ws, 'get.cjs'),
        `require('http').get('http://127.0.0.1:'+process.argv[2]+'/',res=>{let b='';res.on('data',d=>b+=d);res.on('end',()=>process.stdout.write('GOT '+res.statusCode+':'+b))}).on('error',e=>process.stdout.write('GOT ERR '+e.code));`,
      );
      const scope = new JobProcessScope('proxy-job-2', sandbox!);
      try {
        const container = await scope.container([ws], env());
        await once_(
          container,
          `start "" /b "${node}" "${join(ws, 'srv.cjs')}" "${serverInfo}" && "${node}" "${join(ws, 'wait.cjs')}" "${serverInfo}"`,
        );
        const port = (await import('node:fs')).readFileSync(serverInfo, 'utf8').trim();
        const out = await once_(container, `"${node}" "${join(ws, 'get.cjs')}" ${port}`);
        expect(out, out).toContain('GOT 200:server-in-job');
      } finally {
        await scope.close();
      }
    }, 120_000);

    // Un FAIT nommé (limite SANDBOX_NETWORK_SHARED_LOOPBACK), pas un défaut :
    // la boucle locale de l'hôte est commune, donc un serveur qu'un job lance
    // est joignable par une commande d'un AUTRE job, par le même proxy que
    // ComfyUI. Le test le fixe, pour qu'un changement de ce fait se voie.
    it('a server one job starts is reached by a command of ANOTHER job, through the proxy (named limit)', async () => {
      if (unavailable()) return;
      expect(status?.state === 'available' && status.limits?.join('\n')).toMatch(
        /SANDBOX_NETWORK_SHARED_LOOPBACK/,
      );
      const node = process.execPath;
      const serverInfo = join(ws, 'srv-a.json');
      const jobA = new JobProcessScope('proxy-job-a', sandbox!);
      const jobB = new JobProcessScope('proxy-job-b', sandbox!);
      try {
        const a = await jobA.container([ws], env());
        await once_(
          a,
          `start "" /b "${node}" "${join(ws, 'srv.cjs')}" "${serverInfo}" && "${node}" "${join(ws, 'wait.cjs')}" "${serverInfo}"`,
        );
        const port = (await import('node:fs')).readFileSync(serverInfo, 'utf8').trim();
        const b = await jobB.container([ws], env());
        const out = await once_(b, `"${node}" "${join(ws, 'get.cjs')}" ${port}`);
        expect(out, out).toContain('GOT 200:server-in-job');
      } finally {
        await jobB.close();
        await jobA.close();
      }
    }, 120_000);
  },
);
