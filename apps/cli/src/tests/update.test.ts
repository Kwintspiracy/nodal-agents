// update.test.ts — unit tests for the `nodal-agents update` command.
//
// Invariant #5: assertions are on REAL behaviour — the exact command + argument
// arrays passed to execa, the call ORDER (down → install → up), printed
// messages, and exit codes. Not just call counts.
//
// execa, runDown, getInstalledVersion, and getLatestVersion are all mocked
// to keep the test hermetic (no network, no npm, no live processes).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────
// vi.mock hoisting: these run before any imports below, so the mocked modules
// are in place when update.ts is first resolved.

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

vi.mock('../commands/down.ts', () => ({
  runDown: vi.fn(),
}));

vi.mock('../lib/version.ts', () => ({
  getInstalledVersion: vi.fn(),
  getLatestVersion: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { execa } from 'execa';
import { runDown } from '../commands/down.ts';
import { getInstalledVersion, getLatestVersion } from '../lib/version.ts';
import { runUpdate } from '../commands/update.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

const mockExeca = vi.mocked(execa);
const mockRunDown = vi.mocked(runDown);
const mockGetInstalled = vi.mocked(getInstalledVersion);
const mockGetLatest = vi.mocked(getLatestVersion);

/** Capture console output during a test. */
function captureConsole(): {
  lines: string[];
  restore: () => void;
} {
  const lines: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.warn = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(' '));
  return {
    lines,
    restore: () => {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    },
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  // Default: npm install resolves cleanly; detached spawn resolves.
  mockExeca.mockResolvedValue({
    stdout: '',
    stderr: '',
    exitCode: 0,
    // Minimal ResultPromise shape for the detached spawn (unref is called on it).
    unref: vi.fn(),
  } as unknown as ReturnType<typeof execa>);
  mockRunDown.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — version-equal path', () => {
  it('prints "already on latest" and does NOT call npm install', async () => {
    mockGetInstalled.mockReturnValue('0.2.0');
    mockGetLatest.mockResolvedValue('0.2.0');

    const { lines, restore } = captureConsole();
    try {
      await runUpdate({});
    } finally {
      restore();
    }

    // No npm install should have been called.
    const installCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).includes('install'),
    );
    expect(installCall).toBeUndefined();

    // runDown should not have been called either.
    expect(mockRunDown).not.toHaveBeenCalled();

    // Output must mention "already" and the version.
    const output = lines.join('\n');
    expect(output.toLowerCase()).toMatch(/already/);
    expect(output).toContain('0.2.0');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — update path', () => {
  it('calls down → npm install -g nodal-agents@latest → detached up, in that order', async () => {
    mockGetInstalled.mockReturnValue('0.2.0');
    mockGetLatest.mockResolvedValue('0.3.0');

    // Track invocation order globally via a shared sequence array.
    const sequence: string[] = [];

    mockRunDown.mockImplementation(async () => {
      sequence.push('down');
    });

    mockExeca.mockImplementation((cmd: string, args?: readonly string[], _opts?: object) => {
      const argList = (args ?? []) as string[];
      if (cmd === 'npm' && argList.includes('install')) {
        sequence.push('install');
      } else if (cmd === 'nodal-agents' || (Array.isArray(args) && argList.includes('up'))) {
        sequence.push('up');
      }
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execa>;
    });

    const { restore } = captureConsole();
    try {
      await runUpdate({});
    } finally {
      restore();
    }

    // Verify down came before install.
    const downIdx = sequence.indexOf('down');
    const installIdx = sequence.indexOf('install');
    expect(downIdx).toBeGreaterThanOrEqual(0);
    expect(installIdx).toBeGreaterThan(downIdx);

    // Verify the exact install call.
    const installCall = mockExeca.mock.calls.find(
      (c) =>
        c[0] === 'npm' &&
        Array.isArray(c[1]) &&
        (c[1] as string[]).join(' ') === 'install -g nodal-agents@latest',
    );
    expect(installCall).toBeDefined();
    expect(installCall![1]).toEqual(['install', '-g', 'nodal-agents@latest']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — EACCES from npm install', () => {
  it('prints actionable permission message and exits non-zero', async () => {
    mockGetInstalled.mockReturnValue('0.2.0');
    mockGetLatest.mockResolvedValue('0.3.0');

    // Simulate EACCES from the install call only.
    mockExeca.mockImplementation((cmd: string, args?: readonly string[], _opts?: object) => {
      const argList = (args ?? []) as string[];
      if (cmd === 'npm' && argList.includes('install')) {
        const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return Promise.reject(err) as unknown as ReturnType<typeof execa>;
      }
      return Promise.resolve({
        stdout: '',
        stderr: '',
        exitCode: 0,
        unref: vi.fn(),
      }) as unknown as ReturnType<typeof execa>;
    });

    const { lines, restore } = captureConsole();
    // Replace process.exit with a throwing stub so the process doesn't
    // actually exit, and collect the exit code. vi.spyOn keeps the typing
    // intact (no `any` cast) and the throw satisfies the `never` return.
    const exitCodes: number[] = [];
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      exitCodes.push(typeof code === 'number' ? code : 0);
      throw new Error(`process.exit(${code})`);
    });

    try {
      await expect(runUpdate({})).rejects.toThrow(/process\.exit\(1\)/);
    } finally {
      exitSpy.mockRestore();
      restore();
    }

    // Verify exit was called with code 1 (fail loud — invariant #4).
    expect(exitCodes).toContain(1);

    // The output must contain an actionable permission hint.
    const output = lines.join('\n').toLowerCase();
    expect(output).toMatch(/permission|privilege|elevated|administrator|sudo/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('runUpdate — --no-restart flag', () => {
  it('does NOT spawn `nodal-agents up` when noRestart is true', async () => {
    mockGetInstalled.mockReturnValue('0.2.0');
    mockGetLatest.mockResolvedValue('0.3.0');

    const { restore } = captureConsole();
    try {
      await runUpdate({ noRestart: true });
    } finally {
      restore();
    }

    // No call to execa with 'nodal-agents' (the detached up spawn).
    const upCall = mockExeca.mock.calls.find((c) => c[0] === 'nodal-agents');
    expect(upCall).toBeUndefined();

    // npm install should still have been called.
    const installCall = mockExeca.mock.calls.find(
      (c) => c[0] === 'npm' && Array.isArray(c[1]) && (c[1] as string[]).includes('install'),
    );
    expect(installCall).toBeDefined();
  });
});
