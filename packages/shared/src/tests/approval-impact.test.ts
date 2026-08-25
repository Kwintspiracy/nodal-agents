// approval-impact.test.ts — the deterministic impact line of approval cards.
//
// The run_command branch derives its verdict from the SAME classifiers the
// approval gate uses (catastrophic-command.ts, moved to shared 2026-07-08) —
// these tests pin that the card and the gate can never disagree, and that the
// line names the actual binaries instead of the old generic "Runs a shell
// command on the host." (feedback Quentin: the impact line said nothing the
// raw command didn't already show).

import { describe, it, expect } from 'vitest';
import { computeApprovalImpactLine } from '../approval-impact';

describe('computeApprovalImpactLine — run_command', () => {
  it('names the pipeline binaries and reports no destructive pattern for a read/inspect command', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'curl -s http://127.0.0.1:8188/system_stats 2>&1 | head -50',
      purpose: 'Check ComfyUI server',
    });
    expect(line).toContain('`curl`');
    expect(line).toContain('`head`');
    expect(line).toContain('no destructive pattern detected');
  });

  it('flags a destructive command with its binary', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'rm -rf ./build && ls',
    });
    expect(line).toContain('`rm`');
    expect(line).toContain('destructive or heavy');
  });

  it('flags inline interpreter eval', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: `python -c "import json; print(json.dumps({'a': 1}))"`,
    });
    expect(line).toContain('`python`');
    expect(line).toContain('arbitrary inline code');
  });

  it('flags a machine-wide catastrophic command as refused-even-if-approved', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'mkfs.ext4 /dev/sda1',
    });
    expect(line).toContain('MACHINE-WIDE DESTRUCTIVE');
    expect(line).toContain('refused even if approved');
  });

  it('strips sudo, env-var prefixes, paths and .exe from binary names', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'FOO=bar sudo "C:\\Program Files\\nodejs\\node.exe" script.js',
    });
    expect(line).toContain('`node`');
    expect(line).not.toContain('sudo');
    expect(line).not.toContain('FOO');
  });

  it('caps the binary list at 3 segments', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'a | b | c | d | e',
    });
    expect(line).toContain('`a` → `b` → `c`');
    expect(line).not.toContain('`d`');
  });

  it('falls back to the generic sentence when command is missing', () => {
    expect(computeApprovalImpactLine('run_command', {})).toBe('Runs a shell command on the host.');
  });
});

describe('computeApprovalImpactLine — other tools (unchanged shape)', () => {
  it('file overwrite names the path', () => {
    expect(computeApprovalImpactLine('file_write', { path: 'workflows/x.json' })).toContain(
      'workflows/x.json',
    );
  });

  it('skill script names script and skill', () => {
    const line = computeApprovalImpactLine('run_skill_script', {
      skill: 'comfyui',
      script: 'scripts/run_workflow.py',
    });
    expect(line).toContain('comfyui');
    expect(line).toContain('scripts/run_workflow.py');
  });
});

describe('computeApprovalImpactLine — code_task (lot approbations 24/08)', () => {
  it('ne dit plus « irreversible or destructive » : les fichiers sont checkpointés, les commandes non', () => {
    const line = computeApprovalImpactLine('code_task', { task: 'add a button' });
    expect(line).toBe(
      'Runs a coding agent that edits files in the workspace. ' +
        'File changes are checkpointed first and can be reverted; commands it runs are not.',
    );
    expect(line).not.toContain('irreversible');
  });

  it('un outil inconnu garde la ligne catch-all', () => {
    expect(computeApprovalImpactLine('mystery_tool', {})).toBe(
      'mystery_tool: irreversible or destructive action.',
    );
  });
});

describe('computeApprovalImpactLine — outils de lecture gates par regle utilisateur', () => {
  it('file_search dit « read-only », jamais « irreversible or destructive »', () => {
    const line = computeApprovalImpactLine('file_search', { pattern: 'calorie', target: 'files' });
    expect(line).toBe('Searches workspace files for "calorie" — read-only, changes nothing.');
    expect(line).not.toContain('irreversible');
  });

  it('file_read et file_list aussi', () => {
    expect(computeApprovalImpactLine('file_read', { path: 'src/app.js' })).toBe(
      'Reads the file "src/app.js" — read-only, changes nothing.',
    );
    expect(computeApprovalImpactLine('file_list', {})).toContain('read-only');
  });
});
