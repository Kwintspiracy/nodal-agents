// shell-installers-and-deletes.test.ts — the standard installers and delete
// commands of Windows, macOS and Linux, and their read-only uses (#693).
//
// `msiexec /i`, `dpkg -i`, `rpm -Uvh`, `snap install`, `flatpak install`,
// macOS `installer -pkg`, cmd's `erase` and PowerShell's `ri` ran with no ask
// under the default policy: no kind of the checklist covered them. The floor
// already knew `erase` and `ri`; the kind kept a list of its own, and the two
// drifted. One list now feeds both, and each kind covers every OS's forms.
// Codex (PR #710, pass 1) found the next installers missing (`wusa`,
// `Install-PackageProvider`): every standard installer is now listed, per OS.
// Pass 2 found a simulation flag that was the value of the option before it
// (`apt-get -c --simulate install x` installs): a simulation now asks like the
// install it simulates, and a read stays unflagged by naming no action.
// A two-value option hid the verb from the option walk (`nix --option sandbox
// false profile install x`): a verb of the program anywhere in its words asks.
// Pass 3 found the verb in a variable (`apt-get "$verb" cowsay`): a word
// decided at run time could be any verb, and asks.
// Pass 4 found an alias (`alias npm='npm install'; npm cowsay`): a line that
// redefines a command name asks, as a program decided at run time does.

import { describe, it, expect } from 'vitest';
import {
  INSTALLER_PROGRAMS,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  programDecidedAtRunTime,
  staticShellCategories,
  type ShellHost,
} from '../catastrophic-command';

const HOSTS: Array<ShellHost | undefined> = ['windows', 'posix', undefined];

const kindsOn = (cmd: string, host: ShellHost | undefined) => staticShellCategories(cmd, host);

function expectKind(cmds: readonly string[], kind: string, present: boolean): void {
  for (const cmd of cmds)
    for (const host of HOSTS)
      expect(kindsOn(cmd, host).includes(kind as never), `${cmd} (${host})`).toBe(present);
}

describe('delete_files: every delete command, from the floor’s own list (#693) @cap:executer-une-commande/moteur', () => {
  // Remove-Item and every one of its names: the floor's list.
  const removeItemNames = ['Remove-Item', 'ri', 'rm', 'del', 'erase', 'rd', 'rmdir'];

  it('each name of the one list is a delete_files kind', () => {
    expectKind(
      removeItemNames.map((name) => `${name} file.txt`),
      'delete_files',
      true,
    );
  });

  it('and the floor reads each of them, recursive and forced, on a whole disk', () => {
    for (const name of removeItemNames)
      for (const host of HOSTS)
        expect(isCatastrophicCommand(`${name} -Recurse -Force C:\\`, host), name).toBe(true);
  });

  it('the ticket: `erase file.txt` (cmd) and `ri file.txt` (PowerShell)', () => {
    expectKind(['erase file.txt', 'ri file.txt'], 'delete_files', true);
    expectKind(
      ['cmd /c erase /q file.txt', 'powershell -Command "ri file.txt"'],
      'delete_files',
      true,
    );
  });

  it('the unix delete commands, and rsync deleting', () => {
    expectKind(
      [
        'unlink a.txt',
        'shred -u key.pem',
        'srm secret.txt',
        'rd build',
        'rsync -a --delete src/ dst/',
        'rsync -a --delete-after src/ dst/',
        'rsync -a --del src/ dst/',
        'rsync -a --remove-source-files src/ dst/',
        'find . -name "*.tmp" -delete',
      ],
      'delete_files',
      true,
    );
  });

  it('what deletes nothing is not delete_files', () => {
    expectKind(
      [
        'rsync -a src/ dst/',
        'rsync -a --max-delete=0 src/ dst/',
        'rimraf-check --version',
        'git commit -m "erase the typo"',
        'echo ri',
        'Get-ChildItem -Recurse',
      ],
      'delete_files',
      false,
    );
  });
});

// ── install_software ─────────────────────────────────────────────────────────
// Written by hand, program by program, NOT generated from the table they test:
// a broken table cannot make its own cases pass. Each program of the table has
// its own case (one `it` per program), so dropping one entry turns exactly
// that program red; `INSTALLER_PROGRAMS` is compared with the cases both ways,
// so a program added without a case is red too. A simulation is in `acts`: it
// asks like the install it simulates.

/** For one program: commands that install, update or remove, and commands that change nothing. */
interface InstallerCase {
  acts: readonly string[];
  changesNothing?: readonly string[];
}

/** The PowerShell cmdlets that install, update or remove: -WhatIf, or a word read as it, asks too. */
const CMDLETS = [
  'Install-Module',
  'inmo',
  'Uninstall-Module',
  'Update-Module',
  'upmo',
  'Install-Script',
  'Uninstall-Script',
  'Update-Script',
  'Install-Package',
  'Uninstall-Package',
  'Install-PackageProvider',
  'Install-PSResource',
  'isres',
  'Uninstall-PSResource',
  'usres',
  'Update-PSResource',
  'udres',
  'Add-AppxPackage',
  'Add-AppPackage',
  'Add-MsixPackage',
  'Remove-AppxPackage',
  'Remove-AppPackage',
  'Remove-MsixPackage',
  'Install-WindowsFeature',
  'Add-WindowsFeature',
  'Uninstall-WindowsFeature',
  'Remove-WindowsFeature',
  'Add-AppxProvisionedPackage',
  'Add-AppProvisionedPackage',
  'Add-ProvisionedAppPackage',
  'Add-ProvisionedAppxPackage',
  'Remove-AppxProvisionedPackage',
  'Remove-AppProvisionedPackage',
  'Remove-ProvisionedAppPackage',
  'Remove-ProvisionedAppxPackage',
  'Add-WindowsPackage',
  'Remove-WindowsPackage',
  'Add-WindowsCapability',
  'Remove-WindowsCapability',
  'Enable-WindowsOptionalFeature',
  'Disable-WindowsOptionalFeature',
  'Add-WindowsDriver',
  'Remove-WindowsDriver',
  'Install-Language',
  'Uninstall-Language',
];

