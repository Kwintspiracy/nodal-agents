// campaign/home.ts — où vivent le banc de l'utilisateur et le dossier de chaque campagne.
//
// Seulement des modules de Node, et le module des chemins de Nodal qui ne
// calcule rien à son chargement : le CLI de campagne (cli.ts) calcule le
// dossier de la campagne, y pointe `NODALAI_HOME`, et SEULEMENT ENSUITE charge
// le reste du banc, dont des modules qui lisent le dossier de Nodal à leur
// chargement (le verrou du banc, sa configuration de services).

import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NODAL_HOME_OVERRIDES, NODALAI_HOME_ENV } from '@nodal-agents/shared/nodal-home';

/** Le dossier du banc chez l'utilisateur : ses clés, et le dossier de chaque campagne. */
export function benchUserDir(userHome: string = homedir()): string {
  return join(userHome, '.nodal-bench');
}

/** Où vivent les dossiers des campagnes. */
export function campaignsRoot(userHome: string = homedir()): string {
  return join(benchUserDir(userHome), 'campaigns');
}

/** Le dossier de Nodal (`NODALAI_HOME`) d'une campagne. */
export function campaignHome(id: string, userHome: string = homedir()): string {
  return join(campaignsRoot(userHome), id);
}

/** `20261022-091500-a1b2` : triable, et unique d'une campagne à l'autre. */
export function newCampaignId(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${day}-${time}-${randomBytes(2).toString('hex')}`;
}

/**
 * Pointe le processus du BANC sur l'instance : `NODALAI_HOME`, et aucune des
 * variables étroites qui enverraient une entrée ailleurs (ni l'agent épinglé
 * d'un `mcp serve`). Appelé une fois, au tout début de la commande, avant que
 * les modules qui lisent le dossier de Nodal ne soient chargés.
 */
export function pointProcessAt(home: string, env: NodeJS.ProcessEnv = process.env): void {
  const narrow = new Set<string>([...Object.values(NODAL_HOME_OVERRIDES), 'NODAL_MCP_AGENT_ID']);
  for (const k of Object.keys(env)) {
    if (narrow.has(k.toUpperCase())) delete env[k];
  }
  env[NODALAI_HOME_ENV] = home;
}

/**
 * Le message d'une erreur ET de ses causes : Drizzle range l'erreur de
 * Postgres dans `cause` et ne garde que « Failed query: … » dehors. Une
 * campagne qui échoue dit pourquoi, pas seulement où.
 */
export function describeError(e: unknown): string {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; cur !== undefined && cur !== null && depth < 5; depth++) {
    if (cur instanceof Error) {
      const code = (cur as NodeJS.ErrnoException).code;
      // Une AggregateError (une connexion refusée sur ::1 PUIS 127.0.0.1) n'a
      // pas de message à elle : ce sont ses erreurs qui le portent.
      const inner =
        cur instanceof AggregateError
          ? cur.errors.map((x: unknown) => describeError(x)).join('; ')
          : '';
      parts.push(
        [cur.message, code ? `(${code})` : '', inner].filter(Boolean).join(' ') || cur.name,
      );
      cur = cur.cause;
    } else {
      parts.push(String(cur));
      cur = undefined;
    }
  }
  return parts.join('\n  caused by: ');
}
