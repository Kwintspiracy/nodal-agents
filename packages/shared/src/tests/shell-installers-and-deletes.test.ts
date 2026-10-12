// shell-installers-and-deletes.test.ts — the standard installers and delete
// commands of Windows, macOS and Linux, and their read-only uses (#693).
//
// `msiexec /i`, `dpkg -i`, `rpm -Uvh`, `snap install`, `flatpak install`,
// macOS `installer -pkg`, cmd's `erase` and PowerShell's `ri` ran with no ask
// under the default policy: no kind of the checklist covered them. The floor
// already knew `erase` and `ri`; the kind kept a list of its own, and the two
// drifted. One list now feeds both, and each kind covers every OS's forms.
// Codex (PR #710, pass 1) found the next installers missing (`wusa`,
// `Install-PackageProvider`) and simulations taken for installs (`apt-get -s`,
// `dpkg --no-act`, `rpm --test`): every standard installer is now listed, and
// every documented dry run read, per OS.

import { describe, it, expect } from 'vitest';
import {
  INSTALLER_PROGRAMS,
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
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
// so a program added without a case is red too.

/** For one program: commands that install, update or remove, and commands that change nothing. */
interface InstallerCase {
  acts: readonly string[];
  changesNothing?: readonly string[];
}

/** PowerShell cmdlets that support ShouldProcess: -WhatIf runs nothing. */
const CMDLETS_WITH_WHATIF = [
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
];

/** The DISM-module cmdlets and their kin: no -WhatIf (`Get-Command` on Windows 11). */
const CMDLETS_WITHOUT_WHATIF = [
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
    ],
    changesNothing: ['wusa /?', 'wusa update.msu /extract:out'],
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
    ],
    changesNothing: [
      'dism /online /get-features',
      'dism /online /get-packages',
      'dism /online /get-capabilities',
      'dism /online /enable-feature /?',
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
    acts: ['choco install git -y', 'choco upgrade all', 'choco uninstall git'],
    changesNothing: [
      'choco list',
      'choco search git',
      'choco install git --noop',
      'choco install git --whatif',
      'choco upgrade all --what-if',
    ],
  },
  scoop: {
    acts: ['scoop install git', 'scoop update git', 'scoop uninstall git', 'scoop reset python'],
    changesNothing: ['scoop list', 'scoop search git', 'scoop info git'],
  },
  setup: { acts: ['setup.exe /S', 'start setup.exe /quiet'] },
  ...Object.fromEntries(
    CMDLETS_WITH_WHATIF.map((name) => [
      name.toLowerCase(),
      {
        acts: [`${name} X`, `${name} -Name X -WhatIf:$false`, `${name} X -WhatIf:$f`],
        changesNothing: [`${name} X -WhatIf`, `${name} X -wi`, `${name} X -WhatIf:$true`],
      },
    ]),
  ),
  ...Object.fromEntries(
    CMDLETS_WITHOUT_WHATIF.map((name) => [
      name.toLowerCase(),
      // No -WhatIf: `-wi` is a prefix of -WindowsDirectory on the DISM cmdlets,
      // and the command runs.
      { acts: [`${name} -Online X`, `${name} -Online X -wi C:\\Windows`] },
    ]),
  ),
};

