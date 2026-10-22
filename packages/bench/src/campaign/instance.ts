// campaign/instance.ts — le Nodal d'une campagne : son dossier, ses ports, sa vie, son effacement.
//
// COMMENT IL DÉMARRE, ET POURQUOI (brief du 22/10). L'instance tourne depuis
// le dépôt qui lance la campagne (D5 = a : main au moment de la campagne, son
// commit noté sur chaque ligne), par le CLI du produit et ses trois gestes,
// sans un quatrième :
//   - `up --dev` pour démarrer : le Postgres embarqué, les migrations, le
//     seed, le runner et le web en `next dev`. Jamais `next start` : il
//     demande un `next build`, et un build dans le dépôt du propriétaire tue
//     sa stack ; le mode dev n'en fait aucun. AU PREMIER PLAN, comme la stack
//     de développement du propriétaire, gardé comme enfant du banc : mesuré le
//     22/10, `up --detach` rend la main « healthy » puis son Postgres meurt
//     avec le lanceur (embedded-postgres arrête ses clusters à la sortie du
//     processus, `AsyncExitHook(gracefulShutdown)`, #835). La campagne attend la
//     santé RÉELLE : le `/api/health` du runner, qui sonde sa base, et les
//     trois ports qui répondent ;
//   - `down` pour arrêter (le lanceur sort avec ses services ; s'il traîne, le
//     banc tue l'arbre qu'il a lui-même lancé, par son pid) ;
//   - `reset --yes` pour effacer : `down`, le dossier, et l'entrée du registre
//     des instances (`~/.nodalai-instances/`).
// Le CLI lit `NODALAI_HOME` (#787) : le dossier de la campagne porte SA
// `config.json`, avec SES ports (3100, 3101, 25532 par défaut) et la boucle
// locale en local-trust. Les gardes de `up` restent celles du produit : il
// refuse un port tenu par un processus qu'il n'a pas lancé (celui du
// propriétaire, par exemple) au lieu de le tuer.
//
// L'ENVIRONNEMENT. Les processus de l'instance ne reçoivent PAS celui du
// shell qui lance le banc : seulement les variables du système (chemins,
// utilisateur, proxy, `KEPT_ENV`), puis `NODALAI_HOME`. Une variable de Nodal
// du propriétaire (un `NODALAI_WORKSPACES_ROOT`, une clé `LLM_*` que le runner
// sèmerait, un réglage du runner) changerait l'instance testée en silence :
// la liste est FERMÉE, une variable nouvelle n'y entre pas d'elle-même.
//
// EFFACER, C'EST VÉRIFIER. Après `reset`, le banc retire lui-même l'entrée du
// registre et le dossier (idempotent), puis vérifie : aucun port de la
// campagne ne répond, le dossier n'existe plus, le registre ne la nomme plus.
// Un reste est une erreur qui le nomme, jamais un succès.
//
// UNE CAMPAGNE MORTE NE LAISSE RIEN. Chaque campagne pose un marqueur
// (`campaign.json` : son id, le pid du banc). La suivante efface d'abord toute
// campagne dont le banc n'est plus vivant, avant d'écrire quoi que ce soit ; un
// banc vivant fait refuser la nouvelle (les ports sont les mêmes).

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { NodalConfigSchema, type NodalConfig } from '@nodal-agents/shared/nodal-config';
import {
  NODALAI_HOME_ENV,
  defaultNodalHome,
  nodalHomeEntry,
} from '@nodal-agents/shared/nodal-home';
import { readNodalInstances, unregisterNodalInstance } from '@nodal-agents/shared/nodal-instances';
import { campaignHome, campaignsRoot } from './home';
import { isInside } from './keys';
import type { CampaignKeys } from './keys';

export interface InstancePorts {
  readonly web: number;
  readonly runner: number;
  readonly postgres: number;
}

export interface CampaignInstance {
  readonly id: string;
  /** Le dossier de Nodal de la campagne (`NODALAI_HOME`). */
  readonly home: string;
  readonly ports: InstancePorts;
  /** Le dépôt d'où l'instance tourne (son CLI, son commit). */
  readonly stackDir: string;
}

/**
 * L'instance d'une campagne, avant tout effet. Refuse un dossier qui serait
 * celui du propriétaire (ou dessous), ou dans le dépôt (le `next dev` de
 * l'instance le surveillerait).
 */
