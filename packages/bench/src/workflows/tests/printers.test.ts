// printers.test.ts — le besoin `no-real-printer` et sa sonde (#794, #842).
//
// Règle du propriétaire : un essai du banc n'imprime jamais sur une vraie
// imprimante. Le besoin est là quand la sonde a compté ZÉRO imprimante qu'une
// commande d'agent puisse joindre ; fermé par défaut, il manque quand elle en
// compte, quand elle n'a pas pu compter, et quand elle n'a pas tourné. La
// vraie sonde passe par le vrai `run_command` : sous Windows, elle est jouée
// pour de bon (elle ne fait que compter, elle n'imprime rien).

import { describe, expect, it } from 'vitest';
import { instanceSandbox } from '@nodal-agents/sandbox';
import { instanceSandboxEnv } from '../../campaign/instance';
import { missingNeeds, needReport, noRealPrinterReason } from '../needs';
import { PRINTER_PROBE_COMMAND, probeReachablePrinters, readProbeOutput } from '../printers';
import type { PrinterReach, ScenarioEnv } from '../types';

const env = (reachablePrinters: PrinterReach): ScenarioEnv => ({
  workspaceRoots: [],
  teamTools: [],
  unlistedMcpServers: [],
  benchPrinter: { kind: 'absent' },
  reachablePrinters,
  teamMcpServers: [],
  services: {},
  startedMs: 0,
});

describe('the no-real-printer need', () => {
  it('is met when the probe counted no printer, confined or not', () => {
    expect(noRealPrinterReason(env({ kind: 'counted', count: 0, confined: true }))).toBeNull();
    expect(noRealPrinterReason(env({ kind: 'counted', count: 0, confined: false }))).toBeNull();
    expect(
      missingNeeds(['no-real-printer'], env({ kind: 'counted', count: 0, confined: true })),
    ).toEqual([]);
  });

  it('is missing, with the count and the issue, when the probe counted printers', () => {
    expect(
      missingNeeds(['no-real-printer'], env({ kind: 'counted', count: 6, confined: true })),
    ).toEqual(["a real printer is reachable from the instance's commands: 6 printer(s); see #842"]);
    expect(noRealPrinterReason(env({ kind: 'counted', count: 1, confined: false }))).toBe(
      "a real printer is reachable from the instance's commands: 1 printer(s); see #842",
    );
  });

  it('is missing when the probe could not count, and says why', () => {
    expect(
      noRealPrinterReason(env({ kind: 'failed', reason: 'the probe could not run: no shell' })),
    ).toBe(
      "the bench could not count the printers the instance's commands can reach (the probe could not run: no shell): print trials never run where a real printer might be reachable; see #842",
    );
  });

  it('is missing when the probe did not run: never green by absence', () => {
    expect(noRealPrinterReason(env({ kind: 'not-probed' }))).toBe(
      "the bench did not count the printers the instance's commands can reach: print trials never run where a real printer might be reachable; see #842",
    );
    // Bench Studio lists it like every other need.
    expect(
      needReport(env({ kind: 'not-probed' })).find((n) => n.need === 'no-real-printer'),
    ).toMatchObject({ missing: expect.stringContaining('did not count') as unknown as string });
  });
});

describe('readProbeOutput: a number, or why there is none', () => {
  const out = (o: Partial<Parameters<typeof readProbeOutput>[0]>) =>
    readProbeOutput({ exitCode: 0, stdout: '', stderr: '', timedOut: false, ...o });

  it('reads the last line as the count, and says whether the command ran confined', () => {
    expect(out({ stdout: '6\r\n', sandbox: { confined: true } })).toEqual({
      kind: 'counted',
      count: 6,
      confined: true,
    });
    // `wc -l` pads with spaces on macOS; a warning line before the number.
    expect(out({ stdout: 'warning: x\n       0\n' })).toEqual({
      kind: 'counted',
      count: 0,
      confined: false,
    });
  });

  it('anything else is a failure, never a zero', () => {
    for (const o of [
      { stdout: '' },
      { stdout: 'two' },
      { stdout: '3', exitCode: 1 },
      { stdout: '0', exitCode: null, timedOut: true },
      { stdout: '-1' },
    ]) {
      expect(out(o).kind).toBe('failed');
    }
    expect(out({ exitCode: 3, stderr: 'a CUPS socket is there but lpstat is missing' })).toEqual({
      kind: 'failed',
      reason:
        'the probe did not return a number (exit 3, output ""; a CUPS socket is there but lpstat is missing)',
    });
  });

  it('the probe commands only list: no print verb, no printer name written', () => {
    for (const c of Object.values(PRINTER_PROBE_COMMAND)) {
      expect(c).not.toMatch(/Out-Printer|print\.exe|-Verb\s+Print|\blp\b|\blpr\b/i);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('the real probe, on Windows', () => {
  it('runs through the real run_command and returns a number', { timeout: 180_000 }, async () => {
    // The sandbox a campaign's runner opens: its ports (here a campaign's
    // defaults, nothing listens on them). Where the machine has no sandbox
    // (GitHub's Windows Server runner), the command runs unconfined and says so.
    // The bench's own process carries no Nodal ports (the test setup sets
    // some): they are taken away, so only the instance's can reach the sandbox.
    const saved = Object.fromEntries(
      ['PORT', 'WEB_PORT', 'DATABASE_URL'].map((k) => [k, process.env[k]]),
    );
    for (const k of Object.keys(saved)) delete process.env[k];
    let r: PrinterReach;
    let status: Awaited<ReturnType<ReturnType<typeof instanceSandbox>['status']>>;
    try {
      const sandbox = instanceSandbox(
        instanceSandboxEnv({ web: 3100, runner: 3101, postgres: 25532 }),
      );
      r = await probeReachablePrinters({ sandbox, platform: 'win32' });
      status = await sandbox.status();
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
    }
    // The instance's ports reached the sandbox: never "Nodal's ports unknown".
    if (status.state === 'unavailable') expect(status.code).not.toBe('SANDBOX_NODAL_PORTS_UNKNOWN');
    if (r.kind === 'counted') expect(r.confined).toBe(status.state === 'available');
    expect(r.kind).toBe('counted');
    if (r.kind === 'counted') {
      expect(Number.isInteger(r.count)).toBe(true);
      expect(r.count).toBeGreaterThanOrEqual(0);
    }
  });
});