const WINDOWS_CASES: Record<string, InstallerCase> = {
  msiexec: {
    acts: [
      'msiexec /i pkg.msi',
      'msiexec /i pkg.msi /qn',
      'msiexec.exe /package pkg.msi /quiet',
      'msiexec /x {GUID}',
      'msiexec /uninstall pkg.msi',
      'msiexec -i pkg.msi',
      'msiexec /fa pkg.msi',
      'msiexec /p patch.msp',
      'msiexec /update patch.msp',
      'msiexec /a pkg.msi TARGETDIR=out',
      'msiexec /jm pkg.msi',
      'cmd /c msiexec /i pkg.msi /qn',
    ],
    changesNothing: ['msiexec /?', 'msiexec /h'],
  },
  wusa: {
    acts: [
      'wusa.exe update.msu /quiet',
      'wusa windows10.0-kb5030219-x64.msu /quiet /norestart',
      'wusa.exe /uninstall /kb:5030219',
      'wusa /uninstall /kb:5030219 /quiet /norestart',
      'wusa update.msu /extract:out',
    ],
    changesNothing: ['wusa /?'],
  },
  dism: {
    acts: [
      'dism /online /enable-feature /featurename:x',
      'DISM.exe /Online /Enable-Feature /FeatureName:NetFx3 /All',
      'dism /online /disable-feature /featurename:x',
      'dism /online /add-package /packagepath:x.cab',
      'dism /online /remove-package /packagename:x',
      'dism /online /add-capability /capabilityname:OpenSSH.Server~~~~0.0.1.0',
      'dism /online /remove-capability /capabilityname:x',
      'dism /online /add-provisionedappxpackage /packagepath:x.appx /skiplicense',
      'dism /image:mount /add-driver /driver:x.inf',
      'dism /online /enable-feature /?',
    ],
    changesNothing: [
      'dism /online /get-features',
      'dism /online /get-packages',
      'dism /online /get-capabilities',
    ],
  },
  pnputil: {
    acts: [
      'pnputil /add-driver x.inf /install',
      'pnputil /delete-driver oem1.inf /uninstall',
      'pnputil -i -a x.inf',
    ],
    changesNothing: ['pnputil /enum-drivers', 'pnputil /enum-devices'],
  },
  winget: {
    acts: [
      'winget install Git.Git',
      'winget add Git.Git',
      'winget upgrade --all',
      'winget update Git.Git',
      'winget uninstall Git.Git',
      'winget remove Git.Git',
      'winget rm Git.Git',
      'winget import -i pkgs.json',
      'winget configure cfg.yaml',
      'winget repair Git.Git',
    ],
    changesNothing: ['winget list', 'winget search git', 'winget show Git.Git', 'winget --info'],
  },
  choco: {
    acts: [
      'choco install git -y',
      'choco upgrade all',
      'choco uninstall git',
      'choco install git --noop',
      'choco upgrade all --what-if',
    ],
    changesNothing: ['choco list', 'choco search git'],
  },
  scoop: {
    acts: ['scoop install git', 'scoop update git', 'scoop uninstall git', 'scoop reset python'],
    changesNothing: ['scoop list', 'scoop search git', 'scoop info git'],
  },
  setup: { acts: ['setup.exe /S', 'start setup.exe /quiet'] },
  ...Object.fromEntries(
    CMDLETS.map((name) => [
      name.toLowerCase(),
      { acts: [`${name} X`, `${name} -Online X`, `${name} X -WhatIf`, `${name} X -wi`] },
    ]),
  ),
};

const MACOS_CASES: Record<string, InstallerCase> = {
  installer: {
    acts: [
      'installer -pkg x.pkg -target /',
      'sudo installer -pkg /tmp/x.pkg -target /',
      'installer -package x.pkg -target CurrentUserHomeDirectory',
      'installer -showChoicesXML -pkg x.pkg -target /',
    ],
    changesNothing: [
      'installer -pkginfo -pkg x.pkg',
      'installer -volinfo -pkg x.pkg',
      'installer -dominfo -pkg x.pkg',
      'installer -query RestartAction -pkg x.pkg',
    ],
  },
  softwareupdate: {
    acts: [
      'softwareupdate -i -a',
      'softwareupdate -ia',
      'softwareupdate --install --all',
      'sudo softwareupdate --install-rosetta --agree-to-license',
      'softwareupdate --fetch-full-installer',
    ],
    changesNothing: ['softwareupdate -l', 'softwareupdate --list', 'softwareupdate --history'],
  },
  brew: {
    acts: [
      'brew install x',
      'brew install --cask firefox',
      'brew upgrade',
      'brew reinstall x',
      'brew uninstall x',
      'brew remove x',
      'brew rm x',
      'brew autoremove',
      'brew install -n x',
      'brew upgrade --dry-run',
    ],
    changesNothing: ['brew list', 'brew info x', 'brew search x', 'brew update'],
  },
  port: {
    acts: [
      'sudo port install x',
      'port uninstall x',
      'port upgrade outdated',
      'port activate x',
      'port deactivate x',
      'sudo port selfupdate',
    ],
    changesNothing: ['port search x', 'port info x', 'port installed', 'port outdated'],
  },
  mas: {
    acts: [
      'mas install 497799835',
      'mas uninstall 497799835',
      'mas upgrade',
      'mas purchase 497799835',
      'mas lucky xcode',
    ],
    changesNothing: ['mas list', 'mas search xcode', 'mas info 497799835', 'mas outdated'],
  },
};

