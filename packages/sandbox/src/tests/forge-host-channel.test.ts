// forge-host-channel.test.ts — le canal hôte↔runner (les flux standard de
// l'hôte, relayés par le courtier) ne peut pas être FORGÉ depuis l'intérieur
// du conteneur du job (#628, Reviewer A passe 2).
//
// La menace : une commande confinée, ou un processus d'arrière-plan laissé en
// vie jusqu'à la fin du job (décision « option A » de Quentin), est un enfant
// de l'hôte. Si elle pouvait écrire une ligne sur la sortie standard de
// l'hôte, elle forgerait `{"id":N,"exit":0}` pendant que la commande N tourne
// — un FAUX VERT à la preuve. Le seul chemin est OpenProcess(hôte,
// PROCESS_DUP_HANDLE) puis DuplicateHandle de son tuyau de sortie.
//
// Ce test PROUVE que MXC (AppContainer, palier base-container) le bloque : une
// commande VICTIME (id 1) dort puis sort avec un code NON nul ; pendant
// qu'elle tourne, une commande ATTAQUANTE (id 2) tente la duplication de
// handle et écrit `{"id":1,"exit":0}` dans tout tuyau qu'elle a pu dupliquer.
// La victime doit garder son vrai code et sa vraie durée. Si le blocage
// disparaît un jour (la victime résolue tôt en 0), ce test rougit.
//
// Le « fixture » attaquant est écrit sur le disque et lu par la commande
// confinée (la lecture reste ouverte). Ce n'est pas un outil d'attaque livré :
// il ne cible que l'hôte de SON job et n'écrit qu'une ligne du protocole.

import { describe, it, expect, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { JobProcessScope, createSandbox, mxcBackend } from '../index';

const isWindows = process.platform === 'win32';
// Le vrai backend, pour que l'attaquant soit un enfant du vrai hôte. La
// politique de boucle locale n'entre pas en jeu : `available` sur les deux
// builds base-container (avec ou sans limits).
// Le courtier tourne sur le Node du runner de test (D5 prouvé ailleurs).
const sandbox = isWindows
  ? createSandbox(mxcBackend(undefined, undefined, process.execPath), { log: () => {} })
  : undefined;
const status = sandbox ? await sandbox.status() : undefined;

// koffi est une dépendance du SDK MXC : on le résout depuis lui, sur les deux
// machines, sans l'ajouter aux dépendances du dépôt.
function koffiPath(): string {
  const sdk = createRequire(import.meta.url).resolve('@microsoft/mxc-sdk/v1');
  let dir = dirname(sdk);
  for (let i = 0; i < 8; i++) {
    try {
      return createRequire(join(dir, 'x.js')).resolve('koffi');
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error('koffi not resolvable from the MXC SDK');
}

const ATTACKER = `'use strict';
// Tente le forge : OpenProcess(parent=hôte, DUP_HANDLE), puis duplication de
// tout handle (les tuyaux inclus) et écriture de la ligne forgée. Imprime UN
// fait, puis sort. argv[2]=koffi, argv[3]=ligne forgée.
const koffi = require(process.argv[2]);
const forged = process.argv[3];
const k = koffi.load('kernel32.dll');
const OpenProcess = k.func('__stdcall','OpenProcess','void*',['uint32','bool','uint32']);
const DuplicateHandle = k.func('__stdcall','DuplicateHandle','bool',['void*','void*','void*','void**','uint32','bool','uint32']);
const GetCurrentProcess = k.func('__stdcall','GetCurrentProcess','void*',[]);
const GetFileType = k.func('__stdcall','GetFileType','uint32',['void*']);
const WriteFile = k.func('__stdcall','WriteFile','bool',['void*','void*','uint32','uint32*','void*']);
const CloseHandle = k.func('__stdcall','CloseHandle','bool',['void*']);
const me = GetCurrentProcess();
const hDup = OpenProcess(0x0040, false, process.ppid);
let pipes = 0, wrote = false;
if (hDup) {
  const data = Buffer.from(forged, 'utf8');
  for (let hv = 4; hv <= 65536; hv += 4) {
    const target = [null];
    if (!DuplicateHandle(hDup, hv, me, target, 0, false, 0x0002) || !target[0]) continue;
    if (GetFileType(target[0]) === 3) { pipes++; const w=[0]; if (WriteFile(target[0], data, data.length, w, null) && w[0] > 0) wrote = true; }
    CloseHandle(target[0]);
  }
}
process.stdout.write('ATTACKER ' + JSON.stringify({ openedHost: !!hDup, pipesDuplicated: pipes, forgedWrite: wrote }) + '\\n');
`;

const dir = isWindows ? mkdtempSync(join(tmpdir(), 'nodal-forge-')) : '';
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe.runIf(isWindows && status?.state === 'available')(
  'the host channel cannot be forged from inside the job container @cap:executer-une-commande/moteur (Windows, MXC base-container)',
  () => {
    it('a confined command cannot forge a running command’s result: the victim keeps its real exit code and duration', async () => {
      const koffi = koffiPath();
      const attackerPath = join(dir, 'attacker.cjs');
      writeFileSync(attackerPath, ATTACKER);
      const node = process.execPath;
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
      const scope = new JobProcessScope('forge-test-job', sandbox!);
      try {
        const container = await scope.container([dir], env);
        // VICTIME = id 1 (nextId part de 0, ++ avant usage). 6 s, puis exit 3.
        const victim = await container.start({
          target: { file: node, args: ['-e', 'setTimeout(() => process.exit(3), 6000)'] },
          cwd: dir,
          env,
        });
        const t0 = Date.now();
        let victimEnd: { kind: string; exitCode?: number } | undefined;
        const victimDone = victim.done.then((e) => {
          victimEnd = e as typeof victimEnd;
        });
        await new Promise((r) => setTimeout(r, 1000));
        // ATTAQUANTE = id 2 : forge le résultat de la commande 1.
        const atk = await container.start({
          target: { file: node, args: [attackerPath, koffi, '{"id":1,"exit":0}\\n'] },
          cwd: dir,
          env,
        });
        let atkOut = '';
        atk.stdout?.on('data', (d: Buffer) => (atkOut += String(d)));
        atk.stderr?.on('data', (d: Buffer) => (atkOut += String(d)));
        const atkEnd = await atk.done;

        // L'attaquante a bien TENTÉ (sinon le test passerait pour rien).
        expect(atkEnd.kind, atkOut).toBe('exit');
        const facts = JSON.parse(/ATTACKER (\{.*\})/.exec(atkOut)?.[1] ?? '{}') as {
          openedHost?: boolean;
          forgedWrite?: boolean;
        };
        expect(facts, atkOut).toHaveProperty('openedHost');

        await Promise.race([victimDone, new Promise((r) => setTimeout(r, 8000))]);
        const dt = Date.now() - t0;
        // Le blocage tient : la victime a gardé son vrai code (3) et sa vraie
        // durée (pas résolue tôt en 0). Un forge réussi l'aurait close en 0,
        // tout de suite.
        expect(facts.forgedWrite, `forged write reached a pipe: ${atkOut}`).not.toBe(true);
        expect(victimEnd, 'the victim never resolved').toBeDefined();
        expect(victimEnd?.exitCode).toBe(3);
        expect(dt).toBeGreaterThan(5000);
      } finally {
        await scope.close();
      }
    }, 40_000);
  },
);
