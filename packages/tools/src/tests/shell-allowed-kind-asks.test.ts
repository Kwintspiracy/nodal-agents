// shell-allowed-kind-asks.test.ts — an allowed kind asks when the text cannot
// establish what it acts on, for every kind (#715).
//
// Sous `delete_files: allow` (les agents Yolo, migration 0125), une
// suppression dont les cibles venaient d'un pipeline, de xargs, du `{}` de
// find, d'une variable de boucle cmd, d'une variable ou d'un splat tournait
// sans question : la règle « une sorte permise demande quand le texte ne dit
// pas sur quoi elle agit » n'existait que pour le code en ligne et le
// téléchargement, en deux cas à part. Elle vaut pour chaque sorte, et chaque
// cas passe par le vrai jugement de la liste, sur une fausse arborescence.
//
// Les chaînes qui ressemblent à des destructions sont assemblées à
// l'exécution.

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { DEFAULT_SHELL_POLICY, SHELL_CATEGORIES, type ShellPolicy } from '@nodal-agents/shared';
import { judgeShellChecklist, type ShellPlace } from '../shell-checklist';

const root = resolve('/nodal-fake-ws-715');

/** A workspace at `root`, empty: every file looked for there is missing, every other folder unread. */
function place(host: ShellPlace['host']): ShellPlace {
  const inside = (p: string) => resolve(p).toLowerCase().startsWith(root.toLowerCase());
  return {
    cwd: root,
    host,
    inWorkspace: async (p) => inside(p),
    leadsTo: async () => null,
    readSource: async (p) =>
      inside(p)
        ? { kind: 'unread', why: 'not_found' }
        : { kind: 'unread', why: 'outside_workspaces' },
  };
}

/** Every kind allowed: an agent the owner trusts with everything (migration 0125's Yolo). */
const ALL_ALLOWED = Object.fromEntries(SHELL_CATEGORIES.map((c) => [c, 'allow'])) as ShellPolicy;

const judge = (command: string, host: ShellPlace['host']) =>
  judgeShellChecklist([command], ALL_ALLOWED, place(host));

const RM = 'r' + 'm';
const WIN_ROOT = 'C:' + '\\';

