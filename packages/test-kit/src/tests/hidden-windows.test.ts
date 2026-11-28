// hidden-windows.test.ts — the options every process a test starts gets on
// Windows, and the installation that gives them (hidden-windows.ts).
import { describe, expect, it } from 'vitest';
import * as cpEsm from 'node:child_process';
import { createRequire } from 'node:module';
import { hideTestWindows, withHiddenWindow } from '../hidden-windows';

const cb = (): void => undefined;

describe('every process a test starts gets a hidden window, whatever form the call takes', () => {
  it.each([
    ['spawn', ['node'], ['node', { windowsHide: true }]],
    ['spawn', ['node', ['-v']], ['node', ['-v'], { windowsHide: true }]],
    ['spawn', ['node', ['-v'], { cwd: '/x' }], ['node', ['-v'], { cwd: '/x', windowsHide: true }]],
    ['spawn', ['node', { cwd: '/x' }], ['node', { cwd: '/x', windowsHide: true }]],
    ['spawnSync', ['git', ['status'], undefined], ['git', ['status'], { windowsHide: true }]],
    ['execFile', ['git', ['status'], cb], ['git', ['status'], { windowsHide: true }, cb]],
    ['execFile', ['git', cb], ['git', { windowsHide: true }, cb]],
    [
      'execFileSync',
      ['icacls', ['p'], { stdio: 'ignore' }],
      ['icacls', ['p'], { stdio: 'ignore', windowsHide: true }],
    ],
    ['fork', ['./w.js', [], { silent: true }], ['./w.js', [], { silent: true, windowsHide: true }]],
    ['exec', ['dir', cb], ['dir', { windowsHide: true }, cb]],
    ['exec', ['dir', { cwd: '/x' }, cb], ['dir', { cwd: '/x', windowsHide: true }, cb]],
    ['execSync', ['dir'], ['dir', { windowsHide: true }]],
  ] as const)('%s(%j)', (starter, given, expected) => {
    expect(withHiddenWindow(starter, given)).toEqual(expected);
  });

  it('a call that sets windowsHide itself keeps it, and the caller’s options are never changed', () => {
    const shown = { windowsHide: false };
    expect(withHiddenWindow('spawn', ['x', [], shown])).toEqual(['x', [], { windowsHide: false }]);
    const mine = { cwd: '/x' };
    withHiddenWindow('spawn', ['x', [], mine]);
    expect(mine).toEqual({ cwd: '/x' });
  });

  it('on Windows the test process runs with it installed, the ESM exports included; elsewhere nothing is touched', () => {
    const cp = createRequire(import.meta.url)('node:child_process') as Record<string, unknown>;
    const mark = Symbol.for('nodal.test-kit.hidden-windows');
    if (process.platform === 'win32') {
      for (const name of [
        'spawn',
        'spawnSync',
        'execFile',
        'execFileSync',
        'fork',
        'exec',
        'execSync',
      ]) {
        expect((cp[name] as Record<symbol, unknown>)[mark], name).toBe(true);
        expect((cpEsm as Record<string, unknown>)[name], name).toBe(cp[name]);
      }
      expect(hideTestWindows()).toBe(true);
    } else {
      expect((cp['spawn'] as Record<symbol, unknown>)[mark]).toBeUndefined();
      expect(hideTestWindows('linux')).toBe(false);
    }
  });
});