const LINUX_CASES: Record<string, InstallerCase> = {
  'apt-get': {
    acts: [
      'apt-get install x',
      'sudo apt-get -y install x',
      'apt-get purge x',
      'apt-get -y upgrade',
      'apt-get dist-upgrade',
      'apt-get autoremove',
      'apt-get -o Dpkg::Options::=--force-confold install x',
      'apt-get build-dep x',
      'apt-get -s upgrade',
      'apt-get --simulate install x',
      'apt-get install --dry-run x',
      'apt-get --just-print dist-upgrade',
      'apt-get --no-act remove x',
      'apt-get -qs install x',
    ],
    changesNothing: ['apt-get update', 'apt-get check', 'apt-get changelog x'],
  },
  apt: {
    acts: [
      'apt remove x',
      'apt full-upgrade',
      'sudo apt install ./x.deb',
      'apt reinstall x',
      'apt -s install x',
    ],
    changesNothing: ['apt list --installed', 'apt show x', 'apt search x', 'apt update'],
  },
  aptitude: {
    acts: [
      'aptitude install x',
      'aptitude safe-upgrade',
      'aptitude purge x',
      'aptitude --simulate full-upgrade',
    ],
    changesNothing: ['aptitude search x', 'aptitude show x'],
  },
  dpkg: {
    acts: [
      'dpkg -i pkg.deb',
      'sudo dpkg -i pkg.deb',
      'dpkg --install pkg.deb',
      'dpkg -r pkg',
      'dpkg -P pkg',
      'dpkg --purge pkg',
      'dpkg -R -i ./debs',
      'dpkg --unpack x.deb',
      'dpkg --configure -a',
      'dpkg --no-act -i pkg.deb',
      'dpkg --simulate --purge pkg',
    ],
    changesNothing: [
      'dpkg -l',
      'dpkg -L curl',
      'dpkg -s curl',
      'dpkg -S /bin/ls',
      'dpkg -p curl',
      'dpkg --print-architecture',
    ],
  },
  rpm: {
    acts: [
      'rpm -Uvh pkg.rpm',
      'rpm -ivh pkg.rpm',
      'rpm -i pkg.rpm',
      'rpm -e pkg',
      'rpm -Fvh pkg.rpm',
      'rpm --upgrade pkg.rpm',
      'rpm --erase pkg',
      'rpm --reinstall pkg.rpm',
      'sudo rpm -U --nodeps pkg.rpm',
      'rpm --test -Uvh pkg.rpm',
      'rpm -e --test pkg',
      // `-i` is --info in query mode, but whether `-q` is the mode or the
      // value of an option before it (`rpm --dbpath -q -i x.rpm`) takes rpm's
      // grammar: it asks
      'rpm -qi curl',
      'rpm -q -i curl',
    ],
    changesNothing: [
      'rpm -q curl',
      'rpm -qa',
      'rpm -ql curl',
      'rpm --query --info curl',
      'rpm -V curl',
      'rpm -E %_arch',
      'rpm --eval %_arch',
    ],
  },
  dnf: {
    acts: [
      'dnf install x',
      'dnf -y install x',
      'dnf in x',
      'dnf remove x',
      'dnf rm x',
      'dnf upgrade',
      'dnf downgrade x',
      'dnf reinstall x',
      'dnf autoremove',
      'dnf distro-sync',
      'dnf swap a b',
      'dnf group install "Development Tools"',
      'dnf module install nodejs:18',
      'dnf history undo last',
    ],
    changesNothing: [
      'dnf list installed',
      'dnf info x',
      'dnf search x',
      'dnf repoquery x',
      'dnf check-update',
      'dnf makecache',
      'dnf history list',
      'dnf group list',
      'dnf module list',
    ],
  },
  dnf5: { acts: ['dnf5 install x'], changesNothing: ['dnf5 search x'] },
  yum: {
    acts: [
      'yum update',
      'yum install x',
      'yum erase x',
      'yum localinstall x.rpm',
      'yum groupinstall "Development Tools"',
    ],
    changesNothing: ['yum info x', 'yum list installed', 'yum check-update'],
  },
  microdnf: {
    acts: ['microdnf install x', 'microdnf remove x'],
    changesNothing: ['microdnf repolist'],
  },
  tdnf: { acts: ['tdnf install x'], changesNothing: ['tdnf list'] },
  zypper: {
    acts: [
      'zypper in x',
      'zypper install x',
      'zypper rm x',
      'zypper dup',
      'zypper update',
      'zypper patch',
      'zypper --non-interactive install x',
      'zypper si x',
      'zypper ve',
      'zypper -D /etc/zypp/repos.d install x',
      'zypper install --dry-run x',
    ],
    changesNothing: ['zypper search x', 'zypper info x', 'zypper refresh', 'zypper lr'],
  },
  pacman: {
    acts: [
      'pacman -S x',
      'pacman -Syu',
      'pacman -R x',
      'pacman -Rs x',
      'pacman -Rns x',
      'pacman -U x.pkg.tar.zst',
      'pacman --sync x',
      'pacman --remove x',
      'sudo pacman -S --needed x',
      // -S's reads and -p: in a group, a letter after one that takes a value
      // is that value (`-Srs` is -S with the root `s`), so they ask
      'pacman -Ss x',
      'pacman -Sp x',
      'pacman --sync --search x',
    ],
    changesNothing: ['pacman -Qi x', 'pacman -Q', 'pacman -Qs x'],
  },
  apk: {
    acts: [
      'apk add curl',
      'apk del curl',
      'apk upgrade',
      'apk fix',
      'apk --no-cache add curl',
      'apk -s add curl',
    ],
    changesNothing: ['apk info', 'apk search curl', 'apk update'],
  },
  emerge: {
    acts: [
      'emerge www-client/firefox',
      'emerge -avuDN @world',
      'emerge --ask x',
      'emerge -C x',
      'emerge --unmerge x',
      'emerge --depclean',
      'emerge -c',
      'emerge -P x',
      'emerge --pretend x',
      'emerge -pv @world',
      // a search names an atom too, and whether `--search` is the mode or a
      // value takes emerge's grammar
      'emerge --search firefox',
    ],
    changesNothing: ['emerge --info', 'emerge --sync'],
  },
  snap: {
    acts: ['snap install x', 'sudo snap remove x', 'snap refresh x', 'snap revert x'],
    changesNothing: ['snap list', 'snap info x', 'snap find x'],
  },
  flatpak: {
    acts: ['flatpak install flathub org.x.App', 'flatpak uninstall org.x.App', 'flatpak update'],
    changesNothing: ['flatpak list', 'flatpak info org.x.App', 'flatpak search x'],
  },
  pkcon: {
    acts: [
      'pkcon install x',
      'pkcon install-local x.rpm',
      'pkcon remove x',
      'pkcon update',
      'pkcon upgrade-system 40',
    ],
    changesNothing: ['pkcon search name x', 'pkcon get-details x', 'pkcon refresh'],
  },
  'nix-env': {
    acts: [
      'nix-env -iA nixpkgs.hello',
      'nix-env -e hello',
      'nix-env -u',
      'nix-env --install hello',
      'nix-env --rollback',
      'nix-env -G 42',
      'nix-env --set /nix/store/x',
      'nix-env -iA nixpkgs.hello --dry-run',
    ],
    changesNothing: [
      'nix-env -q',
      'nix-env -qaP hello',
      'nix-env --query --installed',
      'nix-env --list-generations',
    ],
  },
  nix: {
    acts: [
      'nix profile install nixpkgs#hello',
      'nix profile add nixpkgs#hello',
      'nix profile remove hello',
      'nix profile upgrade --all',
      'nix profile rollback',
    ],
    changesNothing: [
      'nix profile list',
      'nix search nixpkgs hello',
      'nix build .',
      'nix profile history',
    ],
  },
  pkg: {
    acts: [
      'pkg install x',
      'pkg delete x',
      'pkg remove x',
      'pkg upgrade',
      'pkg autoremove',
      'pkg add ./x.pkg',
      'pkg install -n x',
    ],
    changesNothing: ['pkg info', 'pkg search x', 'pkg update'],
  },
};

