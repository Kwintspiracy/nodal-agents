// sandbox-copy.test.ts — les phrases du bac à sable (#876), et surtout celle
// du bandeau permanent : il parle tant que le bac à sable est coupé,
// indisponible, ou que son état n'a pas pu être lu ; il ne se tait que quand
// le runner dit qu'il confine.

import { describe, it, expect } from 'vitest';
import type { SandboxState } from '@nodal-agents/shared';
import {
  broadFolderWords,
  folderTag,
  limitWords,
  outsideSandboxWords,
  perimeterWords,
  sandboxBannerWords,
  splitFolder,
  stateCardWords,
  unavailableWords,
} from '../sandbox-copy.ts';

const state = (over: Partial<SandboxState>): SandboxState => ({
  platform: 'win32',
  status: { state: 'available', backend: 'mxc-processcontainer' },
  enabled: true,
  allowedFolders: [],
  agentFolders: [],
  agentsWithoutFolder: [],
  writableFolderCount: 0,
  sharedFolder: null,
  readRefused: [],
  network: { deniedPorts: [] },
  ...over,
});

describe('sandboxBannerWords @cap:executer-une-commande/ecran', () => {
  it('silent only when the runner says the sandbox confines', () => {
    expect(sandboxBannerWords(state({}))).toBeNull();
  });

  it('speaks while it is off, unavailable, not on this system, or unread', () => {
    expect(sandboxBannerWords(state({ enabled: false }))).toBe(
      'The sandbox is off for this workspace. Commands run without confinement.',
    );
    expect(
      sandboxBannerWords(
        state({ status: { state: 'unavailable', code: 'SANDBOX_SELF_TEST_FAILED', reason: 'x' } }),
      ),
    ).toBe(
      'The sandbox is unavailable: its self-test failed on this machine. Commands run without confinement.',
    );
    expect(
      sandboxBannerWords(
        state({ status: { state: 'unavailable', code: 'SANDBOX_NOT_IMPLEMENTED', reason: 'x' } }),
      ),
    ).toBe('The sandbox is not available on this system yet. Commands run without confinement.');
    expect(sandboxBannerWords(null)).toBe(
      'The sandbox state could not be read. Commands may run without confinement.',
    );
  });

  it('a code it does not know is shown as it is, never replaced by a made-up sentence', () => {
    expect(unavailableWords('SANDBOX_SOMETHING_NEW')).toBe('SANDBOX_SOMETHING_NEW');
    // Le texte du backend reste un diagnostic : jamais la phrase affichée.
    expect(limitWords('SANDBOX_LIMIT_NEW: what the backend said')).toEqual({
      code: 'SANDBOX_LIMIT_NEW',
      words: 'This version of Nodal does not describe this limit yet.',
      detail: 'what the backend said',
    });
  });
});

