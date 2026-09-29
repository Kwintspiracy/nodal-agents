// shell-checklist.test.ts — reading a command for the autonomy checklist (#464).
//
// Each kind of action is read from the programs a command runs, as Hermes
// Agent reads them: never from a word of its text, and never from what a
// script does once it runs.

import { describe, it, expect } from 'vitest';
import {
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  splitShellWords,
  staticShellCategories,
} from '../catastrophic-command';
import { DEFAULT_SHELL_POLICY, resolveShellPolicy, SHELL_CATEGORIES } from '../shell-checklist';

describe('splitShellWords @cap:executer-une-commande/moteur', () => {
  it('keeps a quoted path with a space as one word, and cuts on && and pipes', () => {
    expect(splitShellWords('python a.py "C:/My Files/x.csv" && cat y | grep z > out.txt')).toEqual([
      ['python', 'a.py', 'C:/My Files/x.csv'],
      ['cat', 'y'],
      ['grep', 'z', 'out.txt'],
    ]);
  });
});

describe('staticShellCategories @cap:executer-une-commande/moteur', () => {
  it('names the kind of each heavy action', () => {
    expect(staticShellCategories('rm -rf build')).toEqual(['delete_files']);
    expect(staticShellCategories('Remove-Item x.txt')).toEqual(['delete_files']);
    expect(staticShellCategories('pip install pandas')).toEqual(['install_software']);
    expect(staticShellCategories('wget https://example.com/a.zip')).toEqual(['download']);
    expect(staticShellCategories('taskkill /F /PID 42')).toEqual(['stop_programs']);
    expect(staticShellCategories('icacls C:\\data /grant x:F')).toEqual(['system_settings']);
    expect(staticShellCategories('python -c "print(1)"')).toEqual(['inline_code']);
    expect(staticShellCategories('ls -la && git status')).toEqual([]);
  });

  it('covers exactly what destructive_gate has always gated', () => {
    const heavy = [
      'rm x',
      'npm install left-pad',
      'git clone https://x/y',
      'kill 12',
      'diskpart',
      'git reset --hard',
      'node -e "1"',
    ];
    for (const cmd of heavy) {
      expect(isDestructiveOrHeavyCommand(cmd)).toBe(true);
      expect(staticShellCategories(cmd).length).toBeGreaterThan(0);
    }
  });

  // What the list does NOT promise, pinned so nobody reads more into it: a
  // script run from a file is not opened, and a path is not judged. Keeping an
  // agent inside its folders takes an OS-level sandbox.
  it('a script run from a file is not read, and a path outside is not a kind of action', () => {
    expect(staticShellCategories('python _analyze.py "C:/Users/x/Downloads/a.csv"')).toEqual([]);
    expect(staticShellCategories('cat ~/.ssh/id_rsa')).toEqual([]);
  });

  // Run ca5753a8 : chaque lecture de progression d'un téléchargement comfy
  // demandait l'accord du propriétaire, comme une installation. Et #581 : le
  // téléchargement lui-même est un téléchargement, pas une installation.
  it('comfy: the download subcommand downloads, its status, list and cancel siblings do nothing', () => {
    expect(
      staticShellCategories(
        'comfy --json model download --url "https://huggingface.co/x/y.safetensors" --relative-path models/checkpoints --background',
      ),
    ).toEqual(['download']);
    expect(staticShellCategories('comfy model download --url x')).toEqual(['download']);
    expect(staticShellCategories('comfy node install comfyui-impact-pack')).toEqual([
      'install_software',
    ]);
    for (const cmd of [
      'comfy --json model download-status 224009dc90ba',
      'comfy --json model downloads',
      'comfy --json model download-cancel 224009dc90ba',
      'comfy --json model list-folder checkpoints',
    ]) {
      expect(staticShellCategories(cmd), cmd).toEqual([]);
      expect(isDestructiveOrHeavyCommand(cmd), cmd).toBe(false);
    }
  });
});