const CROSS_PLATFORM_CASES: Record<string, InstallerCase> = {
  npm: {
    acts: [
      'npm install x',
      'npm i -g x',
      'npm ci',
      'npm uninstall x',
      'npm update',
      'npm install --dry-run x',
      'npm uninstall x --dry-run',
    ],
    changesNothing: ['npm ls', 'npm run build', 'npm view x'],
  },
  pnpm: {
    acts: ['pnpm add x', 'pnpm remove x', 'pnpm --filter web up x', 'pnpm i'],
    changesNothing: ['pnpm list', 'pnpm run build'],
  },
  yarn: {
    acts: ['yarn add x', 'yarn remove x', 'yarn global add x', 'yarn upgrade'],
    changesNothing: ['yarn list', 'yarn run build', 'yarn info x'],
  },
  bun: {
    acts: ['bun add x', 'bun remove x', 'bun install --dry-run'],
    changesNothing: ['bun run build', 'bun pm ls'],
  },
  pip: {
    acts: [
      'pip install x',
      'python -m pip install x',
      'pip uninstall -y x',
      'pip install --dry-run x',
    ],
    changesNothing: ['pip list', 'pip show x', 'pip freeze'],
  },
  pip3: { acts: ['pip3 install x', 'pip3.12 install x'], changesNothing: ['pip3 freeze'] },
  pipx: {
    acts: [
      'pipx install black',
      'pipx uninstall black',
      'pipx upgrade-all',
      'pipx inject black x',
      'pipx reinstall-all',
    ],
    changesNothing: ['pipx list', 'pipx environment'],
  },
  uv: {
    acts: [
      'uv pip install x',
      'uv pip sync requirements.txt',
      'uv add x',
      'uv remove x',
      'uv tool install ruff',
      'uv tool upgrade ruff',
      'uv python install 3.12',
      'uv pip install --dry-run x',
    ],
    changesNothing: ['uv pip list', 'uv run pytest', 'uv tool list', 'uv python list'],
  },
  go: {
    acts: [
      'go install golang.org/x/tools/gopls@latest',
      'go install -trimpath ./cmd/x',
      'go install -n ./...',
    ],
    changesNothing: ['go build ./...', 'go list -m all'],
  },
  gem: {
    acts: [
      'gem install rails',
      'gem i rails',
      'gem uninstall rails',
      'gem update',
      'gem install rails --explain',
    ],
    changesNothing: ['gem list', 'gem search rails'],
  },
  cargo: {
    acts: ['cargo install ripgrep', 'cargo uninstall ripgrep', 'cargo install --list'],
    changesNothing: ['cargo build'],
  },
  conda: {
    acts: [
      'conda install numpy',
      'conda remove numpy',
      'conda update --all',
      'conda install -c conda-forge x',
      'conda install -d numpy',
      'conda install --dry-run numpy',
    ],
    changesNothing: ['conda list', 'conda env list'],
  },
  mamba: { acts: ['mamba install x', 'mamba install --dry-run x'], changesNothing: ['mamba list'] },
  micromamba: {
    acts: ['micromamba install x', 'micromamba install --dry-run x'],
    changesNothing: ['micromamba list'],
  },
  comfy: {
    acts: [
      'comfy install',
      'comfy install --nvidia',
      'comfy --workspace=/x install',
      'comfy node install comfyui-impact-pack',
      'comfy node uninstall x',
      'comfy node update all',
      'comfy update',
    ],
    changesNothing: ['comfy launch', 'comfy node show installed'],
  },
};

