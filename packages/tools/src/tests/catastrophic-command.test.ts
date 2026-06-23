// catastrophic-command.test.ts — the run_command hardline floor detector.

import { describe, it, expect } from 'vitest';
import { isCatastrophicCommand, isDestructiveOrHeavyCommand } from '../catastrophic-command';

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
  ];
  for (const cmd of catastrophic) {
    it(`flags: ${cmd}`, () => {
      expect(isCatastrophicCommand(cmd)).toBe(true);
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
