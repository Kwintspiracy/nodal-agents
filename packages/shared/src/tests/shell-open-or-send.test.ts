// shell-open-or-send.test.ts — a command that reaches past the computer's files (#667).
//
// 01/10: asked to print a short text, an agent that held a print tool asking
// the person first ran `Start-Process … -Verb Print` through the shell instead.
// Notepad opened on the person's desktop with its print dialog, and nobody was
// asked: no kind of the checklist covered "open a program on the person's
// screen, print, or send". These cases pin the rule on every OS, and what it
// must NOT read as such.

import { describe, it, expect } from 'vitest';
import { isDestructiveOrHeavyCommand, staticShellCategories } from '../catastrophic-command';
import {
  DEFAULT_SHELL_POLICY,
  resolveShellPolicy,
  SHELL_CATEGORIES,
  StoredShellPolicySchema,
} from '../shell-checklist';
import { computeApprovalImpactLine } from '../approval-impact';

const opensOrSends = (cmd: string) => staticShellCategories(cmd).includes('open_or_send');

describe('open_or_send: what reaches the screen, a printer or someone (#667) @cap:executer-une-commande/moteur', () => {
  it('the reproduction of #667: Start-Process -Verb Print, wrapped in powershell -Command', () => {
    const cmd = `powershell -NoProfile -Command "Start-Process -FilePath 'C:\\Users\\x\\shared\\outputs\\test-nodal.txt' -Verb Print -PassThru | Out-Null"`;

    expect(staticShellCategories(cmd).sort()).toEqual(['inline_code', 'open_or_send']);
    expect(isDestructiveOrHeavyCommand(cmd)).toBe(true);
  });

  it('the OS launchers, on Windows, macOS and Linux', () => {
    for (const cmd of [
      // Windows: cmd's start, PowerShell's Start-Process and its aliases, Invoke-Item, explorer
      'start report.pdf',
      'cmd /c start "" "C:\\out\\report.pdf"',
      'Start-Process notepad.exe',
      'saps https://example.com',
      'Invoke-Item .\\report.pdf',
      'ii report.pdf',
      'explorer.exe C:\\Users\\x\\Pictures',
      'rundll32 printui.dll,PrintUIEntry /k /n "Office"',
      'rundll32.exe shell32.dll,ShellExec_RunDLL report.pdf',
      // macOS
      'open report.pdf',
      'open -a Preview report.pdf',
      'open https://example.com',
      `osascript -e 'tell application "Mail" to activate'`,
      // Linux, WSL
      'xdg-open report.pdf',
      'gio open report.pdf',
      'kioclient5 exec report.pdf',
      'wslview report.pdf',
      'notify-send "Done" "The build passed"',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('every -Verb of Start-Process is a desktop action: Print, PrintTo, Open, Edit, RunAs', () => {
    for (const verb of ['Print', 'PrintTo', 'Open', 'Edit', 'RunAs']) {
      const cmd = `Start-Process -FilePath x.txt -Verb ${verb} -WindowStyle Hidden`;
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('printers and spoolers: lp, lpr, Out-Printer, print, a desktop program told to print', () => {
    for (const cmd of [
      'lp -d office report.pdf',
      'lpr -P office report.pdf',
      'Get-Content report.txt | Out-Printer',
      'print /D:\\\\server\\office report.txt',
      'notepad /p report.txt',
      'mspaint /p chart.png',
      'AcroRd32.exe /t report.pdf "Office"',
      // a print flag prints even without a window
      'soffice --headless -p report.odt',
      'soffice --headless --pt Office report.odt',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('mail sent from the shell reaches someone', () => {
    for (const cmd of [
      'sendmail bob@example.com < mail.txt',
      'mail -s "Report" bob@example.com < body.txt',
      'Send-MailMessage -To bob@example.com -From me@example.com -Subject Report -SmtpServer smtp.example.com',
      'swaks --to bob@example.com --server smtp.example.com',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(true);
    }
  });

  it('a desktop program opens its window, unless it is told to run headless', () => {
    expect(opensOrSends('notepad report.txt')).toBe(true);
    expect(opensOrSends('"C:\\Program Files\\Mozilla Firefox\\firefox.exe" https://x.org')).toBe(
      true,
    );
    expect(opensOrSends('chrome https://example.com')).toBe(true);
    expect(opensOrSends('soffice report.odt')).toBe(true);

    expect(opensOrSends('chrome --headless=new --screenshot=shot.png https://x.org')).toBe(false);
    expect(opensOrSends('msedge --headless --print-to-pdf=out.pdf https://x.org')).toBe(false);
    expect(opensOrSends('soffice --headless --convert-to pdf report.docx')).toBe(false);
    expect(opensOrSends('soffice --convert-to pdf report.docx')).toBe(false);
    expect(opensOrSends('firefox --headless --screenshot https://x.org')).toBe(false);
  });

  it('a document run as a command opens in its program', () => {
    expect(opensOrSends('.\\test-nodal.txt')).toBe(true);
    expect(opensOrSends('cmd /c report.pdf')).toBe(true);
    expect(opensOrSends('./chart.png')).toBe(true);
  });

  it('a program started in the background, without a window, is judged by what it starts', () => {
    // The dev-server idiom on Windows: nothing reaches the screen.
    expect(
      opensOrSends('Start-Process node -ArgumentList server.js -WindowStyle Hidden -PassThru'),
    ).toBe(false);
    expect(opensOrSends('Start-Process -FilePath python -ArgumentList app.py -NoNewWindow')).toBe(
      false,
    );
    expect(opensOrSends('start /b node server.js')).toBe(false);
    expect(opensOrSends('cmd /c start /b python -m http.server')).toBe(false);

    // …but a document, an address or a printing program started that way still reaches out.
    expect(opensOrSends(`Start-Process notepad -ArgumentList '/p x.txt' -WindowStyle Hidden`)).toBe(
      true,
    );
    expect(opensOrSends('Start-Process report.pdf -WindowStyle Hidden')).toBe(true);
    expect(opensOrSends('start /b notepad /p x.txt')).toBe(true);
    expect(opensOrSends('Start-Process https://example.com -NoNewWindow')).toBe(true);
    // A launch with a window, whatever it starts, opens it on the screen.
    expect(opensOrSends('Start-Process node -ArgumentList server.js')).toBe(true);
    // What it starts is read as a command of its own, wrappers included.
    expect(
      opensOrSends(`Start-Process cmd -ArgumentList '/c start report.pdf' -WindowStyle Hidden`),
    ).toBe(true);
  });

  // The launched command is read for every kind, not only this one: what a
  // background launch deletes or installs is a deletion or an install.
  it('what a launcher starts is judged for every kind of action', () => {
    expect(
      staticShellCategories(
        `Start-Process powershell -ArgumentList '-Command','Remove-Item -Recurse build' -WindowStyle Hidden`,
      ),
    ).toContain('delete_files');
    expect(staticShellCategories('start /b npm install left-pad')).toEqual(['install_software']);
    expect(
      staticShellCategories('Start-Process node -ArgumentList server.js -NoNewWindow'),
    ).toEqual([]);
  });

  it('a PowerShell script run by name runs, it is not a document', () => {
    expect(opensOrSends('.\\build.ps1 -Configuration Release')).toBe(false);
    expect(opensOrSends('powershell -File .\\build.ps1')).toBe(false);
  });

  it('the help or version of a launcher prints and exits', () => {
    expect(opensOrSends('xdg-open --version')).toBe(false);
    expect(opensOrSends('open --help')).toBe(false);
  });

  // The false positives the text net must not raise: a word that only LOOKS
  // like a launcher, in an argument, a string, a script or another program.
  it('a mention is not the action: echo, a string, a file name, a subcommand', () => {
    for (const cmd of [
      'echo start',
      'echo "open the report"',
      `python -c "print('start')"`,
      `python -c "print(open('a.txt').read())"`,
      `node -e "console.log('xdg-open')"`,
      'cat open',
      'ls start',
      'mkdir open && cd open',
      'git commit -m "open the print dialog"',
      'npm start',
      'pnpm run start',
      'yarn start',
      'systemctl start nginx',
      'docker start web',
      'grep -r "Start-Process" src',
      'Get-Printer',
      'Get-Process | Where-Object { $_.Name -eq "notepad" }',
      'python print_report.py',
      'python -m print_tools --out x.pdf',
      'cat report.txt',
      'Get-Content report.txt',
      'node start.js',
      'bash start.sh',
      'gio info report.pdf',
      'git log --format=%s | head',
      'curl -s https://api.example.com/status',
      'openssl rand -hex 16',
      'opener --version',
      'printenv PATH',
      'lpstat -p',
      'pip install --dry-run requests',
      'code --version',
    ]) {
      expect(opensOrSends(cmd), cmd).toBe(false);
    }
  });

  // Measured, not assumed: a broad set of everyday commands an agent runs.
  it('false positives over everyday commands: none', () => {
    const everyday = [
      'git status',
      'git diff --stat',
      'git add src/index.ts && git commit -m "start over"',
      'ls -la',
      'dir /b',
      'Get-ChildItem -Recurse -Filter *.ts',
      'pnpm test',
      'pnpm --filter web build',
      'npm run dev',
      'node scripts/build.mjs',
      'python3 main.py --open-browser=false',
      'python -m pytest -q',
      'pytest tests/test_open.py',
      'cargo build --release',
      'go test ./...',
      'docker compose up -d',
      'docker ps',
      'kubectl get pods',
      'curl -sL https://example.com/api | jq .',
      'Invoke-RestMethod https://example.com/api',
      'cat package.json | jq .scripts.start',
      'type README.md',
      'Select-String -Path *.md -Pattern "open"',
      'findstr /s "print" *.py',
      'rg "open\\(" src',
      'sed -n 1,20p src/open.ts',
      'head -n 5 print.log',
      'wc -l start.txt',
      'tsc --noEmit',
      'eslint . --fix',
      'prettier --write src/print.ts',
      'ffmpeg -i in.mp4 -vf scale=640:-1 out.mp4',
      'magick convert in.png -resize 50% out.png',
      'pandoc report.md -o report.pdf',
      'Set-Location C:\\work; Get-Content .\\notes.txt',
      'cd outputs && ls',
      'echo %DATE%',
      'where python',
      'which open',
      'Test-Path .\\report.pdf',
      'Copy-Item a.txt b.txt',
      'mv a.txt b.txt',
      'cp -r src dist',
      'tar -czf out.tgz dist',
      'Expand-Archive x.zip -DestinationPath out',
      'Start-Sleep -Seconds 2',
      'Start-Job -ScriptBlock { npm run build }',
      'Get-Service | Where-Object Status -eq Running',
      'ping -n 1 127.0.0.1',
      'nslookup example.com',
    ];
    const flagged = everyday.filter(opensOrSends);
    expect(flagged).toEqual([]);
  });
});

describe('open_or_send in the policy (#667) @cap:executer-une-commande/moteur', () => {
  it('is a kind of its own on the checklist, asked by default', () => {
    expect(SHELL_CATEGORIES).toContain('open_or_send');
    expect(DEFAULT_SHELL_POLICY.open_or_send).toBe('ask');
    expect(resolveShellPolicy(null).open_or_send).toBe('ask');
  });

  // Every agent stored before #667 has no such key: it reads the default, no
  // migration. The six keys migration 0125 wrote for a Yolo agent are the
  // owner's word on those six kinds, not on one that did not exist yet.
  it('a stored policy without the key reads "ask", every other state kept', () => {
    const before667 = {
      inline_code: 'allow',
      delete_files: 'allow',
      install_software: 'allow',
      download: 'allow',
      stop_programs: 'allow',
      system_settings: 'allow',
    };

    expect(resolveShellPolicy(before667)).toEqual({ ...before667, open_or_send: 'ask' });
    expect(resolveShellPolicy({ delete_files: 'never' })).toEqual({
      ...DEFAULT_SHELL_POLICY,
      delete_files: 'never',
      open_or_send: 'ask',
    });
  });

  it('a stored state for it is read, and a wrong one refused', () => {
    expect(resolveShellPolicy({ open_or_send: 'never' }).open_or_send).toBe('never');
    expect(resolveShellPolicy({ open_or_send: 'allow' }).open_or_send).toBe('allow');
    expect(StoredShellPolicySchema.safeParse({ open_or_send: 'sometimes' }).success).toBe(false);
  });

  it('the approval card says what the command does', () => {
    expect(computeApprovalImpactLine('run_command', { command: 'lp -d office report.pdf' })).toBe(
      'Runs `lp` — destructive or heavy: opens a program on the screen, prints or sends a message.',
    );
  });
});