const ALL_CASES = { ...WINDOWS_CASES, ...MACOS_CASES, ...LINUX_CASES, ...CROSS_PLATFORM_CASES };

function expectInstallerCase(c: InstallerCase): void {
  expectKind(c.acts, 'install_software', true);
  expectKind(c.changesNothing ?? [], 'install_software', false);
}

describe('install_software: every standard installer of Windows, macOS and Linux, one case per program (#693) @cap:executer-une-commande/moteur', () => {
  it('every program the reader knows has its case here, and every case is a program it knows', () => {
    expect(Object.keys(ALL_CASES).sort()).toEqual([...INSTALLER_PROGRAMS].sort());
  });

  for (const [family, cases] of Object.entries({
    windows: WINDOWS_CASES,
    macos: MACOS_CASES,
    linux: LINUX_CASES,
    'cross-platform': CROSS_PLATFORM_CASES,
  }))
    describe(family, () => {
      for (const [program, c] of Object.entries(cases))
        it(program, () => {
          expectInstallerCase(c);
        });
    });
});

describe('install_software: written out by hand, one per OS, outside any table (#693) @cap:executer-une-commande/moteur', () => {
  // Codex's examples, and one command per OS family: a table emptied by
  // mistake turns these red whatever the cases above say.
  it('Windows', () => {
    expect(staticShellCategories('wusa.exe update.msu /quiet', 'windows')).toContain(
      'install_software',
    );
    expect(staticShellCategories('wusa.exe /uninstall /kb:5030219', 'windows')).toContain(
      'install_software',
    );
    expect(staticShellCategories('Install-PackageProvider NuGet', 'windows')).toContain(
      'install_software',
    );
  });

  it('macOS', () => {
    expect(staticShellCategories('sudo installer -pkg x.pkg -target /', 'posix')).toContain(
      'install_software',
    );
  });

  it('Linux', () => {
    expect(staticShellCategories('rpm -Uvh pkg.rpm', 'posix')).toContain('install_software');
    expect(staticShellCategories('dpkg -i pkg.deb', 'posix')).toContain('install_software');
  });

  it('a package file run as a program goes to its installer', () => {
    expectKind(
      [
        'x.msi',
        'pkg.msi /quiet',
        'start update.msu',
        'cmd /c start "" app.msix',
        'powershell -Command "Start-Process app.appx"',
        './x.pkg',
      ],
      'install_software',
      true,
    );
    expectKind(['notepad readme.txt', 'type x.msi.txt'], 'install_software', false);
  });

  it('wrapped as each OS runs them: the wrapper does not hide the installer, nor its simulation', () => {
    expectKind(
      [
        'cmd /c msiexec /i pkg.msi /qn',
        'powershell -Command "Install-Module Pester -Force"',
        'sudo -u root dnf install x',
        'bash -c "apt-get install -y x"',
        'uvx --from comfy-cli comfy install --nvidia',
        'powershell -Command "inmo Pester -wi"',
        'bash -c "apt-get -s upgrade"',
        'sh -c "rpm --test -Uvh x.rpm"',
      ],
      'install_software',
      true,
    );
  });

  it('destructive_gate gates what the kind files, a simulation included', () => {
    for (const cmd of [
      'wusa.exe update.msu /quiet',
      'dpkg -i x.deb',
      'Install-PackageProvider NuGet',
      'apt-get -s upgrade',
      'rpm --test -Uvh x.rpm',
      'Install-Module x -WhatIf',
    ])
      for (const host of HOSTS) expect(isDestructiveOrHeavyCommand(cmd, host), cmd).toBe(true);
    for (const cmd of ['apt list --installed', 'rpm -q curl', 'winget list'])
      for (const host of HOSTS) expect(isDestructiveOrHeavyCommand(cmd, host), cmd).toBe(false);
  });
});

