// machine-trace.test.mjs — la trace dit ce que fait la machine, avec ses vrais chiffres.
//
// Pourquoi (#748) : le job `e2e-smoke` perdait son runner sans laisser de quoi
// dire pourquoi. La trace est la preuve qu'on lira le jour où ça recommence :
// une valeur mal lue (un nom de processus avec des parenthèses, un CPU compté
// à zéro pour un processus né entre deux relevés) y mentirait au pire moment.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseMeminfo,
  parseVmstat,
  parsePressure,
  parseProcStat,
  etiquette,
  regrouper,
  ligne,
  bilan,
} from '../lib/machine-trace.mjs';

const GO = 1024 ** 3;

const MEMINFO = `MemTotal:       16374712 kB
MemFree:         1203316 kB
MemAvailable:    9437184 kB
Buffers:          123456 kB
SwapTotal:       4194300 kB
SwapFree:        3145724 kB
`;

describe('parseMeminfo', () => {
  it('reads total, available and swap in bytes', () => {
    expect(parseMeminfo(MEMINFO)).toEqual({
      total: 16374712 * 1024,
      disponible: 9437184 * 1024,
      swapTotal: 4194300 * 1024,
      swapLibre: 3145724 * 1024,
    });
  });
  it('refuses a meminfo without MemAvailable instead of reporting zero', () => {
    expect(() => parseMeminfo('MemTotal: 1 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n')).toThrow(
      /MemAvailable/,
    );
  });
});

describe('parseVmstat', () => {
  it('reads the swap, major fault and OOM counters', () => {
    const t = 'nr_free_pages 1\npswpin 12\npswpout 340\npgmajfault 77\noom_kill 2\n';
    expect(parseVmstat(t)).toEqual({ pswpin: 12, pswpout: 340, pgmajfault: 77, oomKill: 2 });
  });
  it('refuses a vmstat without oom_kill', () => {
    expect(() => parseVmstat('pswpin 1\npswpout 1\npgmajfault 1\n')).toThrow(/oom_kill/);
  });
});

describe('parsePressure', () => {
  it('reads avg10 of some and full', () => {
    const t =
      'some avg10=12.50 avg60=3.00 avg300=1.00 total=123\nfull avg10=4.25 avg60=1.00 avg300=0.10 total=45\n';
    expect(parsePressure(t)).toEqual({ some: 12.5, full: 4.25 });
  });
  it('gives full as null, not zero, when the kernel has no full line', () => {
    expect(parsePressure('some avg10=0.30 avg60=0.10 avg300=0.00 total=9\n')).toEqual({
      some: 0.3,
      full: null,
    });
  });
});

describe('parseProcStat', () => {
  // Champs réels de proc(5) : pid (comm) state ppid pgrp session tty tpgid flags
  // minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
  // num_threads itrealvalue starttime vsize rss …
  const stat = (comm) =>
    `4242 (${comm}) S 4100 4100 4100 0 -1 4194560 1000 0 5 0 700 300 0 0 20 0 11 0 12345 987654321 51200 18446744073709551615`;

  it('reads pid, parent, CPU ticks and RSS pages', () => {
    expect(parseProcStat(stat('postgres'))).toEqual({
      pid: 4242,
      nom: 'postgres',
      ppid: 4100,
      tics: 1000,
      rssPages: 51200,
    });
  });
  it('cuts at the LAST parenthesis: Next renames itself "next-server (v16.3.0)"', () => {
    const p = parseProcStat(stat('next-server (v1'));
    expect(p.nom).toBe('next-server (v1');
    expect(p.ppid).toBe(4100);
    expect(p.rssPages).toBe(51200);
    const q = parseProcStat(stat('a) b (c'));
    expect(q.nom).toBe('a) b (c');
    expect(q.tics).toBe(1000);
  });
});

