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
if (process.argv[4] === 'env') {
  // Names only, never values: what the spawned PowerShell inherits.
  console.log(`[exp-1056] ${label} env keys: ${Object.keys(process.env).sort().join(',')}`);
  const pm = process.env['PSModulePath'] ?? process.env['PSMODULEPATH'];
  console.log(
    `[exp-1056] ${label} PSModulePath entries: ${pm === undefined ? 'unset' : pm.split(';').length}`,
  );
}
if (process.argv[4] === 'bisect') {
  // Which variable that turbo drops does the read need? Each attempt spawns the
  // CIM read with ONLY the variables a turbo task kept (measured in run
  // 42993362837), plus the candidates named.
  const KEPT = (
    'APPDATA,CI,COMPUTERNAME,ComSpec,HOME,HOMEDRIVE,HOMEPATH,LOCALAPPDATA,NUMBER_OF_PROCESSORS,' +
    'OS,PATHEXT,PROCESSOR_ARCHITECTURE,PUBLIC,Path,ProgramData,ProgramFiles,ProgramFiles(x86),' +
    'SystemDrive,SystemRoot,TEMP,TMP,USERDOMAIN,USERNAME,USERPROFILE,windir'
  )
    .split(',')
    .map((k) => k.toUpperCase());
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => KEPT.includes(k.toUpperCase())),
  );
  const dropped = Object.keys(process.env).filter(
    (k) => !KEPT.includes(k.toUpperCase()) && !/^(GITHUB_|RUNNER_|ACTIONS_)/.test(k),
  );
  const read = (extra) => {
    const env = { ...base };
    for (const k of extra) env[k] = process.env[k];
    const started = Date.now();
    const r = spawnSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', QUERIES['Get-CimInstance']],
      {
        encoding: 'utf8',
        timeout: 20_000,
        maxBuffer: 64 * 1024 * 1024,
        env,
      },
    );
    const rows = (r.stdout ?? '').split(/\r?\n/).filter((l) => l.split('|').length === 4).length;
    return `${Date.now() - started} ms, ${r.error ? `error ${r.error.code}` : `exit ${r.status}`}, ${rows} rows`;
  };
  console.log(`[exp-1056] bisect kept only: ${read([])}`);
  console.log(`[exp-1056] bisect kept + all ${dropped.length} dropped: ${read(dropped)}`);
  for (const k of dropped) {
    if (
      /^(ANDROID|JAVA_|GOROOT|CONDA|VCPKG|SELENIUM|PIPX|AZURE|GRADLE|CHOCOLATEY|DOTNET|NUGET|RTOOLS|ImageVersion|ImageOS|PHPROOT|ACCEPT_EULA|STATS_|BOOTSTRAP|WIX|AGENT_|MONO|M2|DEPLOYMENT|SBT|PGBIN|PGDATA|PGROOT|PGUSER|PGPASSWORD|RUST|CARGO|ANT_|CABAL|COBERTURA|GHCUP|MAVEN|GCM_|ENABLE_RUNNER|AZ_DEVOPS|ChromeWebDriver|EdgeWebDriver|GeckoWebDriver|IEWebDriver|npm_|POWERSHELL_)/i.test(
        k,
      )
    )
      continue;
    console.log(`[exp-1056] bisect kept + ${k}: ${read([k])}`);
  }
  process.exit(0);
}
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