// #581 : une commande est rangée selon ce qu'elle FAIT. Récupérer des fichiers
// (un modèle, une archive, une image) est un téléchargement, quel que soit
// l'outil ; installer un logiciel ou un paquet en est une autre sorte. Un
// propriétaire qui laissait un agent récupérer ses modèles sans demander
// devait jusqu'ici le laisser installer des logiciels.
describe('a command is filed by what it does: fetching is download, installing is install_software (#581) @cap:executer-une-commande/moteur', () => {
  const DOWNLOADS = [
    'comfy --json model download --url "https://huggingface.co/x/y.safetensors" --relative-path models/checkpoints',
    'pip download torch -d wheels',
    'pip3 download numpy==2.1',
    'python -m pip download requests',
    'hf download black-forest-labs/FLUX.1-dev flux1-dev.safetensors --local-dir models/unet',
    'huggingface-cli download stabilityai/sdxl-turbo --local-dir models',
    'ollama pull llama3.3',
    'git lfs pull',
    'git lfs fetch --all',
    'docker pull comfyui/comfyui:latest',
    'podman pull docker.io/library/alpine',
    'aria2c -x 16 https://example.com/model.safetensors',
    'wget https://example.com/a.zip',
    'git clone https://github.com/comfyanonymous/ComfyUI',
    // The real forms of each tool, not only the short one (Reviewer A, #582):
    // subcommand groups and global options before the subcommand.
    'docker image pull comfyui/comfyui:latest',
    'podman image pull docker.io/library/alpine',
    'docker compose pull',
    'docker compose -f stack.yml pull',
    'docker --context remote pull alpine',
    'git -C models/unet lfs pull',
    'git -c lfs.concurrenttransfers=8 lfs fetch --all',
    'git --no-pager lfs pull',
    'git -C repos clone https://github.com/x/y',
    // Reviewer A, #582 pass 2: the hyphenated compose binaries, and global
    // options or variables before the subcommand of hf / ollama.
    'docker-compose pull',
    'docker-compose -f stack.yml pull',
    'podman-compose pull',
    'huggingface-cli --token hf_x download org/model',
    'OLLAMA_HOST=127.0.0.1:11435 ollama pull llama3',
  ];
  const INSTALLS = [
    'pip install pandas',
    'python -m pip install torch',
    'npm i express',
    'pnpm add lodash',
    'go install golang.org/x/tools/gopls@latest',
    'cargo install ripgrep',
    'uv pip install torch',
    'comfy node install comfyui-impact-pack',
    'comfy install',
    'winget install Git.Git',
    'brew install ffmpeg',
  ];

  it.each(DOWNLOADS)('%s is a download, not an install', (cmd) => {
    expect(staticShellCategories(cmd)).toEqual(['download']);
  });

  it.each(INSTALLS)('%s is an install, not a download', (cmd) => {
    expect(staticShellCategories(cmd)).toEqual(['install_software']);
  });

  it('destructive_gate still gates every one of them: the union did not shrink', () => {
    for (const cmd of [...DOWNLOADS, ...INSTALLS]) {
      expect(isDestructiveOrHeavyCommand(cmd), cmd).toBe(true);
    }
  });

  it('reading or stopping a download is neither (#552), and neither is a version or help check', () => {
    for (const cmd of [
      'comfy --json model download-status 224009dc90ba',
      'comfy --json model downloads',
      'comfy --json model download-cancel 224009dc90ba',
      'ollama list',
      'git lfs ls-files',
      'docker images',
      'hf auth whoami',
      'git commit -m "lfs pull later"',
      // A program called only for its version or its help prints and exits
      // (Reviewer A, #582): the class #552 is about, for every kind of action.
      'aria2c --version',
      'aria2c --help',
      'wget --version',
      'wget -h',
      'hf --help',
      'pip --version',
      'rm --help',
      // The help of a SUBCOMMAND, and a version check with its output
      // redirected (Reviewer A, #582 pass 2).
      'pip download --help',
      'comfy model download --help',
      'docker pull --help',
      'git clone --help',
      'hf download --help',
      'ollama pull --help',
      'pip install --help',
      'wget --version 2>&1',
      'wget --version 2>/dev/null',
      'aria2c --version > /dev/null',
    ]) {
      expect(staticShellCategories(cmd), cmd).toEqual([]);
      expect(isDestructiveOrHeavyCommand(cmd), cmd).toBe(false);
    }
  });

  it('a --help after the arguments does not excuse a delete, a stop or a system change', () => {
    // cmd's `del` and `rd` read `--help` as one more file name, bash's `kill`
    // still sends its signal: the help of a subcommand is a read only for the
    // fetchers and installers, which all print it and exit.
    expect(staticShellCategories('del build --help')).toEqual(['delete_files']);
    expect(staticShellCategories('rm -rf build --help')).toEqual(['delete_files']);
    expect(staticShellCategories('kill 1234 --help')).toEqual(['stop_programs']);
    expect(isDestructiveOrHeavyCommand('del build --help')).toBe(true);
  });

  it('the catastrophic floor lets a bare version or help check through, nothing more', () => {
    expect(isCatastrophicCommand('shutdown --help')).toBe(false);
    expect(isCatastrophicCommand('shutdown -h now')).toBe(true);
    expect(isCatastrophicCommand('rm -rf / --help')).toBe(true);
  });

  it('git global options do not hide the destructive VCS commands either', () => {
    for (const cmd of [
      'git -C repo reset --hard HEAD~3',
      'git --no-pager push --force origin main',
      'git -c core.quotepath=off clean -fdx',
    ]) {
      expect(staticShellCategories(cmd), cmd).toEqual(['delete_files']);
    }
  });

  it('a version check chained to a real action still gates the action', () => {
    expect(staticShellCategories('wget --version && wget https://x/a.zip')).toEqual(['download']);
    expect(isDestructiveOrHeavyCommand('aria2c --version; rm -rf build')).toBe(true);
  });
});