const MACOS_CASES: Record<string, InstallerCase> = {
  installer: {
    acts: [
      'installer -pkg x.pkg -target /',
      'sudo installer -pkg /tmp/x.pkg -target /',
      'installer -package x.pkg -target CurrentUserHomeDirectory',
    ],
    changesNothing: [
      'installer -pkginfo -pkg x.pkg',
      'installer -volinfo -pkg x.pkg',
      'installer -dominfo -pkg x.pkg',
      'installer -query RestartAction -pkg x.pkg',
      'installer -showChoicesXML -pkg x.pkg -target /',
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
      'brew install --dry-run=false x',
    ],
    changesNothing: [
      'brew list',
      'brew info x',
      'brew search x',
      'brew update',
      'brew install -n x',
      'brew upgrade --dry-run',
    ],
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
    ],
    changesNothing: [
      'apt-get -s upgrade',
      'apt-get --simulate install x',
      'apt-get install --dry-run x',
      'apt-get --just-print dist-upgrade',
      'apt-get --recon install x',
      'apt-get --no-act remove x',
      'apt-get -qs install x',
      'apt-get update',
      'apt-get check',
      'apt-get changelog x',
    ],
  },
  apt: {
    acts: ['apt remove x', 'apt full-upgrade', 'sudo apt install ./x.deb', 'apt reinstall x'],
    changesNothing: [
      'apt list --installed',
      'apt show x',
      'apt search x',
      'apt update',
      'apt -s install x',
      'apt install -s x',
    ],
  },
  aptitude: {
    acts: ['aptitude install x', 'aptitude safe-upgrade', 'aptitude purge x'],
    changesNothing: [
      'aptitude search x',
      'aptitude show x',
      'aptitude -s install x',
      'aptitude --simulate full-upgrade',
    ],
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
    ],
    changesNothing: [
      'dpkg -l',
      'dpkg -L curl',
      'dpkg -s curl',
      'dpkg -S /bin/ls',
      'dpkg -p curl',
      'dpkg --print-architecture',
      'dpkg --no-act -i pkg.deb',
      'dpkg --dry-run -r pkg',
      'dpkg --simulate --purge pkg',
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
    ],
    changesNothing: [
      'rpm -q curl',
      'rpm -qa',
      'rpm -qi curl',
      'rpm -qip x.rpm',
      'rpm -ql curl',
      'rpm -q -i curl',
      'rpm --query --info curl',
      'rpm -V curl',
      'rpm -E %_arch',
      'rpm --eval %_arch',
      'rpm --test -Uvh pkg.rpm',
      'rpm -e --test pkg',
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
      // -D before the command is the global --reposd-dir, not a dry run
      'zypper -D /etc/zypp/repos.d install x',
    ],
    changesNothing: [
      'zypper search x',
      'zypper info x',
      'zypper refresh',
      'zypper lr',
      'zypper install --dry-run x',
      'zypper dup --dry-run',
    ],
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
    ],
    changesNothing: [
      'pacman -Ss x',
      'pacman -Si x',
      'pacman -Sg',
      'pacman -Sl',
      'pacman -Sc',
      'pacman -Sw x',
      'pacman -Qi x',
      'pacman -Q',
      'pacman -Sp x',
      'pacman -Rp x',
      'pacman -S --print x',
      'pacman --sync --search x',
    ],
  },
  apk: {
    acts: ['apk add curl', 'apk del curl', 'apk upgrade', 'apk fix', 'apk --no-cache add curl'],
    changesNothing: [
      'apk info',
      'apk search curl',
      'apk update',
      'apk -s add curl',
      'apk add --simulate curl',
    ],
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
    ],
    changesNothing: [
      'emerge -p x',
      'emerge --pretend x',
      'emerge -pv @world',
      'emerge -s firefox',
      'emerge --search firefox',
      'emerge -S firefox',
      'emerge --info',
      'emerge --sync',
    ],
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
    ],
    changesNothing: [
      'nix-env -q',
      'nix-env -qaP hello',
      'nix-env --query --installed',
      'nix-env -iA nixpkgs.hello --dry-run',
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
    ],
    changesNothing: [
      'pkg info',
      'pkg search x',
      'pkg update',
      'pkg install -n x',
      'pkg upgrade --dry-run',
    ],
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
      'npm install --dry-run=false x',
      'npm install --dry-run false x',
    ],
    changesNothing: [
      'npm ls',
      'npm run build',
      'npm view x',
      'npm install --dry-run x',
      'npm uninstall x --dry-run',
    ],
  },
  pnpm: {
    acts: ['pnpm add x', 'pnpm remove x', 'pnpm --filter web up x', 'pnpm i'],
    changesNothing: ['pnpm list', 'pnpm run build'],
  },
  yarn: {
    acts: ['yarn add x', 'yarn remove x', 'yarn global add x', 'yarn upgrade'],
    changesNothing: ['yarn list', 'yarn run build', 'yarn info x'],
  },
  // bun's --dry-run still runs the project's lifecycle scripts: not a dry run
  bun: {
    acts: ['bun add x', 'bun remove x', 'bun install --dry-run'],
    changesNothing: ['bun run build', 'bun pm ls'],
  },
  pip: {
    acts: ['pip install x', 'python -m pip install x', 'pip uninstall -y x'],
    changesNothing: ['pip list', 'pip show x', 'pip install --dry-run x', 'pip freeze'],
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
    ],
    changesNothing: [
      'uv pip list',
      'uv run pytest',
      'uv pip install --dry-run x',
      'uv tool list',
      'uv python list',
    ],
  },
  go: {
    acts: [
      'go install golang.org/x/tools/gopls@latest',
      'go install -trimpath ./cmd/x',
      // `-installsuffix` is one flag, not a group holding `-n`
      'go install -installsuffix x ./...',
    ],
    changesNothing: ['go install -n ./...', 'go build ./...', 'go list -m all'],
  },
  gem: {
    acts: ['gem install rails', 'gem i rails', 'gem uninstall rails', 'gem update'],
    changesNothing: ['gem list', 'gem install rails --explain', 'gem search rails'],
  },
  cargo: {
    acts: ['cargo install ripgrep', 'cargo uninstall ripgrep'],
    changesNothing: ['cargo build', 'cargo install --list'],
  },
  conda: {
    acts: [
      'conda install numpy',
      'conda remove numpy',
      'conda update --all',
      'conda install -c conda-forge x',
    ],
    changesNothing: [
      'conda list',
      'conda install -d numpy',
      'conda install --dry-run numpy',
      'conda env list',
    ],
  },
  mamba: { acts: ['mamba install x'], changesNothing: ['mamba install --dry-run x', 'mamba list'] },
  micromamba: {
    acts: ['micromamba install x'],
    changesNothing: ['micromamba install --dry-run x', 'micromamba list'],
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
    expect(
      staticShellCategories('powershell -Command "Install-Module Pester -WhatIf"', 'windows'),
    ).not.toContain('install_software');
  });

  it('macOS', () => {
    expect(staticShellCategories('sudo installer -pkg x.pkg -target /', 'posix')).toContain(
      'install_software',
    );
    expect(staticShellCategories('brew install -n x', 'posix')).not.toContain('install_software');
  });

  it('Linux: the simulations Codex named change nothing', () => {
    expect(staticShellCategories('apt-get -s upgrade', 'posix')).not.toContain('install_software');
    expect(staticShellCategories('dpkg --no-act -i pkg.deb', 'posix')).not.toContain(
      'install_software',
    );
    expect(staticShellCategories('rpm --test -Uvh pkg.rpm', 'posix')).not.toContain(
      'install_software',
    );
    expect(staticShellCategories('rpm -Uvh pkg.rpm', 'posix')).toContain('install_software');
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

  it('wrapped as each OS runs them: the wrapper does not hide the installer, nor its dry run', () => {
    expectKind(
      [
        'cmd /c msiexec /i pkg.msi /qn',
        'powershell -Command "Install-Module Pester -Force"',
        'sudo -u root dnf install x',
        'bash -c "apt-get install -y x"',
        'uvx --from comfy-cli comfy install --nvidia',
      ],
      'install_software',
      true,
    );
    expectKind(
      [
        'powershell -Command "inmo Pester -wi"',
        'bash -c "apt-get -s upgrade"',
        'sh -c "rpm --test -Uvh x.rpm"',
      ],
      'install_software',
      false,
    );
  });

  it('destructive_gate gates what the kind files, and lets a simulation run', () => {
    for (const cmd of [
      'wusa.exe update.msu /quiet',
      'dpkg -i x.deb',
      'Install-PackageProvider NuGet',
    ])
      expect(isDestructiveOrHeavyCommand(cmd, 'windows'), cmd).toBe(true);
    for (const cmd of ['apt-get -s upgrade', 'rpm --test -Uvh x.rpm', 'Install-Module x -WhatIf'])
      expect(isDestructiveOrHeavyCommand(cmd, 'posix'), cmd).toBe(false);
  });
});