describe('etiquette', () => {
  it('shortens the name Next gives itself', () => {
    expect(etiquette('next-server (v1')).toBe('next-server');
  });
  it('keeps a specific name as is', () => {
    expect(etiquette('chrome', ['/opt/chrome', '--type=renderer'])).toBe('chrome');
    expect(etiquette('postgres')).toBe('postgres');
  });
  it('names a node process by the package of the repository it runs', () => {
    const runner = ['node', '--require', '/w/node_modules/tsx/dist/preflight.cjs', 'src/index.ts'];
    expect(
      etiquette('node', runner, '/home/runner/work/nodal-agents/nodal-agents/apps/runner'),
    ).toBe('node:apps/runner');
    expect(etiquette('node', ['node', '/w/apps/cli/node_modules/.bin/tsx', 'src/index.ts'])).toBe(
      'node:apps/cli',
    );
  });
  it('names the Playwright test runner, then falls back to the script name', () => {
    expect(etiquette('node', ['node', '/w/node_modules/@playwright/test/cli.js', 'test'])).toBe(
      'node:playwright',
    );
    expect(etiquette('node', ['node', '--max-old-space-size=4096', '/tmp/x/hog.mjs'])).toBe(
      'node:hog.mjs',
    );
  });
});

describe('regrouper', () => {
  const p = (pid, etiquette, tics, rssPages) => ({ pid, etiquette, tics, rssPages });

  it('sums RSS per label and computes CPU from the ticks between two samples', () => {
    const avant = [p(1, 'chrome', 100, 0), p(2, 'chrome', 50, 0), p(3, 'postgres', 10, 0)];
    const apres = [p(1, 'chrome', 300, 1000), p(2, 'chrome', 150, 500), p(3, 'postgres', 10, 2000)];
    const g = regrouper(avant, apres, 2, 100, 4096);
    const chrome = g.find((x) => x.etiquette === 'chrome');
    // (200 + 100) tics en 2 s à 100 tics/s = 150 %
    expect(chrome).toEqual({ etiquette: 'chrome', n: 2, rss: 1500 * 4096, cpu: 150 });
    expect(g.find((x) => x.etiquette === 'postgres').cpu).toBe(0);
  });
  it('counts ALL the CPU of a process born between two samples', () => {
    const g = regrouper(
      [p(1, 'x', 0, 0)],
      [p(1, 'x', 0, 1), p(9, 'next-server', 400, 1)],
      2,
      100,
      4096,
    );
    expect(g.find((x) => x.etiquette === 'next-server').cpu).toBe(200);
  });
  it('has no CPU figure on the first sample', () => {
    const g = regrouper(null, [p(1, 'x', 500, 1)], 0, 100, 4096);
    expect(g[0].cpu).toBeNull();
  });
});

const releve = ({ dispoGo, swapGo = 0, oom = 0, groupes, depuisSec = 0, psiMem = 0 }) => ({
  depuisSec,
  mem: {
    total: 16 * GO,
    disponible: dispoGo * GO,
    swapTotal: 4 * GO,
    swapLibre: (4 - swapGo) * GO,
  },
  debits: { swapIn: 0, swapOut: 120, majflt: 3, oomKill: oom },
  psi: {
    mem: { some: psiMem, full: 0 },
    io: { some: 1.5, full: 0.5 },
    cpu: { some: 20, full: null },
  },
  charge: '3.10 2.00 1.00',
  disqueLibre: 20 * GO,
  groupes,
});