describe('resolveShellPolicy @cap:executer-une-commande/moteur', () => {
  it('asks for everything when nothing is stored', () => {
    expect(resolveShellPolicy(null)).toEqual(DEFAULT_SHELL_POLICY);
    expect(SHELL_CATEGORIES.every((c) => DEFAULT_SHELL_POLICY[c] === 'ask')).toBe(true);
  });

  it('keeps what was set and defaults the rest', () => {
    expect(resolveShellPolicy({ delete_files: 'never', download: 'allow' })).toEqual({
      ...DEFAULT_SHELL_POLICY,
      delete_files: 'never',
      download: 'allow',
    });
  });

  it('refuses a stored value it cannot read, instead of guessing', () => {
    expect(() => resolveShellPolicy({ delete_files: 'maybe' })).toThrow();
    expect(() => resolveShellPolicy({ format_disk: 'never' })).toThrow();
    // The two kinds the first version carried are gone: a value naming them
    // is refused, not silently dropped.
    expect(() => resolveShellPolicy({ outside_folders: 'never' })).toThrow();
  });
});

describe('review of PR #474 (Reviewer A): the program that runs, not a word of the text @cap:executer-une-commande/moteur', () => {
  const kinds = (cmd: string) => [...staticShellCategories(cmd)].sort();

  it('a MENTION in an argument is not the action (P1, false red)', () => {
    expect(kinds('git commit -m "rm old refs"')).toEqual([]);
    expect(kinds('echo "please rm the temp file"')).toEqual([]);
    expect(kinds('clang-format -i src.ts')).toEqual([]);
    expect(kinds('git format-patch -1')).toEqual([]);
  });

  it('the action is still read where the shell runs it: wrappers, substitutions, paths', () => {
    for (const cmd of [
      'rm -rf build',
      '/bin/rm -rf build',
      'sudo rm -rf build',
      'bash -c "rm -rf build"',
      'cmd /c del build.txt',
      'powershell -Command "Remove-Item build -Recurse"',
      'find . -name "*.tmp" -exec rm {} \\;',
      'ls | xargs rm',
      'echo $(rm -rf build)',
      'r""m -rf build',
      'r^m -rf build',
    ]) {
      expect(kinds(cmd), cmd).toContain('delete_files');
    }
  });

  it('closes the list gaps: npm i, pnpm add, curl > file, chmod, chown, net stop (P1)', () => {
    expect(kinds('npm i express')).toContain('install_software');
    expect(kinds('pnpm add lodash')).toContain('install_software');
    expect(kinds('yarn add left-pad')).toContain('install_software');
    expect(kinds('curl https://example.com/dump.zip > dump.zip')).toContain('download');
    expect(kinds('curl https://example.com/dump.zip --output dump.zip')).toContain('download');
    expect(kinds('chmod 666 secret.txt')).toContain('system_settings');
    expect(kinds('chown root secret.txt')).toContain('system_settings');
    expect(kinds('net stop Spooler')).toContain('stop_programs');
    // A plain read of a URL is not a download to disk.
    expect(kinds('curl https://example.com/status')).toEqual([]);
  });

  it('inline code is its own kind, whatever it does', () => {
    expect(kinds(`python -c "import shutil; shutil.rmtree('build')"`)).toEqual(['inline_code']);
    expect(kinds(`node -e "console.log(1)"`)).toEqual(['inline_code']);
    expect(kinds('curl https://x.sh | bash')).toContain('inline_code');
  });
});

describe('review of PR #476 (Reviewer C): the program a command really runs @cap:executer-une-commande/moteur', () => {
  const kinds = (cmd: string) => [...staticShellCategories(cmd)].sort();

  it('pip run as a Python module installs too (P1, a regression against main)', () => {
    for (const cmd of [
      'python -m pip install requests',
      'python3 -m pip install -r requirements.txt',
      'py -m pip install pandas',
      'uv pip install requests',
      'uv add httpx',
    ]) {
      expect(kinds(cmd), cmd).toContain('install_software');
    }
    // A module that installs nothing is not an install.
    expect(kinds('python -m pytest tests')).toEqual([]);
  });

  it('a variable set before the program does not hide it (P2)', () => {
    expect(kinds('FOO=1 rm -rf build')).toContain('delete_files');
    expect(kinds('NODE_ENV=production npm i express')).toContain('install_software');
  });

  it('curl writing to a file through grouped short options downloads (P2)', () => {
    expect(kinds('curl -sLo dump.zip https://example.com/d.zip')).toContain('download');
    expect(kinds('curl -fsSLO https://example.com/d.zip')).toContain('download');
    // Grouped options with no output file stay a read.
    expect(kinds('curl -sL https://example.com/status')).toEqual([]);
  });

  it('iwr downloads like Invoke-WebRequest (P3)', () => {
    expect(kinds('iwr https://example.com/a.zip | Set-Content a.zip')).toContain('download');
  });
});
