// mcp-clients.test.ts — Claude Code ET Claude Desktop sur le serveur MCP (#485).
//
// La commande vient du CLI qui a démarré la stack (`NODAL_CLI_ARGV`) ; aucun
// secret n'y figure. L'écriture dans la config de Claude Desktop garde tout ce
// qui s'y trouvait, copie l'ancien fichier, et n'écrase jamais un fichier
// illisible.
//
// Mutations vérifiées :
//   - `...servers` retiré de `withNodalEntry` → « garde les autres serveurs »
//     rougit ;
//   - la copie de sauvegarde retirée → « copie l'ancien fichier » rougit ;
//   - l'antislash remis dans la classe « sûre » de `shellArg` → « tout chemin
//     Windows entre guillemets » et « chaque antislash sous guillemets »
//     rougissent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.mock('server-only', () => ({}));

const {
  claudeCodeCommand,
  claudeDesktopConfigPath,
  claudeDesktopEntry,
  readCliArgv,
  withNodalEntry,
} = await import('../mcp-clients.ts');
const { writeNodalIntoClaudeDesktop, DesktopNotInstalledError } =
  await import('../claude-desktop-config.ts');

const DEV = [
  'C:\\Program Files\\nodejs\\node.exe',
  '--import',
  'file:///D:/APPS/NodalAI/node_modules/tsx/dist/loader.mjs',
  'D:\\APPS\\NodalAI\\apps\\cli\\src\\index.ts',
];

describe('la commande de chaque client, pour CETTE install @cap:connecter-un-service/moteur', () => {
  it('lit NODAL_CLI_ARGV, et rend null plutôt qu’une commande inventée', () => {
    expect(readCliArgv(JSON.stringify(DEV))).toEqual(DEV);
    expect(readCliArgv(undefined)).toBeNull();
    expect(readCliArgv('not json')).toBeNull();
    expect(readCliArgv('["node"]')).toBeNull();
  });

  it('Claude Code : la commande entière, tout chemin Windows entre guillemets', () => {
    expect(claudeCodeCommand(DEV)).toBe(
      'claude mcp add nodal -- "C:\\Program Files\\nodejs\\node.exe" --import ' +
        'file:///D:/APPS/NodalAI/node_modules/tsx/dist/loader.mjs ' +
        '"D:\\APPS\\NodalAI\\apps\\cli\\src\\index.ts" mcp serve',
    );
  });

  // Un antislash nu est un échappement pour bash (Git Bash) : `D:\APPS\cli.js`
  // collé tel quel y devient `D:APPScli.js`. Tout argument qui en porte un est
  // donc cité, avec ou sans espace, et un argument sûr reste nu.
  it.each([
    ['install Windows sans espace', ['C:\\nodejs\\node.exe', 'C:\\Users\\q\\nodal\\cli.js']],
    [
      'install npx Windows',
      ['C:\\Program Files\\nodejs\\node.exe', 'C:\\npm-cache\\_npx\\a1\\cli.js'],
    ],
    ['install macOS / Linux', ['/usr/local/bin/node', '/home/q/.npm/_npx/a1/cli.js']],
  ])('Claude Code : %s, chaque antislash sous guillemets', (_label, argv) => {
    const command = claudeCodeCommand(argv);
    for (const arg of argv) {
      expect(command).toContain(arg.includes('\\') || arg.includes(' ') ? `"${arg}"` : ` ${arg} `);
    }
  });

  it('Claude Desktop : le node en commande, le reste en arguments, et aucun secret', () => {
    const entry = claudeDesktopEntry(DEV);
    expect(entry).toEqual({ command: DEV[0], args: [...DEV.slice(1), 'mcp', 'serve'] });
    expect(JSON.stringify(entry)).not.toMatch(/postgres|DATABASE_URL|password/i);
  });

  it('le fichier de Claude Desktop, par système', () => {
    expect(
      claudeDesktopConfigPath(
        'win32',
        { APPDATA: 'C:\\Users\\q\\AppData\\Roaming' },
        'C:\\Users\\q',
        path.win32.join,
      ),
    ).toBe('C:\\Users\\q\\AppData\\Roaming\\Claude\\claude_desktop_config.json');
    expect(claudeDesktopConfigPath('darwin', {}, '/Users/q', path.posix.join)).toBe(
      '/Users/q/Library/Application Support/Claude/claude_desktop_config.json',
    );
    expect(claudeDesktopConfigPath('linux', {}, '/home/q', path.posix.join)).toBe(
      '/home/q/.config/Claude/claude_desktop_config.json',
    );
  });
});