export function planInstance(
  id: string,
  ports: InstancePorts,
  stackDir: string,
  userHome: string = homedir(),
): CampaignInstance {
  const home = campaignHome(id, userHome);
  if (isInside(home, defaultNodalHome(userHome))) {
    throw new Error(`campaign_home_in_owner_home: ${home} is under ${defaultNodalHome(userHome)}`);
  }
  if (isInside(home, stackDir)) {
    throw new Error(`campaign_home_in_repo: ${home} is inside the checkout ${stackDir}`);
  }
  return { id, home, ports, stackDir };
}

// ─── L'environnement ─────────────────────────────────────────────────────────

/**
 * Les variables du système que les processus de l'instance gardent (noms en
 * majuscules : Windows ne distingue pas la casse). Tout le reste est retiré.
 */
export const KEPT_ENV: ReadonlySet<string> = new Set([
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'WINDIR',
  'COMSPEC',
  'PSMODULEPATH',
  'TEMP',
  'TMP',
  'TMPDIR',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USER',
  'LOGNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'PROGRAMW6432',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432',
  'ALLUSERSPROFILE',
  'PUBLIC',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'OS',
  'LANG',
  'LANGUAGE',
  'TERM',
  'SHELL',
  'XDG_RUNTIME_DIR',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'SSL_CERT_FILE',
  'NODE_EXTRA_CA_CERTS',
  'PNPM_HOME',
  'NVM_HOME',
  'NVM_SYMLINK',
  'NVM_DIR',
  'VOLTA_HOME',
]);

/**
 * L'environnement des processus de l'instance (CLI, runner, web, `mcp serve`) :
 * les variables gardées de `base`, `NODALAI_HOME` sur le dossier de la
 * campagne, `NODALAI_NO_BROWSER` (un `up` n'ouvre pas d'onglet) et
 * `NODALAI_WEB_HEALTH_MS` : la première compilation de `next dev` d'un dépôt
 * qui n'a jamais servi le web dépasse les 300 s par défaut de `up` sur une
 * machine chargée (mesuré le 22/10 : « still waiting for web after 300s »),
 * le réglage que le produit prévoit pour ce cas.
 */
export const WEB_HEALTH_MS = 15 * 60_000;

export function campaignEnv(
  base: Readonly<Record<string, string | undefined>>,
  home: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (typeof v !== 'string') continue;
    const up = k.toUpperCase();
    if (KEPT_ENV.has(up) || up.startsWith('LC_')) env[k] = v;
  }
  env[NODALAI_HOME_ENV] = home;
  env['NODALAI_NO_BROWSER'] = '1';
  env['NODALAI_WEB_HEALTH_MS'] = String(WEB_HEALTH_MS);
  return env;
}

export { pointProcessAt } from './home';

// ─── Les fichiers ────────────────────────────────────────────────────────────

/** Les chemins de l'instance, tels que le PRODUIT les résout pour ce dossier. */
export function instancePaths(instance: CampaignInstance): {
  config: string;
  workspaces: string;
  benchConfig: string;
  marker: string;
  folders: string;
  printerRecords: string;
} {
  const env = { [NODALAI_HOME_ENV]: instance.home };
  return {
    config: nodalHomeEntry('config.json', env),
    workspaces: nodalHomeEntry('workspaces', env),
    benchConfig: join(instance.home, 'bench.json'),
    marker: join(instance.home, 'campaign.json'),
    folders: join(instance.home, 'bench-folders'),
    // Ce que l'imprimante du banc a reçu : dans le dossier de la campagne,
    // effacé avec lui ; exporté dans les preuves avant (run.ts).
    printerRecords: join(instance.home, 'bench-printer-records'),
  };
}

const MarkerSchema = z
  .object({
    id: z.string(),
    pid: z.number().int().positive(),
    ports: z.object({ web: z.number(), runner: z.number(), postgres: z.number() }),
    stackDir: z.string(),
    createdAt: z.string(),
  })
  .strict();
export type CampaignMarker = z.infer<typeof MarkerSchema>;

/**
 * Le `config.json` de l'instance, validé par LE schéma que le CLI relit
 * (@nodal-agents/shared/nodal-config) : un fichier que `up` jugerait invalide
 * le ferait écrire sa config par défaut, ports du propriétaire compris.
 */