describe('install_software: a simulation asks like the install it simulates (#710, Codex pass 2) @cap:executer-une-commande/moteur', () => {
  // Whether a word is a simulation flag or the value of the option before it
  // takes each program's whole option grammar: `apt-get -c --simulate install
  // cowsay` reads `--simulate` as -c's config file and installs. What the text
  // cannot establish asks, so no flag makes an install a simulation any more.
  it('Codex: `--simulate` as the value of `-c` installs, and asks', () => {
    const cmd = 'touch -- --simulate && apt-get -c --simulate install cowsay';
    for (const host of HOSTS) {
      expect(kindsOn(cmd, host), `${host}`).toContain('install_software');
      expect(isDestructiveOrHeavyCommand(cmd, host), `${host}`).toBe(true);
    }
  });

  it('the same shape on other programs: a dry-run or read flag taken as a value', () => {
    expectKind(
      [
        'dpkg --admindir --no-act -i x.deb',
        'rpm --dbpath -q -i x.rpm',
        'rpm --dbpath --test -Uvh x.rpm',
        'pacman --config -Ss -S x',
        'pacman -Srs x',
        'npm --cache --dry-run install x',
        'brew install --cask -n x',
      ],
      'install_software',
      true,
    );
  });

  it('PowerShell: -WhatIf that is a value is no -WhatIf, and a unit has lost its quotes', () => {
    // `Install-Module '-WhatIf'` installs a module of that name; once read
    // into words it is `Install-Module -WhatIf`. The binder cannot tell, so
    // -WhatIf asks whatever its place.
    expectKind(
      [
        "Install-Module '-WhatIf'",
        "Install-Module X -Repository '-WhatIf'",
        'Install-Module X -Name -WhatIf',
        'Install-Module X -WhatIf',
        'Install-Module X -WhatIf:$true',
      ],
      'install_software',
      true,
    );
  });

  it('each OS’s simulations ask, written out by hand', () => {
    expectKind(
      [
        // Windows
        'choco install git --noop',
        'wusa update.msu /extract:out',
        'powershell -Command "Install-Module Pester -WhatIf"',
        // macOS
        'brew install --dry-run x',
        'installer -showChoicesXML -pkg x.pkg -target /',
        // Linux
        'apt-get -s install x',
        'dpkg --no-act -i pkg.deb',
        'rpm --test -Uvh pkg.rpm',
        'zypper install --dry-run x',
        'apk add --simulate curl',
        'emerge -p x',
      ],
      'install_software',
      true,
    );
  });

  it('a read names no action, and stays unflagged', () => {
    expectKind(
      [
        'apt list --installed',
        'apt-get update',
        'winget list',
        'brew info x',
        'dnf search x',
        'rpm -q curl',
        'dpkg -l',
        'msiexec /?',
        'pacman -Qi x',
        'Get-Module -ListAvailable',
      ],
      'install_software',
      false,
    );
  });
});

describe('install_software: a verb of the program anywhere in its words asks (#710) @cap:executer-une-commande/moteur', () => {
  // The reader walked the options to the subcommand, each taking at most one
  // value: `nix --option sandbox false profile install x` (a two-value option)
  // never reached `profile install`. Placing the verb takes each program's
  // whole option grammar, so a verb word anywhere in the unit asks.
  it('nix: a two-value option before `profile install`', () => {
    for (const cmd of [
      'nix --option sandbox false profile install x',
      'nix --argstr system x86_64-linux profile install x',
    ])
      for (const host of HOSTS) {
        expect(kindsOn(cmd, host), `${cmd} (${host})`).toContain('install_software');
        expect(isDestructiveOrHeavyCommand(cmd, host), `${cmd} (${host})`).toBe(true);
      }
  });

  it('an option value hides the verb, on each OS', () => {
    expectKind(
      [
        // Windows
        'winget --header=a b install x',
        'choco --source a b install x',
        'scoop -k a b install x',
        // macOS
        'brew --repo a b install x',
        'port -D a b install x',
        'mas --opt=a b install 497799835',
        // Linux
        'dnf module -y install nodejs',
        'dnf --setopt a b install x',
        'apt-get --option=a b install x',
        'apk --repository a b add curl',
        'nix profile --profile /tmp/p install x',
        // cross-platform
        'npm --prefix a b install x',
        'yarn workspace web add x',
        'uv pip --verbose install x',
        'pip --proxy a b install x',
        // a verb after `--`
        'apt-get -c a.conf b -- install x',
      ],
      'install_software',
      true,
    );
  });

  it('Codex pass 2 still asks', () => {
    expectKind(['apt-get -c --simulate install cowsay'], 'install_software', true);
  });

  it('accepted over-ask: a read that names a verb word of its program asks', () => {
    // The trade-off, pinned: these change nothing, and ask.
    expectKind(
      [
        'zypper search patch',
        'npm search install',
        'npm test -- --grep install',
        'brew search rm',
        'winget search update',
        'dnf info update',
        'pip show install',
        'apt show remove',
        'go doc install',
        'snap info refresh',
      ],
      'install_software',
      true,
    );
  });

  it('a read with no verb of its program anywhere stays unflagged', () => {
    expectKind(
      [
        'apt list --installed',
        'dnf search x',
        'dnf history list',
        'dnf group list',
        'nix profile list',
        'nix search nixpkgs hello',
        'npm ls',
        'pnpm test',
        'winget search git',
        'brew search git',
        'zypper search vim',
        'pip show requests',
      ],
      'install_software',
      false,
    );
  });
});