describe('withNodalEntry — la config de Claude Desktop @cap:connecter-un-service/moteur', () => {
  const entry = claudeDesktopEntry(DEV);

  it('garde les autres serveurs et les autres clés, et pose `nodal`', () => {
    const existing = JSON.stringify({
      mcpServers: {
        'n8n-mcp': { command: 'npx', args: ['n8n-mcp'] },
        'virtual-printer': { command: 'vp' },
      },
      globalShortcut: 'Ctrl+Space',
    });
    const { text, replaced } = withNodalEntry(existing, entry);
    expect(replaced).toBe(false);
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        'n8n-mcp': { command: 'npx', args: ['n8n-mcp'] },
        'virtual-printer': { command: 'vp' },
        nodal: entry,
      },
      globalShortcut: 'Ctrl+Space',
    });
  });

  it('remplace une entrée `nodal` existante, et le dit', () => {
    const { text, replaced } = withNodalEntry(
      JSON.stringify({ mcpServers: { nodal: { command: 'old' } } }),
      entry,
    );
    expect(replaced).toBe(true);
    expect(JSON.parse(text).mcpServers.nodal).toEqual(entry);
  });

  it('un fichier illisible n’est pas réécrit : l’erreur remonte', () => {
    expect(() => withNodalEntry('{ not json', entry)).toThrow(/not valid JSON/);
    expect(() => withNodalEntry('{"mcpServers": []}', entry)).toThrow(/not an object/);
  });
});

describe('writeNodalIntoClaudeDesktop — sur le disque @cap:connecter-un-service/moteur', () => {
  let root = '';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'nodal-485-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('copie l’ancien fichier avant de le réécrire, et garde ses serveurs', async () => {
    const dir = path.join(root, 'Claude');
    await mkdir(dir);
    const file = path.join(dir, 'claude_desktop_config.json');
    const avant = JSON.stringify({ mcpServers: { 'n8n-mcp': { command: 'npx' } } });
    await writeFile(file, avant, 'utf8');

    const r = await writeNodalIntoClaudeDesktop(
      file,
      claudeDesktopEntry(DEV),
      new Date('2026-09-27T12:00:00Z'),
    );

    expect(r.backupPath).not.toBeNull();
    expect(await readFile(r.backupPath!, 'utf8')).toBe(avant);
    const apres = JSON.parse(await readFile(file, 'utf8'));
    expect(Object.keys(apres.mcpServers).sort()).toEqual(['n8n-mcp', 'nodal']);
  });

  it('sans dossier Claude, rien n’est créé : Claude Desktop n’est pas installé ici', async () => {
    const file = path.join(root, 'Claude', 'claude_desktop_config.json');
    await expect(
      writeNodalIntoClaudeDesktop(file, claudeDesktopEntry(DEV), new Date()),
    ).rejects.toBeInstanceOf(DesktopNotInstalledError);
    expect(await readdir(root)).toEqual([]);
  });

  it('un fichier illisible reste tel quel, sans copie', async () => {
    const dir = path.join(root, 'Claude');
    await mkdir(dir);
    const file = path.join(dir, 'claude_desktop_config.json');
    await writeFile(file, '{ broken', 'utf8');
    await expect(
      writeNodalIntoClaudeDesktop(file, claudeDesktopEntry(DEV), new Date()),
    ).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, 'utf8')).toBe('{ broken');
    expect(await readdir(dir)).toEqual(['claude_desktop_config.json']);
  });
});