export function instanceConfig(instance: CampaignInstance): NodalConfig {
  return NodalConfigSchema.parse({
    ports: { ...instance.ports },
    workerSecret: randomBytes(32).toString('hex'),
    serverActionsKey: randomBytes(32).toString('base64'),
    authSecret: randomBytes(32).toString('base64'),
    postgresPassword: randomBytes(24).toString('base64url'),
    bind: 'loopback',
    auth: { mode: 'local-trust' },
  });
}

/**
 * Crée le dossier de la campagne et ses trois fichiers : `config.json`
 * (l'instance), `bench.json` (les services locaux déclarés dans le fichier de
 * clés, lus par les scénarios) et `campaign.json` (le marqueur). Refuse un
 * dossier qui existe déjà : une campagne ne réutilise jamais les données d'une
 * autre.
 */
export function createInstanceFiles(
  instance: CampaignInstance,
  keys: CampaignKeys,
  now: Date = new Date(),
  pid: number = process.pid,
): CampaignMarker {
  if (existsSync(instance.home)) {
    throw new Error(`campaign_home_exists: ${instance.home} already exists`);
  }
  const paths = instancePaths(instance);
  mkdirSync(instance.home, { recursive: true });
  const marker: CampaignMarker = {
    id: instance.id,
    pid,
    ports: { ...instance.ports },
    stackDir: instance.stackDir,
    createdAt: now.toISOString(),
  };
  // Le marqueur d'abord : un banc tué juste après laisse une campagne que la
  // suivante sait effacer.
  writeFileSync(paths.marker, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  writeFileSync(paths.config, `${JSON.stringify(instanceConfig(instance), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  writeFileSync(paths.benchConfig, `${JSON.stringify({ services: keys.services }, null, 2)}\n`);
  return marker;
}

/** Le secret du runner de l'instance (`config.json`), pour ses routes internes. */
export function instanceWorkerSecret(instance: CampaignInstance): string {
  return NodalConfigSchema.parse(JSON.parse(readFileSync(instancePaths(instance).config, 'utf8')))
    .workerSecret;
}

// ─── Le CLI du produit ───────────────────────────────────────────────────────

export interface CliRun {
  readonly code: number;
  /** La fin de la sortie (stdout et stderr mêlés), pour le message d'erreur. */
  readonly output: string;
}

/** Un `up` au premier plan : il vit tant que l'instance vit. */
export interface LaunchedCli {
  readonly pid: number;
  /** Se résout quand le lanceur sort, avec son code et la fin de sa sortie. */
  readonly exited: Promise<CliRun>;
  /** La fin de sa sortie jusqu'ici. */
  output(): string;
  /** Tue l'arbre du lanceur, que le banc a lui-même lancé. */
  kill(): void;
}

/** Le CLI de Nodal, tel qu'une campagne l'appelle. Les tests en passent un faux. */
export interface NodalCli {
  /** Une commande qui finit (`down`, `reset --yes`). */
  run(args: readonly string[], env: Record<string, string>, timeoutMs: number): Promise<CliRun>;
  /** Une commande qui reste au premier plan (`up --dev`). */
  launch(args: readonly string[], env: Record<string, string>): LaunchedCli;
}

/**
 * Tue l'arbre d'un processus que le banc a lancé (sous Windows, le .cmd de pnpm
 * et ses enfants), tant que Node le tient encore (#841). Un `taskkill /T` sur
 * le PID d'un processus déjà sorti viserait celui qui a reçu ce PID depuis :
 * Windows redonne vite un PID libéré. Tant que l'`exit` n'est pas arrivé, le
 * handle que Node garde sur l'enfant réserve son PID.
 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-pid, 'SIGTERM');
    }
  } catch {
    /* déjà mort */
  }
}

/**
 * Le CLI du dépôt, exécuté par tsx comme la stack de développement :
 * `pnpm --filter nodal-agents exec tsx src/index.ts <args>`. On attend la FIN
 * du processus (`exit`), pas la fermeture de ses flux : des enfants vivants
 * pourraient les tenir.
 */
export function productCli(stackDir: string): NodalCli {
  const start = (args: readonly string[], env: Record<string, string>) => {
    const child = spawn(
      'pnpm',
      ['--filter', 'nodal-agents', '--silent', 'exec', 'tsx', 'src/index.ts', ...args],
      {
        cwd: stackDir,
        env,
        windowsHide: true,
        // pnpm est un .cmd sous Windows ; les arguments sont des constantes.
        shell: process.platform === 'win32',
        // Ailleurs, un groupe de processus à lui : `killTree` le vise entier.
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    const keep = (d: Buffer): void => {
      output = (output + d.toString('utf8')).slice(-8000);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const exited = new Promise<CliRun>((resolveExit, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolveExit({ code: code ?? 1, output });
      });
    });
    return { child, exited, output: () => output };
  };
  return {
    async run(args, env, timeoutMs) {
      const { child, exited, output } = start(args, env);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          killTree(child);
          reject(
            new Error(
              `campaign_cli_timeout: nodal-agents ${args.join(' ')} ran over ${Math.round(timeoutMs / 1000)} s\n${output()}`,
            ),
          );
        }, timeoutMs);
      });
      try {
        return await Promise.race([exited, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    launch(args, env) {
      const { child, exited, output } = start(args, env);
      if (!child.pid)
        throw new Error(`campaign_cli_spawn: nodal-agents ${args.join(' ')} did not start`);
      return { pid: child.pid, exited, output, kill: () => killTree(child) };
    },
  };
}

// ─── Les ports ───────────────────────────────────────────────────────────────

/** Un port de la boucle locale répond-il ? */
export function portAnswers(port: number, timeoutMs = 1_500): Promise<boolean> {
  return new Promise((resolveProbe) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (answers: boolean): void => {
      socket.destroy();
      resolveProbe(answers);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function answeringPorts(ports: InstancePorts): Promise<string[]> {
  const out: string[] = [];
  for (const [name, port] of Object.entries(ports)) {
    if (await portAnswers(port)) out.push(`${name} :${port}`);
  }
  return out;
}

/**
 * Le `next dev` qui tient déjà le dossier web de ce dépôt, ou null. Next 16
 * pose un verrou (`apps/web/.next/dev/lock`, avec le pid et l'adresse du
 * serveur) et refuse un second serveur dans le même dossier : le web de
 * l'instance ne démarrerait pas. Lu, jamais modifié.
 */
export function devServerHolding(
  stackDir: string,
  isAlive: (pid: number) => boolean = benchAlive,
): { pid: number; port?: number; appUrl?: string } | null {
  const lock = join(stackDir, 'apps', 'web', '.next', 'dev', 'lock');
  if (!existsSync(lock)) return null;
  try {
    const info = z
      .object({
        pid: z.number().int().positive(),
        port: z.number().optional(),
        appUrl: z.string().optional(),
      })
      .passthrough()
      .parse(JSON.parse(readFileSync(lock, 'utf8')));
    return isAlive(info.pid) ? info : null;
  } catch {
    // Un verrou vide ou illisible : Next le reprend s'il est libre ; s'il ne
    // l'est pas, son propre refus sort par `up`.
    return null;
  }
}

// ─── Démarrer, arrêter, effacer ──────────────────────────────────────────────

export interface LifecycleDeps {
  readonly cli: NodalCli;
  /** L'environnement de base des processus de l'instance (le banc passe le sien). */
  readonly baseEnv: Readonly<Record<string, string | undefined>>;
  /** Le dossier personnel de l'utilisateur (le registre des instances y vit). */
  readonly userHome?: string;
  readonly log: (line: string) => void;
  /** Combien de temps attendre que les ports se taisent après `reset`. */
  readonly quietWaitMs?: number;
  /** Combien de temps l'instance a pour servir après `up` (défaut : `UP_TIMEOUT_MS`). */
  readonly upTimeoutMs?: number;
  /** Combien de temps le lanceur a pour sortir après `down` (défaut : une minute). */
  readonly launcherExitMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** `up` attend le web au plus `WEB_HEALTH_MS`, puis le reste : cinq minutes de marge. */
const UP_TIMEOUT_MS = WEB_HEALTH_MS + 5 * 60_000;
const DOWN_TIMEOUT_MS = 3 * 60_000;
/** Combien de temps le lanceur a pour sortir après `down`, avant que le banc ne tue son arbre. */
const LAUNCHER_EXIT_MS = 60_000;

/**
 * L'instance sert-elle ? Le runner répond 200 à `/api/health` (il sonde sa
 * base à chaque appel : 503 quand elle est morte), et le web et Postgres
 * répondent sur leurs ports. Rend ce qui manque, vide quand tout sert.
 */
export async function notServing(ports: InstancePorts): Promise<string[]> {
  const missing: string[] = [];
  try {
    const res = await fetch(`http://127.0.0.1:${ports.runner}/api/health`, {
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status !== 200) missing.push(`runner /api/health HTTP ${res.status}`);
  } catch {
    missing.push(`runner :${ports.runner} /api/health`);
  }
  if (!(await portAnswers(ports.web))) missing.push(`web :${ports.web}`);
  if (!(await portAnswers(ports.postgres))) missing.push(`postgres :${ports.postgres}`);
  return missing;
}

