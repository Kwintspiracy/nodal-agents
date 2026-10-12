// shell-installers-and-deletes.test.ts — the standard installers and delete
// commands of Windows, macOS and Linux, and their read-only uses (#693).
//
// `msiexec /i`, `dpkg -i`, `rpm -Uvh`, `snap install`, `flatpak install`,
// macOS `installer -pkg`, cmd's `erase` and PowerShell's `ri` ran with no ask
// under the default policy: no kind of the checklist covered them. The floor
// already knew `erase` and `ri`; the kind kept a list of its own, and the two
// drifted. One list now feeds both, and each kind covers every OS's forms.

import { describe, it, expect } from 'vitest';
import {
  isCatastrophicCommand,
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

describe('install_software: the standard installers of Windows, macOS and Linux (#693) @cap:executer-une-commande/moteur', () => {
  it('the ticket’s installers, each on its OS form', () => {
    expectKind(
      [
        // Windows
        'msiexec /i pkg.msi',
        'msiexec /i pkg.msi /qn',
        'msiexec.exe /package pkg.msi /quiet',
        'msiexec /x {GUID}',
        'msiexec -i pkg.msi',
        'msiexec /fa pkg.msi',
        'msiexec /p patch.msp',
        // Debian / Ubuntu
        'dpkg -i pkg.deb',
        'sudo dpkg -i pkg.deb',
        'dpkg --install pkg.deb',
        'dpkg -r pkg',
        'dpkg -P pkg',
        'dpkg --purge pkg',
        'dpkg -R -i ./debs',
        // Fedora / RHEL / SUSE
        'rpm -Uvh pkg.rpm',
        'rpm -ivh pkg.rpm',
        'rpm -i pkg.rpm',
        'rpm -e pkg',
        'rpm -Fvh pkg.rpm',
        'rpm --upgrade pkg.rpm',
        // snaps and flatpaks
        'snap install x',
        'sudo snap remove x',
        'snap refresh x',
        'flatpak install flathub org.x.App',
        'flatpak uninstall org.x.App',
        'flatpak update',
        // macOS
        'installer -pkg x.pkg -target /',
        'sudo installer -pkg /tmp/x.pkg -target /',
        'softwareupdate -i -a',
        'softwareupdate --install --all',
      ],
      'install_software',
      true,
    );
  });

  it('every package manager’s verbs that install, update or remove, not only `install`', () => {
    expectKind(
      [
        'apt remove x',
        'apt-get purge x',
        'apt-get -y upgrade',
        'apt full-upgrade',
        'aptitude install x',
        'dnf remove x',
        'yum update',
        'microdnf install x',
        'zypper in x',
        'zypper rm x',
        'zypper dup',
        'apk add curl',
        'apk del curl',
        'pacman -S x',
        'pacman -Syu',
        'pacman -R x',
        'pacman -U x.pkg.tar.zst',
        'brew upgrade',
        'brew uninstall x',
        'port install x',
        'mas install 497799835',
        'pkg install x',
        'choco upgrade x',
        'winget upgrade --all',
        'winget uninstall x',
        'scoop install git',
        'scoop update git',
        'npm uninstall x',
        'npm update',
        'pnpm remove x',
        'pnpm --filter web up x',
        'yarn remove x',
        'bun remove x',
        'gem update',
        'conda remove x',
        'mamba install x',
        'nix-env -iA nixpkgs.hello',
        'nix-env -e hello',
        'nix profile install nixpkgs#hello',
        'Install-Module Pester',
        'Uninstall-Module Pester',
        'Update-Module Pester',
        'Install-PSResource Pester',
        'Add-AppxPackage .\\app.msix',
        'Remove-AppxPackage x',
        'Install-WindowsFeature Web-Server',
        'Enable-WindowsOptionalFeature -Online -FeatureName x',
        'dism /online /enable-feature /featurename:x',
        'dism /online /add-package /packagepath:x.cab',
      ],
      'install_software',
      true,
    );
  });

  it('their read-only uses are not install_software', () => {
    expectKind(
      [
        'msiexec /?',
        'msiexec /h',
        'dpkg -l',
        'dpkg -L curl',
        'dpkg -s curl',
        'dpkg -S /bin/ls',
        'dpkg -p curl',
        'dpkg --print-architecture',
        'dpkg-query -l',
        'rpm -q curl',
        'rpm -qa',
        'rpm -qi curl',
        'rpm -qip x.rpm',
        'rpm -ql curl',
        'rpm -V curl',
        'rpm -E %_arch',
        'rpm --eval %_arch',
        'snap list',
        'snap info x',
        'snap find x',
        'flatpak list',
        'flatpak info org.x.App',
        'flatpak search x',
        'installer -pkginfo -pkg x.pkg',
        'installer -volinfo -pkg x.pkg',
        'softwareupdate -l',
        'softwareupdate --list',
        'apt list --installed',
        'apt show x',
        'apt search x',
        'apt update',
        'dnf list installed',
        'yum info x',
        'zypper search x',
        'apk info',
        'pacman -Ss x',
        'pacman -Si x',
        'pacman -Qi x',
        'brew list',
        'brew info x',
        'brew update',
        'winget list',
        'winget search x',
        'choco list',
        'scoop list',
        'npm ls',
        'npm run build',
        'pnpm list',
        'gem list',
        'conda list',
        'nix-env -q',
        'nix-env -qaP hello',
        'Get-Module -ListAvailable',
        'Find-Module Pester',
        'Get-AppxPackage',
        'dism /online /get-features',
      ],
      'install_software',
      false,
    );
  });
});
