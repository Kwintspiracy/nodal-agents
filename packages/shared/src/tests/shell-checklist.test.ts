// shell-checklist.test.ts — reading a command for the autonomy checklist (#464).
//
// Each kind of action is read from the programs a command runs, as Hermes
// Agent reads them: never from a word of its text, and never from what a
// script does once it runs.

import { describe, it, expect } from 'vitest';
import {
  downloadWrites,
  type ShellHost,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  splitShellWords,
  staticShellCategories,
} from '../catastrophic-command';
import { DEFAULT_SHELL_POLICY, resolveShellPolicy, SHELL_CATEGORIES } from '../shell-checklist';

/** `downloadWrites` for a host: Windows unless a case says it is about POSIX. */
const writesOf = (cmd: string, host: ShellHost = 'windows') => downloadWrites(cmd, host);

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
  // #614 : un agent autonome ne demande que ce qui sort de son espace ou ne se
  // défait pas (décision de Quentin, 29/09). Télécharger dans l'espace et
  // lancer du code, écrit dans la commande ou dans un script, ne sortent pas.
  it('when nothing is stored, downloads and inline code run, every other kind asks (#614)', () => {
    expect(resolveShellPolicy(null)).toEqual({
      inline_code: 'allow',
      delete_files: 'ask',
      install_software: 'ask',
      download: 'allow',
      stop_programs: 'ask',
      system_settings: 'ask',
    });
    expect(resolveShellPolicy(undefined)).toEqual(resolveShellPolicy(null));
    expect(Object.keys(DEFAULT_SHELL_POLICY)).toEqual([...SHELL_CATEGORIES]);
  });

  it('a stored "ask" is kept over the default (#614)', () => {
    expect(resolveShellPolicy({ download: 'ask', inline_code: 'ask' })).toEqual({
      ...DEFAULT_SHELL_POLICY,
      download: 'ask',
      inline_code: 'ask',
    });
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

// Revue Nodal de la PR #618, P1b : où un téléchargement écrit. Lu sur le texte,
// comme le reste ; le runner juge ensuite si c'est dans un espace du job.
describe('downloadWrites: where a download line writes (#614, review P1b) @cap:executer-une-commande/moteur', () => {
  it.each([
    ['curl -s -o out/a.jpg https://x/a.jpg', ['out/a.jpg']],
    ['curl --output=/tmp/a https://x/a', ['/tmp/a']],
    [
      'curl -sLo C:\\Users\\k\\.ssh\\authorized_keys https://x/k',
      ['C:\\Users\\k\\.ssh\\authorized_keys'],
    ],
    ['curl -O https://x/a.zip', ['.']],
    ['curl --output-dir /opt/x -O https://x/a.zip', ['/opt/x']],
    ['curl https://x/a.zip > /tmp/a.zip', ['/tmp/a.zip']],
    ['wget https://x/a.zip', ['.']],
    ['wget -O ../a.zip https://x/a.zip', ['../a.zip']],
    ['wget -P /var/tmp https://x/a.zip', ['/var/tmp']],
    ["Invoke-WebRequest -Uri https://x/a -OutFile 'D:\\hors\\a.jpg'", ['D:\\hors\\a.jpg']],
    ['iwr https://x/a -OutFile:a.jpg', ['a.jpg']],
    ['Start-BitsTransfer -Source https://x/a -Destination C:\\temp\\a', ['C:\\temp\\a']],
    ['aria2c -d /data -o m.bin https://x/m', ['/data/m.bin']],
    ['aria2c https://x/m', ['.']],
    ['git clone https://github.com/x/y D:\\hors-espace', ['D:\\hors-espace']],
    ['git clone --depth 1 -b main https://github.com/x/y', ['.']],
    ['git -C /elsewhere clone https://github.com/x/y z', ['/elsewhere/z']],
    ['pip download torch -d wheels', ['wheels']],
    ['hf download org/m f.safetensors --local-dir models/unet', ['models/unet']],
  ] as const)('%s', (cmd, targets) => {
    expect(writesOf(cmd).targets.map((t) => t.path)).toEqual(targets);
  });

  it('a target it cannot read is null: a variable, a home path, a sub-shell', () => {
    const paths = (cmd: string) => writesOf(cmd).targets.map((t) => t.path);
    expect(paths('curl -o $HOME/a https://x/a')).toEqual([null]);
    expect(paths('curl -o %TEMP%\\a https://x/a')).toEqual([null]);
    expect(paths('wget -O ~/a https://x/a')).toEqual([null]);
    expect(paths('curl -o "$(mktemp)" https://x/a')).toEqual([null]);
    expect(paths('Start-BitsTransfer https://x/a C:\\x')).toEqual([null]);
  });

  // Revue passe 2 : une cible n'est jugée que depuis les `cd` qui la précèdent.
  it("each target says how many of the line's folders come before it", () => {
    expect(writesOf('cd shared/x && curl -o a.jpg https://x/a')).toEqual({
      dirs: ['shared/x'],
      targets: [{ path: 'a.jpg', after: 1 }],
    });
    expect(writesOf('curl -o a.jpg https://x/a && cd /elsewhere')).toEqual({
      dirs: ['/elsewhere'],
      targets: [{ path: 'a.jpg', after: 0 }],
    });
    expect(writesOf('cd a && wget -O x https://x && cd b && curl -o y https://y')).toEqual({
      dirs: ['a', 'b'],
      targets: [
        { path: 'x', after: 1 },
        { path: 'y', after: 2 },
      ],
    });
    // A shell redirection has no known place in the line: judged from every folder.
    expect(writesOf('curl https://x/a > a.zip && cd out').targets).toEqual([
      { path: 'a.zip', after: null },
    ]);
  });

  it('the folders the line moves into are kept in order', () => {
    expect(writesOf('cd shared/x && curl -o a.jpg https://x/a').dirs).toEqual(['shared/x']);
    expect(writesOf('cd && curl -o a.jpg https://x/a').dirs).toEqual([null]);
    expect(writesOf('Push-Location D:\\out; iwr https://x -OutFile a').dirs).toEqual(['D:\\out']);
    expect(writesOf('pushd out && popd && curl -o a https://x').dirs).toEqual(['out', null]);
    expect(writesOf('Set-Location -Path D:\\x; iwr https://x -OutFile a').dirs).toEqual(['D:\\x']);
  });

  // Passe 3, P2-3 : une valeur collée à son option courte (`-sLoC:\x`). Une
  // seule lecture des options courtes pour curl, wget et aria2c : dans un
  // groupe, la première option qui prend une valeur prend le reste du groupe.
  it('a value glued to a short option is read, by the same reader for curl, wget and aria2c', () => {
    const paths = (cmd: string) => writesOf(cmd).targets.map((t) => t.path);
    const glued = 'curl -sLoC:\\Users\\k\\.ssh\\authorized_keys https://x/k';
    expect(staticShellCategories(glued)).toEqual(['download']);
    expect(paths(glued)).toEqual(['C:\\Users\\k\\.ssh\\authorized_keys']);
    expect(paths('curl -oout.bin https://x/a')).toEqual(['out.bin']);
    expect(paths('wget -qO/tmp/x https://x/a')).toEqual(['/tmp/x']);
    expect(paths('wget -qO- https://x/a')).toEqual([]);
    expect(paths('aria2c -d/data -oout.bin https://x/m')).toEqual(['/data/out.bin']);
    // An option that takes a value swallows the rest of its group: no output there.
    expect(staticShellCategories('curl -XPOST https://x/api')).toEqual([]);
    expect(staticShellCategories('curl -sXPOST -H "X-O: 1" https://x/api')).toEqual([]);
    expect(isDestructiveOrHeavyCommand(glued)).toBe(true);
    expect(isDestructiveOrHeavyCommand('curl -XPOST https://x/api')).toBe(false);
  });

  // #669 (approbation 0330a0fc, 02/10) : `-o /dev/null` était résolu comme un
  // fichier, hors de l'espace, et la personne était interrogée sur un
  // téléchargement qui n'écrivait que dans l'espace.
  it('a null device or a standard stream is never a place, whatever writes there (#669)', () => {
    const paths = (cmd: string) => writesOf(cmd).targets.map((t) => t.path);
    expect(
      paths(
        'curl -s "https://commons.wikimedia.org/w/api.php?action=query" -o commons.json && ' +
          'curl -s -o /dev/null -w "%{http_code}" -L "https://commons.wikimedia.org/wiki/File:x.jpg"',
      ),
    ).toEqual(['commons.json']);
    for (const cmd of [
      'curl -s -o /dev/null https://x/a',
      'curl --output=/dev/stdout https://x/a',
      'wget -O /dev/stderr https://x/a',
      'curl -o NUL https://x/a',
      'curl -o nul https://x/a',
      'curl -o Nul.json https://x/a',
      'iwr https://x/a -OutFile NUL',
      'curl https://x/a > NUL',
      'curl https://x/a > /dev/null',
      'curl https://x/a >> nul.log',
      'iwr https://x/a | Out-File NUL',
      'curl https://x/a | tee /dev/stderr',
      'curl https://x/a > $null',
    ]) {
      expect(paths(cmd), cmd).toEqual([]);
    }
    // Only the device itself: a file or folder that merely starts like one is a place.
    expect(paths('curl -o /dev/nullx https://x/a')).toEqual(['/dev/nullx']);
    expect(paths('curl -o nul/a.json https://x/a')).toEqual(['nul/a.json']);
    expect(paths('curl -o null.json https://x/a')).toEqual(['null.json']);
    expect(paths('curl -o /tmp/dev/null https://x/a')).toEqual(['/tmp/dev/null']);
  });

  // #669, second pass: the rule is ONE function (`writtenPlaces`) that every kind
  // of write goes through. A name is exempt only when nothing it leads to can be
  // a file: a sink by definition, never a descriptor alias, and a Windows device
  // name only for a Windows host.
  const wrapped = (device: string) => [
    `curl -s -o ${device} https://x/a`,
    `curl -s --output ${device} https://x/a`,
    `curl https://x/a > ${device}`,
    `curl https://x/a >> ${device}`,
    `curl https://x/a 2> ${device}`,
    `curl https://x/a 2>${device}`,
    `curl https://x/a &> ${device}`,
    `curl https://x/a &>>${device}`,
    `curl https://x/a >${device} 2>&1`,
    `iwr https://x/a -OutFile ${device}`,
    `iwr https://x/a | Out-File ${device}`,
    `iwr https://x/a | Set-Content ${device}`,
    `iwr https://x/a | tee ${device}`,
  ];

  it('a sink by definition is nowhere, for every form of write, on every host (#669)', () => {
    const paths = (cmd: string, host: ShellHost) => writesOf(cmd, host).targets.map((t) => t.path);
    for (const host of ['windows', 'posix'] as const) {
      for (const device of [
        '/dev/null',
        '/dev/zero',
        '/dev/full',
        '/dev/random',
        '/dev/urandom',
        '/dev/tty',
        '$null',
        '$NULL',
      ]) {
        for (const cmd of wrapped(device)) expect(paths(cmd, host), `${host}: ${cmd}`).toEqual([]);
      }
    }
    // Nothing is written by a pipe into Out-Null, whatever else the line does.
    expect(paths('iwr https://x/a | Out-Null', 'posix')).toEqual([]);
    expect(paths('curl -sI https://x/a 2>&1 >/dev/null', 'posix')).toEqual([]);
  });

  it('a Windows device name is a device on a Windows host, and a file anywhere else (#669)', () => {
    const paths = (cmd: string, host: ShellHost) => writesOf(cmd, host).targets.map((t) => t.path);
    for (const device of [
      'NUL',
      'nul',
      'Nul:',
      'nul.txt',
      'NUL.tar.gz',
      'CON',
      'con:',
      'CONOUT$',
      '\\\\.\\NUL',
      '\\\\.\\nul',
      '\\\\.\\CONOUT$',
    ]) {
      for (const cmd of wrapped(device)) {
        expect(paths(cmd, 'windows'), `windows: ${cmd}`).toEqual([]);
        // Judged where it is written: a real file, so a real place to judge.
        expect(paths(cmd, 'posix'), `posix: ${cmd}`).not.toEqual([]);
      }
    }
    // The same file, written from a folder the line moved into.
    expect(paths('cd /etc && curl -o nul https://x/a', 'posix')).toEqual(['nul']);
    expect(writesOf('cd /etc && curl -o nul https://x/a', 'posix').dirs).toEqual(['/etc']);
    expect(paths('cd /etc && curl -o nul https://x/a', 'windows')).toEqual([]);
    expect(paths('curl https://x/a > nul', 'posix')).toEqual(['nul']);
  });

  it('a descriptor alias is whatever the descriptor points at, never a sink (#669)', () => {
    const paths = (cmd: string, host: ShellHost) => writesOf(cmd, host).targets.map((t) => t.path);
    for (const host of ['windows', 'posix'] as const) {
      // Standard input: the file the line reads is the file it overwrites.
      expect(paths('curl -o /dev/stdin https://x/data < /tmp/outside.txt', host)).toEqual([
        '/tmp/outside.txt',
      ]);
      expect(paths('curl -o /dev/fd/0 https://x/data <../outside.txt', host)).toEqual([
        '../outside.txt',
      ]);
      expect(paths('curl https://x/data > /dev/stdin 0< "/tmp/my file.txt"', host)).toEqual([
        '/tmp/my file.txt',
      ]);
      // A descriptor opened by something the text does not show asks.
      expect(paths('curl -o /dev/fd/3 https://x/data', host)).toEqual([null]);
      expect(paths('curl https://x/data > /dev/fd/12', host)).toEqual([null]);
      // The line's own output streams: a file behind them is a redirection of the
      // line, judged on its own, and with none they are the runner's pipes.
      expect(paths('curl -o /dev/stdout https://x/a > /tmp/out.bin', host)).toEqual([
        '/tmp/out.bin',
      ]);
      expect(paths('curl -o /dev/stderr https://x/a 2>../err.log', host)).toEqual(['../err.log']);
      for (const own of ['/dev/stdout', '/dev/stderr', '/dev/fd/1', '/dev/fd/2'])
        for (const cmd of wrapped(own)) expect(paths(cmd, host), `${host}: ${cmd}`).toEqual([]);
      // Standard input read from a pipe or a here-string names no file.
      expect(paths('cat x | curl -o /dev/stdin https://x/a', host)).toEqual([]);
    }
  });

  it('a name that only starts like a device, or a device beyond the bare name, is a place (#669)', () => {
    const paths = (cmd: string) => writesOf(cmd).targets.map((t) => t.path);
    for (const place of [
      '/dev/sda', // a disk is a place
      '/dev/tty1',
      '/dev/fd/',
      '/dev/fd/x',
      '/dev/fd/1/x',
      '/dev/zeroes',
      'dev/null', // relative: a folder named dev
      './dev/null',
      '/tmp/dev/null',
      'null',
      'con/a.txt',
      'console.log',
      'nulled',
      'nul/a',
      '\\\\.\\C:\\x',
    ]) {
      expect(paths(`curl -s -o ${place} https://x/a`), place).toEqual([place]);
      expect(paths(`curl https://x/a > ${place}`), place).toEqual([place]);
    }
  });

  it('a device in the same line never hides a real place, in any order and any form (#669)', () => {
    const paths = (cmd: string) => writesOf(cmd).targets.map((t) => t.path);
    expect(paths('curl -s -o /etc/x https://x/a 2>/dev/null')).toEqual(['/etc/x']);
    expect(paths('curl https://x/a 2>/dev/null > ../outside.txt')).toEqual(['../outside.txt']);
    expect(paths('curl https://x/a > ../outside.txt 2>/dev/null')).toEqual(['../outside.txt']);
    expect(paths('curl https://x/a &>/dev/null > C:\\Windows\\x')).toEqual(['C:\\Windows\\x']);
    expect(paths('curl -s -o /dev/null https://x/a && curl -o /etc/x https://x/b')).toEqual([
      '/etc/x',
    ]);
    expect(paths('curl https://x/a > NUL && curl https://x/b > C:\\Windows\\x')).toEqual([
      'C:\\Windows\\x',
    ]);
    // The stderr of a download goes to a file as surely as its stdout does.
    expect(paths('curl https://x/a 2>../err.log')).toEqual(['../err.log']);
    expect(paths('curl https://x/a &> ../all.log')).toEqual(['../all.log']);
    // A redirection to a descriptor writes no file.
    expect(paths('curl https://x/a 2>&1')).toEqual([]);
    expect(paths('curl -sI https://x/a >&2')).toEqual([]);
  });

  it('a program with its own store names no path: nothing to judge', () => {
    for (const cmd of [
      'ollama pull llama3',
      'docker pull alpine',
      'comfy model download --url https://x/y --relative-path models/checkpoints',
      'hf download org/m',
      'Invoke-RestMethod https://x/status',
      'git status',
    ]) {
      expect(writesOf(cmd).targets, cmd).toEqual([]);
    }
  });
});