/**
 * Démarre l'instance : `up --dev` au premier plan, gardé comme enfant, puis
 * l'attente de la santé RÉELLE (`notServing`). Refuse avant de lancer quoi
 * que ce soit si un de ses ports répond déjà (une autre campagne, ou n'importe
 * quel processus), ou si le dépôt sert déjà un `next dev`. Un lanceur qui sort
 * avant de servir, ou qui ne sert pas dans le délai, est une erreur qui porte
 * la fin de sa sortie ; dans le second cas son arbre est tué.
 */
export async function startInstance(
  instance: CampaignInstance,
  deps: LifecycleDeps,
): Promise<LaunchedCli> {
  const holder = devServerHolding(instance.stackDir);
  if (holder !== null) {
    throw new Error(
      `campaign_checkout_in_use: ${instance.stackDir} already serves a next dev (pid ${holder.pid}, ${holder.appUrl ?? `port ${holder.port ?? '?'}`}), ` +
        'and Next refuses a second one in the same folder. Run the campaign from another checkout ' +
        '(git worktree add <folder> origin/main, then pnpm install there).',
    );
  }
  const busy = await answeringPorts(instance.ports);
  if (busy.length > 0) {
    throw new Error(
      `campaign_ports_busy: ${busy.join(', ')} already answer${busy.length > 1 ? '' : 's'}. ` +
        'Another campaign may still run; `pnpm bench:campaign erase` removes a dead one.',
    );
  }
  deps.log(
    `Starting the campaign's Nodal from ${instance.stackDir} (web :${instance.ports.web}, runner :${instance.ports.runner}, postgres :${instance.ports.postgres})`,
  );
  const launched = deps.cli.launch(['up', '--dev'], campaignEnv(deps.baseEnv, instance.home));
  let exited: CliRun | null = null;
  void launched.exited.then(
    (r) => {
      exited = r;
    },
    (e: unknown) => {
      exited = { code: 1, output: String(e instanceof Error ? e.message : e) };
    },
  );
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const timeoutMs = deps.upTimeoutMs ?? UP_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const missing = await notServing(instance.ports);
    if (missing.length === 0) break;
    const gone = exited as CliRun | null;
    if (gone !== null) {
      throw new Error(
        `campaign_up_failed: nodal-agents up exited ${gone.code} before serving (${missing.join(', ')} missing)\n${gone.output.trim().slice(-3000)}`,
      );
    }
    if (Date.now() > deadline) {
      launched.kill();
      throw new Error(
        `campaign_up_timeout: the instance did not serve within ${Math.round(timeoutMs / 1000)} s (${missing.join(', ')} missing); its launcher was stopped\n${launched.output().trim().slice(-3000)}`,
      );
    }
    await sleep(2_000);
  }
  deps.log(`The campaign's Nodal serves (launcher pid ${launched.pid}).`);
  return launched;
}

