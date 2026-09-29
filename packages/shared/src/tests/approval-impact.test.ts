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

  // Reviewer A, #582 : la carte décrivait toute commande lourde par « deletes/moves
  // files, installs software, or changes system state » ; un téléchargement de
  // modèle se lisait comme une installation. La carte dit la sorte d'action que
  // la grille a lue.
  it('names the kind of action the checklist reads: a download reads as a download', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'comfy --json model download --url https://huggingface.co/x/y.safetensors',
    });
    expect(line).toContain('destructive or heavy: downloads files from the internet');
    expect(line).not.toContain('installs');
  });

  it('names every kind a chained command performs, and only those', () => {
    const line = computeApprovalImpactLine('run_command', {
      command: 'pip install pandas && rm -rf build',
    });
    expect(line).toContain('installs software or packages');
    expect(line).toContain('deletes files or discards changes');
    expect(line).not.toContain('downloads');
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
  it('mode write : dit ce qui est réversible ET ce qui ne l’est pas (revue P0 du 25/08)', () => {
    const line = computeApprovalImpactLine('code_task', { task: 'add a button', mode: 'write' });
    expect(line).toBe(
      'Runs a coding agent that edits files in the workspace. ' +
        'Tracked files are snapshotted first and can be reverted from the CLI; ' +
        'gitignored files (.env, local data) and the commands it runs are not.',
    );
    expect(line).not.toContain('irreversible');
    // La réserve qui manquait : le snapshot fait un `git add` ordinaire, donc
    // ce que le .gitignore exclut n'est PAS restaurable — le dépôt le
    // documente (CHECKPOINT_COVERAGE_NOTE), la carte le disait pas.
    expect(line).toContain('gitignored');
  });

  it('mode read (le défaut) : n’annonce ni écriture ni commande', () => {
    const line = computeApprovalImpactLine('code_task', { task: 'audit the app' });
    expect(line).toContain('READ mode');
    expect(line).not.toContain('edits files');
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

describe('computeApprovalImpactLine — register_project (P10b, passe Codex 44)', () => {
  it('dit le dossier créé et le registre, jamais « irreversible or destructive »', () => {
    const line = computeApprovalImpactLine('register_project', {
      path: 'veille-ia',
      name: 'Veille IA',
    });
    expect(line).toContain('"veille-ia"');
    expect(line).toContain('registers it as a documents project');
    expect(line).toContain('No file is written or deleted');
    expect(line).not.toContain('irreversible');
  });

  it('dit « code project » quand le kind est code, et reste lisible sans chemin', () => {
    expect(computeApprovalImpactLine('register_project', { path: 'app', kind: 'code' })).toContain(
      'code project',
    );
    const sansChemin = computeApprovalImpactLine('register_project', {});
    expect(sansChemin).toContain('Creates a folder');
    expect(sansChemin).not.toContain('irreversible');
  });
});

describe('computeApprovalImpactLine — declare_verification (revue Codex PR #49, passe 2)', () => {
  it('MONTRE les commandes qu’on approuve, et dit qu’elles tourneront sans redemander', () => {
    // Ce qu'on approuve n'est pas l'écriture en base : ce sont des commandes
    // qui s'exécuteront à la finalisation, hors de tout flux d'approbation.
    // Le catch-all « irreversible or destructive action » demandait un accord
    // sans jamais dire sur quoi.
    const line = computeApprovalImpactLine('declare_verification', {
      project_path: 'C:/Users/kwint/Documents/Dev/recipes-app',
      commands: [{ command: 'node --check app.js' }, { command: 'node app.test.js' }],
    });
    expect(line).toContain('`node --check app.js`');
    expect(line).toContain('`node app.test.js`');
    expect(line).toContain('recipes-app');
    expect(line).toContain('without asking again');
    expect(line).not.toContain('irreversible');
  });

  it('signale la commande lourde plutôt que de la noyer dans la liste', () => {
    const line = computeApprovalImpactLine('declare_verification', {
      project_path: 'C:/p',
      commands: [{ command: 'node --check app.js' }, { command: 'npm install' }],
    });
    expect(line).toContain('installs software');
  });

  it('names the kind of a heavy proof command: a download, not an install (#581)', () => {
    const line = computeApprovalImpactLine('declare_verification', {
      project_path: 'C:/p',
      commands: [{ command: 'node --check app.js' }, { command: 'comfy model download --url x' }],
    });
    expect(line).toContain('at least one downloads files from the internet');
    expect(line).not.toContain('installs');
  });

  it('une déclaration VIDE le dit : rien ne tournera', () => {
    const line = computeApprovalImpactLine('declare_verification', {
      project_path: 'C:/p',
      commands: [],
    });
    expect(line).toContain('nothing will run');
    expect(line).not.toContain('irreversible');
  });
});
