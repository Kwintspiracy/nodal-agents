// catastrophic-command.test.ts — the run_command hardline floor detector.

import { describe, it, expect } from 'vitest';
import {
  isCatastrophicCommand,
  isDestructiveOrHeavyCommand,
  isInlineInterpreterEvalCommand,
} from '../catastrophic-command';

describe('isCatastrophicCommand — catches machine-wide destruction', () => {
  const catastrophic = [
    'rm -rf /',
    'rm -rf /*',
    'rm -fr /',
    'sudo rm -rf /',
    'rm --recursive --force /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf --no-preserve-root /',
    'echo hi && rm -rf /',
    ':(){ :|:& };:',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'shutdown -h now',
    'reboot',
    'init 0',
    'echo x > /dev/sda',
    // Windows
    'format C: /y',
    'format /q /y D:',
    'Remove-Item -Recurse -Force C:\\',
    'Remove-Item -r -Force C:\\',
    'del /f /s /q C:\\*',
    'rd /s /q C:\\',
    'rmdir /s /q D:\\',
    'Stop-Computer -Force',
    'Restart-Computer',
    'diskpart',
    // newline as statement separator (dodges the segment `^rm` anchor otherwise)
    'echo start\nrm -rf / --no-preserve-root',
    'echo hi\nformat C:',
    // interpreter/wrapper bypass — command token isn't first in the segment
    'cmd /c format C:',
    'powershell -Command "format C:"',
    'format.com C:',
    'format.exe /q D:',
    'cmd /c del /s /q C:',
    // PowerShell's `rm` alias (for Remove-Item) against a Windows drive root
    'rm -r -Force C:\\',
    'rm -Recurse -Force C:\\',
    // disk cmdlets
    'Format-Volume -DriveLetter C',
    'Clear-Disk -Number 0',
    'Initialize-Disk -Number 0',
    // dd bypassing the device check via a shell line-continuation
    'dd if=/dev/zero \\\nof=/dev/sda',
    // `rm` wrapped in an interpreter — command token isn't first in the segment
    'cmd /c rm -rf /',
    'cmd /c rm -Recurse -Force C:\\',
  ];
  for (const cmd of catastrophic) {
    it(`flags: ${cmd}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(true);
    });
  }
});

describe('isCatastrophicCommand — A1: repeated-slash bypass', () => {
  // Same catastrophic commands as above, but with doubled/tripled path
  // separators — a naive single-slash regex dodges these while the shell
  // (which collapses repeated separators) runs them exactly the same.
  const catastrophic = [
    'rm -rf //',
    'rm -rf ///',
    'rm -rf //*',
    'echo x > //dev/sda',
    'echo x > ///dev/sda',
    'dd if=/dev/zero of=//dev/sda',
    'dd if=/dev/zero of=///dev/sda',
    'Remove-Item -Recurse -Force C:\\\\',
    'rm -r -Force C:\\\\',
    'format C://',
    'del /f /s /q C:\\\\*',
  ];
  for (const cmd of catastrophic) {
    it(`flags: ${cmd}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(true);
    });
  }
});

describe('isInlineInterpreterEvalCommand — A2: generic interpreter inline-eval forces the gate', () => {
  // Wrapping in a general-purpose interpreter's inline-eval flag hands the
  // classifier an opaque payload that could do anything (including rm -rf).
  // The payload is undecidable, so ANY such invocation must force the APPROVAL
  // gate — dangerous payload and anodyne payload alike. (This is a softer tier
  // than the catastrophic floor: a human CAN approve it, see the tier test
  // below.)
  const dangerousPayload = [
    'python -c "import os; os.system(\'rm -rf /\')"',
    'python3 -c "import os; os.system(\'rm -rf /\')"',
    "node -e \"require('child_process').execSync('rm -rf /')\"",
    'sh -c "rm -rf /"',
    'bash -c "rm -rf /"',
    'powershell -Command "Remove-Item -Recurse -Force C:\\"',
  ];
  const anodynePayload = [
    'python -c "print(1)"',
    'python3 -c "print(1)"',
    'node -e "console.log(1)"',
    'node --eval "console.log(1)"',
    'sh -c "echo hi"',
    'bash -c "echo hi"',
    'zsh -c "echo hi"',
    'powershell -Command "Get-Date"',
    'pwsh -Command "Get-Date"',
    'perl -e "print 1"',
    'ruby -e "puts 1"',
    'php -r "echo 1;"',
    // extra bypass shapes: nested wrapper, sudo, absolute path, `env`
    'cmd /c python -c "print(1)"',
    'sudo python3 -c "print(1)"',
    '/usr/bin/python3 -c "print(1)"',
    'env python3 -c "print(1)"',
  ];
  for (const cmd of [...dangerousPayload, ...anodynePayload]) {
    it(`gates: ${cmd}`, () => {
      expect(isInlineInterpreterEvalCommand(cmd)).toBe(true);
    });
  }
});