/**
 * Arrête l'instance (`down`). Le lanceur au premier plan sort avec ses
 * services ; s'il traîne au-delà d'une minute, le banc tue l'arbre qu'il a
 * lui-même lancé. Un échec est dit ; l'effacement le rattrape ou le nomme.
 */
export async function stopInstance(
  instance: CampaignInstance,
  deps: LifecycleDeps,
  launched?: LaunchedCli,
): Promise<void> {
  const r = await deps.cli.run(['down'], campaignEnv(deps.baseEnv, instance.home), DOWN_TIMEOUT_MS);
  if (r.code !== 0) deps.log(`nodal-agents down exited ${r.code}: ${r.output.trim().slice(-500)}`);
  if (!launched) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const out = await Promise.race([
    launched.exited.then(
      () => 'exited' as const,
      () => 'exited' as const,
    ),
    new Promise<'alive'>((r2) => {
      timer = setTimeout(() => r2('alive'), deps.launcherExitMs ?? LAUNCHER_EXIT_MS);
    }),
  ]);
  clearTimeout(timer);
  if (out === 'alive') {
    deps.log(`The launcher (pid ${launched.pid}) outlived \`down\`: its tree is stopped.`);
    launched.kill();
  }
}

/**
 * Efface l'instance : `reset --yes` (le geste du produit : down, dossier,
 * registre), puis le banc retire lui-même l'entrée du registre et le dossier,
 * et VÉRIFIE qu'il ne reste ni port qui répond, ni dossier, ni entrée. Ce qui
 * reste est nommé dans l'erreur.
 */