describe('install_software: a word decided at run time could be the verb, and asks (#710, Codex pass 3) @cap:executer-une-commande/moteur', () => {
  // `verb=install; apt-get "$verb" cowsay` installs, and its words name no
  // verb: the reader matched literal words only. A word the text does not
  // hold (a variable, a substitution, cmd's `%V%` / `!V!`, a splat) could be
  // any verb of the program, so it asks, read by the same detector as a
  // program name decided at run time (`isDecidedAtRunTime`) and the splat of
  // the PowerShell binder (`isSplat`).
  it('Codex: the verb in a variable', () => {
    for (const cmd of ['verb=install; apt-get "$verb" cowsay', 'apt-get $verb cowsay'])
      for (const host of HOSTS) {
        expect(kindsOn(cmd, host), `${cmd} (${host})`).toContain('install_software');
        expect(isDestructiveOrHeavyCommand(cmd, host), `${cmd} (${host})`).toBe(true);
      }
  });

  it('sh: a parameter expansion, a command substitution, backticks', () => {
    expectKind(
      [
        'apt-get ${verb} cowsay',
        'apt-get "${verb:-install}" cowsay',
        'apt-get $(echo install) cowsay',
        'apt-get `echo install` cowsay',
        'brew "$@"',
        'sh -c "dnf $1 x" _ install',
        'nix profile "$sub" x',
      ],
      'install_software',
      true,
    );
  });

  it('cmd: %VAR%, a batch parameter, delayed !VAR!', () => {
    expectKind(
      [
        'winget %V% x',
        'cmd /c "winget %V% x"',
        'cmd /c "choco %1 x"',
        'cmd /v:on /c "winget !V! x"',
        'for %v in (install) do winget %v x',
      ],
      'install_software',
      true,
    );
  });

  it('PowerShell: a variable, a subexpression, a splat', () => {
    expectKind(
      [
        'winget $v x',
        "winget $('install') x",
        'winget @a',
        'powershell -Command "winget $v x"',
        'pwsh -c "choco @args"',
        'powershell -Command "scoop $(Get-Verb) x"',
      ],
      'install_software',
      true,
    );
  });

  it('a program name decided at run time is inline code already, not read again here', () => {
    for (const cmd of ['$pm install x', '%PM% install x', '& $pm install x'])
      for (const host of HOSTS)
        expect(kindsOn(cmd, host), `${cmd} (${host})`).toContain('inline_code');
  });

  it('the earlier Codex cases still ask', () => {
    expectKind(
      ['apt-get -c --simulate install cowsay', 'nix --option sandbox false profile install x'],
      'install_software',
      true,
    );
  });

  it('accepted over-ask: a read whose operand is decided at run time asks', () => {
    // The trade-off, pinned: the word may be an operand, not the verb.
    expectKind(
      ['npm run "$script"', 'pip show "$pkg"', 'apt list "$pkg"', 'winget search %Q%'],
      'install_software',
      true,
    );
  });

  it('a runtime word elsewhere on the line, or a literal read, stays unflagged', () => {
    expectKind(
      [
        'echo "$verb" && apt list --installed',
        'v=$(cat f); npm ls',
        'set V=install & winget search git',
        'Write-Host $v; pip show requests',
        'winget search git',
      ],
      'install_software',
      false,
    );
  });
});