describe('A2 tier: interpreter inline-eval is APPROVABLE, not the hard floor', () => {
  // The whole point of the softer tier: an anodyne interpreter one-liner forces
  // a human to look (isInlineInterpreterEvalCommand = true) but is NOT
  // catastrophic — so once a reviewer approves it, the resume path (which
  // checks only isCatastrophicCommand) lets it run. A hard block here would kill
  // every legit `python -c`/`node -e` even with explicit approval.
  const approvableInlineEval = [
    'python -c "print(1)"',
    'python3 -c "print(1)"',
    'node -e "console.log(1)"',
    'perl -e "print 1"',
    'ruby -e "puts 1"',
    'php -r "echo 1;"',
  ];
  for (const cmd of approvableInlineEval) {
    it(`not catastrophic (approvable): ${cmd}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(false);
    });
  }
});

describe('isCatastrophicCommand — A2 non-regression: interpreter without inline flag', () => {
  const safe = [
    'python script.py',
    'python3 script.py',
    'node server.js',
    'node build.js',
    'bash deploy.sh',
    'sh setup.sh',
    'python3 -m http.server',
  ];
  for (const cmd of safe) {
    it(`allows: ${cmd}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(false);
      // …and doesn't spuriously force the gate either (no inline-eval flag).
      expect(isInlineInterpreterEvalCommand(cmd)).toBe(false);
    });
  }
});

describe('isCatastrophicCommand — leaves ordinary commands alone', () => {
  const safe = [
    'ls -la',
    'rm -rf node_modules',
    'rm -rf ./build',
    'rm -rf /tmp/myapp', // a specific subdir, not the whole root
    'rm file.txt',
    'git status',
    'npm install',
    'python script.py',
    'cat /etc/hostname',
    'echo "rm -rf /" # just a comment about it', // mentions but inside a quoted echo string
    'dd if=input.bin of=output.bin',
    // Windows false-positive traps: "format" appears but not as the command word
    'clang-format C:\\src\\main.c',
    'git format-patch -1',
    'dotnet format',
    'Format-Table',
    'Remove-Item .\\build -Recurse -Force',
    'del build\\out.txt',
    'rd /s /q .\\node_modules',
    'Stop-Process -Name node',
    'Get-Content C:\\file.txt',
    'echo just formatting text',
    'npm rm foo', // "rm" token present, but no recursive+force flags and no root target
    '',
  ];
  for (const cmd of safe) {
    it(`allows: ${cmd || '(empty)'}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(false);
    });
  }
});

describe('isDestructiveOrHeavyCommand — gates installs/deletes/etc under destructive_gate', () => {
  const heavy = [
    'rm file.txt',
    'rm -rf ./build',
    'rmdir mydir',
    'del config.json',
    'comfy install --nvidia',
    'uvx --from comfy-cli comfy install --nvidia',
    'npm install',
    'pip install torch',
    'comfy model download --url x --relative-path models/checkpoints',
    'git clone https://github.com/foo/bar',
    'wget https://example.com/big.bin',
    'curl -O https://example.com/model.safetensors',
    'kill 1234',
    'systemctl stop nginx',
    'mkfs.ext4 /dev/sdb',
    'git push --force origin main',
    'chmod -R 777 .',
  ];
  for (const cmd of heavy) {
    it(`gates: ${cmd}`, () => {
      expect(isDestructiveOrHeavyCommand(cmd)).toBe(true);
    });
  }

  const ordinary = [
    'ls -la',
    'curl -s http://127.0.0.1:8188/system_stats',
    'cat file.txt',
    'python script.py',
    'node build.js',
    'echo hi',
    'git status',
    'mkdir foo',
    'npm run build',
    '',
  ];
  for (const cmd of ordinary) {
    it(`allows: ${cmd || '(empty)'}`, () => {
      expect(isDestructiveOrHeavyCommand(cmd)).toBe(false);
    });
  }
});
