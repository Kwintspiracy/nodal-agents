// catastrophic-command.test.ts — the run_command hardline floor detector.

import { describe, it, expect } from 'vitest';
import { isCatastrophicCommand } from '../catastrophic-command';

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