describe('a line that redefines a command name asks, as inline code (#710, Codex pass 4) @cap:executer-une-commande/moteur', () => {
  // `alias npm='npm install'` then `npm cowsay` installs, and no word of the
  // line names an install: an alias's text is a string the reading does not
  // read as a command. Resolving aliases would be a second shell; the rule is
  // instead that a line redefining a command name runs programs its text does
  // not name, which is what a program decided at run time already is: the
  // `inline_code` kind, which asks even when inline code is allowed
  // (`programDecidedAtRunTime`), and `destructive_gate` gates it.
  function expectRedefinition(cmds: readonly string[], reader?: 'powershell'): void {
    for (const cmd of cmds)
      for (const host of HOSTS) {
        const at = `${cmd} (${host})`;
        expect(staticShellCategories(cmd, host, reader), at).toContain('inline_code');
        expect(programDecidedAtRunTime(cmd, host, reader), at).toBe(true);
        if (reader === undefined) expect(isDestructiveOrHeavyCommand(cmd, host), at).toBe(true);
      }
  }

  function expectNoRedefinition(cmds: readonly string[], reader?: 'powershell'): void {
    for (const cmd of cmds)
      for (const host of HOSTS) {
        const at = `${cmd} (${host})`;
        expect(staticShellCategories(cmd, host, reader), at).not.toContain('inline_code');
        expect(programDecidedAtRunTime(cmd, host, reader), at).toBe(false);
      }
  }

  it('Codex: an alias, then its use', () => {
    expectRedefinition(["shopt -s expand_aliases\nalias npm='npm install'\nnpm cowsay"]);
  });

  it('sh, bash, zsh, fish: an alias, `hash -p`, the alias arrays', () => {
    expectRedefinition([
      "alias npm='npm install'; npm cowsay",
      "alias npm 'npm install'; npm cowsay",
      'hash -p /usr/bin/apt-get ls; ls install x',
      "BASH_ALIASES[npm]='npm install'; npm cowsay",
      "aliases[ls]='rm -rf'; ls x",
      "functions[ls]='rm -rf x'; ls",
      `bash -c "alias npm='npm install'; npm cowsay"`,
    ]);
  });

  it('PowerShell: Set-Alias, New-Alias, Import-Alias, and the alias: and function: drives', () => {
    const lines = [
      'Set-Alias ls Remove-Item; ls x',
      'sal ls Remove-Item; ls x',
      'New-Alias -Name ls -Value Remove-Item; ls x',
      'nal ls Remove-Item; ls x',
      'Import-Alias aliases.csv; ls x',
      "Set-Item -Path Function:npm -Value 'winget install x'; npm",
      "$function:npm = 'winget install x'; npm",
      "${function:npm} = 'winget install x'; npm",
      'Set-Item alias:ls Remove-Item; ls x',
    ];
    expectRedefinition(lines, 'powershell');
    // As run_command starts PowerShell, on each host.
    expectRedefinition([
      'powershell -Command "Set-Alias ls Remove-Item; ls x"',
      'pwsh -c "sal ls Remove-Item; ls x"',
      'powershell -Command "nal ls Remove-Item; ls x"',
      'powershell -Command "Set-Item function:npm {winget install x}; npm"',
    ]);
  });

  it('PowerShell: the alias and function providers however the path names them (Codex, pass 5)', () => {
    // Each form defines `zz` in a real powershell.exe 5.1 (checked on 2026-10-12);
    // a wildcard in the drive or provider name is refused there, so not read.
    expectRedefinition(
      [
        'Set-Item Microsoft.PowerShell.Core\\Alias::zz winget; zz install cowsay',
        'Set-Item Alias::zz winget; zz install cowsay',
        'Set-Item -Path:alias:zz winget; zz install cowsay',
        "Set-Content Microsoft.PowerShell.Core\\Function::zz 'winget install x'; zz",
        'Set-Location Microsoft.PowerShell.Core\\Alias::; Set-Item zz winget; zz install cowsay',
        "New-PSDrive -Name q -PSProvider Alias -Root ''; Set-Item q:zz winget; zz install cowsay",
        "New-PSDrive -PSProvider:Function -Name q -Root ''; Set-Item q:zz {winget install x}; zz",
        "ndr q Microsoft.PowerShell.Core\\Alias ''; Set-Item q:zz winget; zz install cowsay",
      ],
      'powershell',
    );
    // A drive over another provider redefines nothing.
    expectNoRedefinition(
      ['New-PSDrive -Name w -PSProvider FileSystem -Root C:\\work'],
      'powershell',
    );
  });

  it('cmd: a doskey macro', () => {
    expectRedefinition([
      'doskey npm=npm install $*',
      'cmd /c "doskey ls=del $* & ls x"',
      'doskey /macrofile=macros.txt',
    ]);
  });

  it('the earlier Codex cases still ask', () => {
    expectKind(
      [
        'apt-get -c --simulate install cowsay',
        'nix --option sandbox false profile install x',
        'verb=install; apt-get "$verb" cowsay',
      ],
      'install_software',
      true,
    );
  });

  it('accepted over-ask: a line that only shows an alias or a function', () => {
    expectRedefinition(['alias ll']);
    expectRedefinition(['Get-Item function:prompt'], 'powershell');
  });

  it('a function written with its body is read where it stands, not redefined', () => {
    // Its body is commands of the line: what it does is read there.
    expect(
      staticShellCategories('npm() { command npm install x; }; npm cowsay', 'posix'),
    ).toContain('install_software');
    expect(staticShellCategories('f() { "$@"; }; f rm -rf x', 'posix')).toContain('inline_code');
    expectNoRedefinition(['greet() { echo hi; }; greet', 'function greet { echo hi; }; greet']);
    expectNoRedefinition(['function greet { Write-Host hi }; greet'], 'powershell');
  });

  it('a line that redefines nothing is unchanged', () => {
    expectNoRedefinition([
      'alias',
      'alias -p',
      'hash',
      'hash -r',
      'doskey /macros',
      'echo alias npm=x',
      'npm cowsay',
      'arr[0]=/usr/bin/rm; echo ok',
    ]);
    expectNoRedefinition(['Get-Alias ls', 'Get-ChildItem env:'], 'powershell');
  });
});

describe('a program named with the extension Windows runs it by is that program (#710, Codex pass 6) @cap:executer-une-commande/moteur', () => {
  // npm, pnpm and yarn ship `.cmd` and `.ps1` shims, conda a `.bat`: each one
  // runs by its full name in cmd.exe and in PowerShell.
  it('an installer named with .cmd, .bat, .ps1 or .exe, in any case, installs', () => {
    expectKind(
      [
        'npm.cmd install lodash',
        'pnpm.cmd add lodash',
        'yarn.cmd add lodash',
        'conda.bat install numpy',
        'npm.ps1 install lodash',
        'NPM.CMD install lodash',
        'C:/Users/me/AppData/Roaming/npm/npm.cmd install lodash',
        'winget.EXE install x',
      ],
      'install_software',
      true,
    );
  });

  it('a delete command named with its extension deletes', () => {
    expectKind(['rm.exe -rf build', 'rmdir.bat build'], 'delete_files', true);
  });

  it('a read named with its extension stays a read', () => {
    expectKind(['npm.cmd ls', 'conda.bat list'], 'install_software', false);
  });
});