describe('an allowed kind asks when the text cannot establish its target (#715) @cap:executer-une-commande/moteur', () => {
  it('delete_files: the forms of the ticket ask, naming the kind and the command', async () => {
    for (const [command, host] of [
      [
        `powershell -Command "Get-ChildItem ${WIN_ROOT} -Force | Remove-Item -Recurse -Force"`,
        'windows',
      ],
      [`powershell -Command "gci ${WIN_ROOT} | ri -r -fo"`, 'windows'],
      [`ls / | xargs ${RM} -rf`, 'posix'],
      [`find / -print0 | xargs -0 ${RM} -rf`, 'posix'],
      [`find / -exec ${RM} -rf {} +`, 'posix'],
      [`powershell -Command "Remove-Item -Recurse -Force $p"`, 'windows'],
      [`powershell -Command "Remove-Item @opts"`, 'windows'],
      [`${RM} -rf $DIR`, 'posix'],
      // inside the workspace: what Get-ChildItem lists is not read ahead, so it asks
      [`powershell -Command "gci *.tmp | ri"`, 'windows'],
    ] as const) {
      expect(await judge(command, host), command).toEqual([
        { category: 'delete_files', state: 'ask', details: [command] },
      ]);
    }
    // cmd's loop variable. The set of a `for` outside the workspace is also
    // read as a program cmd may look up there, which asks as code nobody read
    // (`unread`, unchanged here): the deletion asks on its own.
    const loop = `for /d %i in (${WIN_ROOT}*) do rd /s /q "%i"`;
    expect(await judge(loop, 'windows')).toContainEqual({
      category: 'delete_files',
      state: 'ask',
      details: [loop],
    });
    expect(await judge(`for /d %i in (build\*) do rd /s /q "%i"`, 'windows')).toEqual([
      {
        category: 'delete_files',
        state: 'ask',
        details: ['for /d %i in (build\*) do rd /s /q "%i"'],
      },
    ]);
  });

  it('delete_files: a target the text establishes runs as before', async () => {
    for (const [command, host] of [
      ['powershell -Command "Remove-Item -Recurse -Force .\\build"', 'windows'],
      ['Remove-Item -Recurse -Force .\\build', 'windows'],
      ['rd /s /q build', 'windows'],
      [`${RM} -rf ./dist`, 'posix'],
      ["find . -name '*.pyc' -delete", 'posix'],
      ['git clean -fdx', 'posix'],
    ] as const) {
      expect(await judge(command, host), command).toEqual([]);
    }
  });

  it('a line read in a script is judged the same way, and the card says where', async () => {
    const ps1 = 'gci $env:TEMP | Remove-Item -Recurse -Force\r\n';
    const p: ShellPlace = {
      ...place('windows'),
      readSource: async (path) =>
        resolve(path).toLowerCase() === resolve(root, 'clean.ps1').toLowerCase()
          ? { kind: 'text', text: ps1, bytes: ps1.length }
          : { kind: 'unread', why: 'not_found' },
    };
    const command = 'powershell -File clean.ps1';
    expect(await judgeShellChecklist([command], ALL_ALLOWED, p)).toEqual([
      {
        category: 'delete_files',
        state: 'ask',
        details: [command],
        found: [
          { source: 'clean.ps1', line: 1, text: 'gci $env:TEMP | Remove-Item -Recurse -Force' },
        ],
      },
    ]);
  });

  it('every other kind follows the same rule', async () => {
    for (const [command, host, kind] of [
      ['kill -9 $PID', 'posix', 'stop_programs'],
      ['powershell -Command "Get-Process node | Stop-Process"', 'windows', 'stop_programs'],
      ['chmod -R 777 $DIR', 'posix', 'system_settings'],
      ['npm install $PKG', 'posix', 'install_software'],
      ['xdg-open "$FILE"', 'posix', 'open_or_send'],
    ] as const) {
      expect(await judge(command, host), command).toEqual([
        { category: kind, state: 'ask', details: [command] },
      ]);
    }
    for (const [command, host] of [
      ['kill 1234', 'posix'],
      ['taskkill /F /IM node.exe', 'windows'],
      ['chmod +x ./run.sh', 'posix'],
      ['npm install express', 'posix'],
      ['lp -d office report.pdf', 'posix'],
    ] as const) {
      expect(await judge(command, host), command).toEqual([]);
    }
  });

  it('the two cases that already asked are instances of the rule: their verdicts are unchanged', async () => {
    // inline code: its program decided at run time
    expect(await judge('$c report.pdf', 'posix')).toEqual([
      { category: 'inline_code', state: 'ask', details: ['$c report.pdf'] },
    ]);
    // a download: where it writes, outside the workspaces or not said
    const out = 'curl -o $OUT https://x.org/a.zip';
    expect(await judge(out, 'posix')).toEqual([
      {
        category: 'download',
        state: 'ask',
        details: [out],
        outside: [{ command: out, places: ['a path decided when the command runs'] }],
      },
    ]);
    expect(await judge('curl -o a.zip https://x.org/a.zip', 'posix')).toEqual([]);
  });

  it('one reading of a word decided at run time for every kind: a download target too', async () => {
    // cmd's delayed expansion and a PowerShell splat were read as plain names
    // for a download's target; `readablePath` is now the reading of both.
    for (const [command, host] of [
      ['setlocal enabledelayedexpansion & curl -o !F! https://x.org/a.zip', 'windows'],
      ['powershell -Command "Invoke-WebRequest https://x.org/a.zip -OutFile @f"', 'windows'],
    ] as const) {
      expect(await judge(command, host), command).toEqual([
        {
          category: 'download',
          state: 'ask',
          details: [command],
          outside: [{ command, places: ['a path decided when the command runs'] }],
        },
      ]);
    }
  });

  it('several kinds in one line: each asks for its own target, and only for it', async () => {
    const line = `${RM} -rf $DIR && curl -o /elsewhere/a.zip https://x.org/a.zip && kill 1234`;
    expect(await judge(line, 'posix')).toEqual([
      { category: 'delete_files', state: 'ask', details: [line] },
      {
        category: 'download',
        state: 'ask',
        details: [line],
        outside: [{ command: line, places: ['/elsewhere/a.zip'] }],
      },
    ]);
  });

  // Passe 1 Nodal : ces formes n'avaient aucune sorte, elles passaient même
  // sous « ask », la politique par défaut des suppressions.
  it('forms that had no kind at all are now deletions, held under the default policy', async () => {
    for (const [command, host] of [
      [`find . | parallel ${RM} -rf {}`, 'posix'],
      [`fd -x ${RM}`, 'posix'],
      ['powershell -Command "Get-ChildItem secret | Clear-Content"', 'windows'],
      [
        'powershell -Command "Get-Item HKCU:\\Software\\X | Remove-ItemProperty -Name Y"',
        'windows',
      ],
    ] as const) {
      expect(
        await judgeShellChecklist([command], DEFAULT_SHELL_POLICY, place(host)),
        command,
      ).toEqual([{ category: 'delete_files', state: 'ask', details: [command] }]);
    }
  });
});
