// EXPERIMENT (#1057) — removed before the PR is opened.
//
// Which form of the process-table read stays fast when the caller's environment
// has no PSModulePath and no PSModuleAnalysisCachePath? Each candidate is spawned
// the way the CLI spawns PowerShell, with both variables removed.
import { spawnSync } from 'node:child_process';

const PSHOME = `${process.env.SystemRoot ?? process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0`;
const CIM =
  'Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate,Name | ' +
  'ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CreationDate.Ticks)|$($_.Name)" }';
const WMI =
  'Get-WmiObject Win32_Process | ForEach-Object { ' +
  '"$($_.ProcessId)|$($_.ParentProcessId)|' +
  '$($_.ConvertToDateTime($_.CreationDate).Ticks)|$($_.Name)" }';
const byPath = (m) => `Import-Module -Name '${PSHOME}\\Modules\\${m}\\${m}.psd1'; `;
const DOTNET =
  "[void][Reflection.Assembly]::LoadWithPartialName('System.Management'); " +
  "$s = New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId,ParentProcessId,CreationDate,Name FROM Win32_Process'); " +
  'foreach ($p in $s.Get()) { "$($p.ProcessId)|$($p.ParentProcessId)|$([System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).Ticks)|$($p.Name)" }';
const DOTNET_NOCMDLET =
  "[void][Reflection.Assembly]::LoadWithPartialName('System.Management'); " +
  "$s = [System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,ParentProcessId,CreationDate,Name FROM Win32_Process'); " +
  'foreach ($p in $s.Get()) { "$($p.ProcessId)|$($p.ParentProcessId)|$([System.Management.ManagementDateTimeConverter]::ToDateTime($p.CreationDate).Ticks)|$($p.Name)" }';

const stripped = Object.fromEntries(
  Object.entries(process.env).filter(
    ([k]) => !['PSMODULEPATH', 'PSMODULEANALYSISCACHEPATH'].includes(k.toUpperCase()),
  ),
);

const CANDIDATES = [
  ['C0 control, full env', CIM, process.env],
  ['C0 control, stripped', CIM, stripped],
  ['C0w control WMI, stripped', WMI, stripped],
  [
    'C1 PSModulePath=$PSHOME\\Modules, CIM',
    CIM,
    { ...stripped, PSModulePath: `${PSHOME}\\Modules` },
  ],
  [
    'C1w PSModulePath=$PSHOME\\Modules, WMI',
    WMI,
    { ...stripped, PSModulePath: `${PSHOME}\\Modules` },
  ],
  ['C2 Import-Module by path, CIM', byPath('CimCmdlets') + CIM, stripped],
  ['C2w Import-Module by path, WMI', byPath('Microsoft.PowerShell.Management') + WMI, stripped],
  ['C3 .NET searcher (New-Object)', DOTNET, stripped],
  ['C3b .NET searcher (no cmdlet)', DOTNET_NOCMDLET, stripped],
  ['S0 startup only, stripped', '"1|1|1|x"', stripped],
  [
    'C4 $env:PSModulePath set inside, CIM',
    `$env:PSModulePath = '${PSHOME}\\Modules'; ` + CIM,
    stripped,
  ],
  [
    'C4w $env:PSModulePath set inside, WMI',
    `$env:PSModulePath = '${PSHOME}\\Modules'; ` + WMI,
    stripped,
  ],
  [
    'C2b CimCmdlets + Management by path, CIM',
    byPath('Microsoft.PowerShell.Management') + byPath('CimCmdlets') + CIM,
    stripped,
  ],
  [
    'C5 CIM through .NET MMI (no cmdlet)',
    "[void][Reflection.Assembly]::LoadWithPartialName('Microsoft.Management.Infrastructure'); " +
      '$c = [Microsoft.Management.Infrastructure.CimSession]::Create($null); ' +
      "foreach ($p in $c.QueryInstances('root/cimv2', 'WQL', 'SELECT ProcessId,ParentProcessId,CreationDate,Name FROM Win32_Process')) { " +
      '$v = $p.CimInstanceProperties; ' +
      "\"$($v['ProcessId'].Value)|$($v['ParentProcessId'].Value)|$($v['CreationDate'].Value.Ticks)|$($v['Name'].Value)\" }",
    stripped,
  ],
];

const ticksOf = (stdout) =>
  new Map(
    stdout
      .split(/\r?\n/)
      .map((l) => l.trim().split('|'))
      .filter((p) => p.length === 4)
      .map((p) => [p[0], p[2]]),
  );

let reference = null;
for (let round = 1; round <= 3; round++) {
  for (const [name, command, env] of CANDIDATES) {
    const started = Date.now();
    const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
      encoding: 'utf8',
      timeout: 25_000,
      maxBuffer: 64 * 1024 * 1024,
      env,
    });
    const ms = Date.now() - started;
    const rows = ticksOf(r.stdout ?? '');
    if (name.startsWith('C0 control, full') && rows.size > 0) reference = rows;
    let agree = 'n/a';
    if (reference && rows.size > 0) {
      let same = 0;
      let diff = 0;
      for (const [pid, t] of rows) {
        if (!reference.has(pid)) continue;
        if (reference.get(pid) === t) same += 1;
        else diff += 1;
      }
      agree = `${same} same tick, ${diff} different`;
    }
    const outcome = r.error ? `error ${r.error.code}` : `exit ${r.status}`;
    const err = (r.stderr ?? '').trim().split('\n')[0]?.slice(0, 120) ?? '';
    console.log(
      `[exp-1057] round ${round} ${name}: ${ms} ms, ${outcome}, ${rows.size} rows, vs full-env CIM: ${agree}${err ? `, stderr: ${err}` : ''}`,
    );
  }
}
