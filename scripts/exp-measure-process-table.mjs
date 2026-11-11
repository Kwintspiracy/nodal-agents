// EXPERIMENT (#1056, step 1) — removed before the PR is opened.
//
// How long one process-table read takes on this machine, measured the way the
// product reads it: a fresh `powershell -NoProfile -NonInteractive -Command`
// per read, with the same two queries `readProcessTableWin` uses
// (apps/cli/src/lib/processes.ts), each bounded by the product's 20 s budget.
import { spawnSync } from 'node:child_process';

const QUERIES = {
  'Get-CimInstance':
    'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ' +
    'ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.Ticks)|$($_.Name)" }',
  'Get-WmiObject':
    'Get-WmiObject Win32_Process | ForEach-Object { ' +
    '"$($_.ProcessId)|$($_.ParentProcessId)|' +
    '$($_.ConvertToDateTime($_.CreationDate).Ticks)|$($_.Name)" }',
};

const label = process.argv[2] ?? 'measure';
const rounds = Number(process.argv[3] ?? 3);
for (let i = 1; i <= rounds; i++) {
  for (const [name, command] of Object.entries(QUERIES)) {
    const started = Date.now();
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    const ms = Date.now() - started;
    const rows = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.split('|').length === 4).length;
    const outcome = r.error ? `error ${r.error.code ?? r.error.message}` : `exit ${r.status}`;
    console.log(`[exp-1056] ${label} round ${i} ${name}: ${ms} ms, ${outcome}, ${rows} rows`);
  }
}