describe('the words of the sandbox section @cap:executer-une-commande/ecran', () => {
  it('splits a folder into its name and its parent, a volume root being its own name, on any system', () => {
    expect(splitFolder('C:\\Users\\me\\.nodalai\\tool-cache')).toEqual({
      name: 'tool-cache',
      parent: 'C:\\Users\\me\\.nodalai\\',
    });
    expect(splitFolder('/home/me/models/')).toEqual({ name: 'models', parent: '/home/me/' });
    expect(splitFolder('C:\\')).toEqual({ name: 'C:\\', parent: '' });
    expect(splitFolder('/')).toEqual({ name: '/', parent: '' });
    expect(splitFolder('D:\\Dev')).toEqual({ name: 'Dev', parent: 'D:\\' });
  });

  it('tags a folder by where it comes from, or by why it does not apply', () => {
    expect(folderTag({ source: 'tool-cache', state: 'allowed' })).toEqual({
      label: 'Nodal',
      variant: 'neutral',
    });
    expect(folderTag({ source: 'docker', state: 'allowed' })).toEqual({
      label: 'Found · Docker',
      variant: 'info',
    });
    expect(folderTag({ source: 'docker', state: 'removed' }).variant).toBe('neutral');
    expect(folderTag({ source: 'user', state: 'allowed' }).label).toBe('Added by you');
    expect(folderTag({ source: 'user', state: 'missing' })).toEqual({
      label: 'Not found, skipped',
      variant: 'warn',
    });
  });

  it('the perimeter counts what the runner counted, in warn only when the user turned it off', () => {
    expect(perimeterWords(state({ writableFolderCount: 1 })).write.value).toBe('1 folder');
    expect(perimeterWords(state({ writableFolderCount: 9 })).write.value).toBe('9 folders');
    expect(perimeterWords(state({ enabled: false })).write).toEqual({
      value: 'Anywhere',
      subtle: 'Everything your Windows account can write.',
      tone: 'warn',
    });
    const linux = state({
      platform: 'linux',
      status: { state: 'unavailable', code: 'SANDBOX_NOT_IMPLEMENTED', reason: 'x' },
    });
    expect(perimeterWords(linux).write.tone).toBe('default');
    expect(stateCardWords(linux).title).toBe('Not available on Linux yet');
  });

  it('a volume root names the system it belongs to', () => {
    expect(broadFolderWords({ kind: 'volume-root', nodalData: [] }, '/', 'linux')).toEqual({
      title: 'Allow all of / ?',
      message:
        'Commands of every agent in this workspace could write anywhere on this drive, Linux and your programs included.',
      confirm: 'Allow /',
    });
  });

  it('a folder that holds the home folder or Nodal data names them, and the known limit on the data', () => {
    expect(
      broadFolderWords(
        { kind: 'holds-home', nodalData: ['C:\Users\q\.nodalai'] },
        'C:\Users',
        'win32',
      ),
    ).toEqual({
      title: 'Allow all of C:\Users ?',
      message:
        "Commands of every agent in this workspace could write anywhere in C:\Users, your home folder included. It holds Nodal's data, in C:\Users\q\.nodalai. Commands could add new files there. What is already there stays refused.",
      confirm: 'Allow C:\Users',
    });
    expect(
      broadFolderWords(
        { kind: 'holds-nodal-data', nodalData: ['/srv/nodal/a', '/srv/nodal/b'] },
        '/srv/nodal',
        'linux',
      ).message,
    ).toBe(
      "Commands of every agent in this workspace could write anywhere in /srv/nodal. It holds Nodal's data, in /srv/nodal/a and /srv/nodal/b. Commands could add new files there. What is already there stays refused.",
    );
    expect(
      broadFolderWords({ kind: 'home', nodalData: ['/home/q/.nodalai'] }, '/home/q', 'linux'),
    ).toEqual({
      title: 'Allow your whole home folder?',
      message:
        "Commands of every agent in this workspace could write anywhere in /home/q, your documents included. It holds Nodal's data, in /home/q/.nodalai. Commands could add new files there. What is already there stays refused.",
      confirm: 'Allow',
    });
    for (const kind of ['volume-root', 'home', 'holds-home', 'holds-nodal-data'] as const) {
      const words = broadFolderWords({ kind, nodalData: ['X'] }, 'P', 'win32');
      expect(`${words.title} ${words.message} ${words.confirm}`).not.toContain('—');
    }
  });

  it('an agent outside the sandbox is named by the runtime label; an unknown runtime is never called confined', () => {
    expect(outsideSandboxWords({ name: 'A', runtime: 'nodal', commands: 'sandbox' })).toBeNull();
    expect(outsideSandboxWords({ name: 'B', runtime: 'codex', commands: 'outside' })).toBe(
      "B runs on Codex. Its commands run outside Nodal's sandbox.",
    );
    expect(outsideSandboxWords({ name: 'C', runtime: 'later', commands: 'unknown' })).toBe(
      'C runs on later, which this version does not know. Its commands are not confined by Nodal.',
    );
  });
});