describe('ligne', () => {
  it('puts memory, swap, pressure, OOM and the heaviest processes on one line', () => {
    const l = ligne(
      releve({
        dispoGo: 6,
        swapGo: 1,
        oom: 1,
        groupes: [
          { etiquette: 'next-server', n: 1, rss: 3 * GO, cpu: 180 },
          { etiquette: 'chrome', n: 7, rss: 1.5 * GO, cpu: 40 },
          { etiquette: 'bash', n: 3, rss: 0.01 * GO, cpu: 0 },
        ],
      }),
      { depuisSec: 65, heure: '06:07:46' },
    );
    expect(l).toBe(
      '[machine 06:07:46 +65s] mem used 10.0G avail 6.0G swap 1.0G' +
        ' | swap in/out 0/120 pg/s majflt 3/s oom_kill +1' +
        ' | psi some/full mem 0.0/0.0 io 1.5/0.5 cpu 20.0/-' +
        ' | load 3.10 2.00 1.00 | disk free 20.0G' +
        ' | top mem: next-server 3.0G, chrome(7) 1.5G, bash(3) 0.0G' +
        ' | top cpu: next-server 180%, chrome(7) 40%',
    );
  });
  it('says the first sample has no CPU figure rather than "none"', () => {
    const l = ligne(
      releve({ dispoGo: 8, groupes: [{ etiquette: 'x', n: 1, rss: GO, cpu: null }] }),
      {
        depuisSec: 0,
        heure: '00:00:00',
      },
    );
    expect(l).toMatch(/top cpu: n\/a \(first sample\)$/);
  });
});

describe('bilan', () => {
  it('reports the peak, when it happened, the OOM kills and the heaviest processes', () => {
    const b = bilan([
      releve({
        dispoGo: 10,
        depuisSec: 0,
        groupes: [{ etiquette: 'next-server', n: 1, rss: 2 * GO, cpu: 0 }],
      }),
      releve({
        dispoGo: 3,
        swapGo: 2,
        oom: 1,
        psiMem: 35.5,
        depuisSec: 95,
        groupes: [
          { etiquette: 'next-server', n: 1, rss: 7 * GO, cpu: 0 },
          { etiquette: 'chrome', n: 6, rss: 2 * GO, cpu: 0 },
        ],
      }),
      releve({
        dispoGo: 9,
        depuisSec: 100,
        groupes: [{ etiquette: 'next-server', n: 1, rss: 1 * GO, cpu: 0 }],
      }),
    ]);
    expect(b).toBe(
      '[machine] summary: 3 samples; peak used 13.0G of 16.0G (min avail 3.0G at +95s); peak swap 2.0G;' +
        ' peak psi mem some 35.5%; oom kills 1; peak per process: next-server 7.0G, chrome 2.0G',
    );
  });
});

describe.runIf(process.platform === 'linux')('machine-trace.mjs on this machine', () => {
  let dir;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it('samples while the command runs, keeps its exit code, and sees the process that holds memory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'machine-trace-'));
    const hog = join(dir, 'hog.mjs');
    // 400 Mo réellement écrits (une page non touchée n'est pas dans la RSS).
    writeFileSync(
      hog,
      'const b = Buffer.alloc(400 * 1024 * 1024, 1); setTimeout(() => { b[0]; process.exit(3); }, 3500);\n',
    );
    const out = join(dir, 'trace.log');
    const { code, stdout } = await new Promise((resolve) => {
      execFile(
        process.execPath,
        ['scripts/machine-trace.mjs', '--out', out, '--every', '1', '--', process.execPath, hog],
        { encoding: 'utf8' },
        (err, stdout) => resolve({ code: err ? err.code : 0, stdout }),
      );
    });
    expect(code).toBe(3);
    const fichier = readFileSync(out, 'utf8');
    // Le fichier et la sortie de l'étape portent les mêmes lignes.
    expect(stdout).toBe(fichier);
    expect(fichier).toMatch(/^\[machine\] host: vendor "/m);
    const relevés = fichier
      .split('\n')
      .filter((l) => /^\[machine \d\d:\d\d:\d\d \+\d+s\] mem used /.test(l));
    expect(relevés.length).toBeGreaterThanOrEqual(3);
    // Un relevé pendant que hog tient sa mémoire le nomme, avec au moins 0.4G.
    const tenu = relevés.find((l) => /top mem: [^|]*node:hog\.mjs 0\.[4-9]G/.test(l));
    expect(tenu, relevés.join('\n')).toBeDefined();
    expect(fichier).toMatch(/^\[machine\] summary: \d+ samples; peak used /m);
    expect(fichier).toMatch(/^\[machine\] command ended \(exit 3\) after \d+s$/m);
  }, 30_000);
});