export async function eraseInstance(
  instance: CampaignInstance,
  deps: LifecycleDeps,
): Promise<void> {
  const env = campaignEnv(deps.baseEnv, instance.home);
  const problems: string[] = [];
  if (existsSync(instance.home)) {
    try {
      const r = await deps.cli.run(['reset', '--yes'], env, DOWN_TIMEOUT_MS);
      if (r.code !== 0)
        problems.push(`nodal-agents reset exited ${r.code}: ${r.output.trim().slice(-500)}`);
    } catch (e) {
      problems.push(`nodal-agents reset failed: ${String(e instanceof Error ? e.message : e)}`);
    }
  }
  unregisterNodalInstance(env, deps.userHome);
  try {
    rmSync(instance.home, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  } catch (e) {
    problems.push(
      `could not remove ${instance.home}: ${String(e instanceof Error ? e.message : e)}`,
    );
  }

  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const waitMs = deps.quietWaitMs ?? 30_000;
  let busy = await answeringPorts(instance.ports);
  for (let waited = 0; busy.length > 0 && waited < waitMs; waited += 1_000) {
    await sleep(1_000);
    busy = await answeringPorts(instance.ports);
  }
  if (busy.length > 0) problems.push(`ports still answering: ${busy.join(', ')}`);
  if (existsSync(instance.home)) problems.push(`the folder ${instance.home} is still there`);
  const listed = readNodalInstances(deps.userHome).filter((r) => isInside(r.home, instance.home));
  if (listed.length > 0) problems.push(`the registry of instances still names ${instance.home}`);

  if (problems.length > 0) {
    throw new Error(
      `campaign_erase_incomplete: campaign ${instance.id}:\n  - ${problems.join('\n  - ')}`,
    );
  }
  deps.log(`Campaign ${instance.id} erased: no process, no folder, no registry entry.`);
}

/** Le banc qui a posé ce marqueur vit-il encore ? */
export function benchAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM : le processus existe, il n'est pas à nous ; il vit.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Efface toute campagne laissée par un banc mort, et retire du registre une
 * campagne dont le dossier a disparu. Refuse si une campagne vit encore : les
 * ports sont les mêmes, et ses données sont les siennes. Rend les ids effacés.
 */
export async function sweepLeftoverCampaigns(
  deps: LifecycleDeps & {
    stackDir: string;
    ports: InstancePorts;
    isAlive?: (pid: number) => boolean;
  },
): Promise<string[]> {
  const root = campaignsRoot(deps.userHome);
  const alive = deps.isAlive ?? benchAlive;
  const erased: string[] = [];
  const dirs = existsSync(root)
    ? readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory())
    : [];
  for (const d of dirs) {
    const home = join(root, d.name);
    const markerFile = join(home, 'campaign.json');
    let marker: CampaignMarker | null = null;
    try {
      marker = MarkerSchema.parse(JSON.parse(readFileSync(markerFile, 'utf8')));
    } catch {
      marker = null;
    }
    if (marker && alive(marker.pid)) {
      throw new Error(
        `campaign_running: campaign ${marker.id} (bench pid ${marker.pid}) is still running from ${marker.stackDir}. ` +
          'Wait for it, or stop it, first.',
      );
    }
    // Sans marqueur lisible (un banc tué pendant qu'il l'écrivait), les ports
    // vérifiés sont ceux de la configuration courante.
    const instance: CampaignInstance = {
      id: d.name,
      home,
      ports: marker?.ports ?? deps.ports,
      stackDir: marker?.stackDir ?? deps.stackDir,
    };
    deps.log(`A campaign was left behind by a bench that is gone: ${d.name}. Erasing it.`);
    await eraseInstance(instance, deps);
    erased.push(d.name);
  }
  for (const r of readNodalInstances(deps.userHome)) {
    if (isInside(r.home, root) && !existsSync(r.home)) {
      unregisterNodalInstance({ [NODALAI_HOME_ENV]: r.home }, deps.userHome);
      deps.log(`Removed the registry entry of a campaign folder that is gone: ${r.home}`);
    }
  }
  return erased;
}
