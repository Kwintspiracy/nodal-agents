// workflows/printers.ts — les imprimantes qu'une commande de l'instance peut atteindre.
//
// Règle du propriétaire : un essai du banc n'imprime JAMAIS sur une vraie
// imprimante. L'imprimante du banc (#794) reçoit les demandes de l'équipe ;
// mais une commande lancée par un agent (`run_command`, que le Chef et
// l'Imageur ont sans demande) peut, elle, joindre le spooler de la machine :
// sous Windows, le bac à sable coupe CIM, WMI et le gestionnaire de services,
// pas winspool (mesuré le 22/10, #842). Avant un essai d'impression, le banc
// COMPTE donc les imprimantes qu'une telle commande voit, par le VRAI
// `run_command` (runCommandTool), sous le bac à sable que le runner de
// l'instance ouvre (`instanceSandbox` : le même backend, les ports de CETTE
// instance), dans une portée de job jetable fermée ensuite. Le runner n'a pas
// de route qui lance une commande sans job ni modèle : c'est le même outil et
// le même bac à sable, dans le processus du banc. Sans instance donnée (le
// banc sur la stack du propriétaire), le bac à sable de ce processus ; s'il
// est indisponible, la commande tourne non confinée, voit au moins autant
// d'imprimantes, et le compte le dit (`confined: false`).
//
// La sonde ne fait que LISTER : elle n'imprime rien, ne nomme aucune
// imprimante, et ne rend qu'un nombre. Elle compte tout ce que le spooler
// énumère, imprimantes virtuelles comprises (un fichier PDF est une sortie
// d'impression comme une autre) : trier « vraies » et « virtuelles » par leur
// nom serait une heuristique.

import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Sandbox } from '@nodal-agents/sandbox';
import type { PrinterReach } from './types';

/**
 * La commande de la sonde, par famille de système, passée telle quelle à
 * `run_command` (cmd.exe sous Windows, /bin/sh ailleurs). Elle écrit un seul
 * nombre sur sa dernière ligne.
 *   - Windows : `EnumPrinters` (winspool), par .NET : le chemin que prennent
 *     `Out-Printer`, `print.exe` et `Start-Process -Verb Print` ;
 *   - ailleurs : les destinations de CUPS (`lpstat -e`). Sans `lpstat` mais
 *     avec une socket CUPS, la sonde ne sait pas compter et le dit ; sans
 *     l'un ni l'autre, aucun système d'impression : zéro.
 */
export const PRINTER_PROBE_COMMAND: Readonly<Record<'windows' | 'unix', string>> = {
  windows:
    'powershell -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Drawing; [System.Drawing.Printing.PrinterSettings]::InstalledPrinters.Count"',
  unix:
    'if command -v lpstat >/dev/null 2>&1; then lpstat -e 2>/dev/null | wc -l; ' +
    'elif [ -S /run/cups/cups.sock ] || [ -S /var/run/cups/cups.sock ] || [ -S /private/var/run/cupsd ]; ' +
    'then echo "a CUPS socket is there but lpstat is missing" >&2; exit 3; else echo 0; fi',
};

/** Ce que la sonde rend de la sortie de `run_command`, ou pourquoi elle n'a pas compté. */
export function readProbeOutput(out: {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly sandbox?: { readonly confined?: boolean };
}): PrinterReach {
  const last = out.stdout.trim().split(/\r?\n/).pop()?.trim() ?? '';
  if (!out.timedOut && out.exitCode === 0 && /^\d+$/.test(last)) {
    return { kind: 'counted', count: Number(last), confined: out.sandbox?.confined === true };
  }
  const why = out.timedOut
    ? 'it timed out'
    : `exit ${out.exitCode ?? 'none'}, output ${JSON.stringify(last.slice(0, 80))}`;
  const err = out.stderr.trim().split(/\r?\n/).pop()?.trim();
  return {
    kind: 'failed',
    reason: `the probe did not return a number (${why}${err ? `; ${err.slice(0, 200)}` : ''})`,
  };
}

/**
 * Compte les imprimantes qu'une commande lancée par un agent peut atteindre
 * ici. Ne lève jamais : une sonde qui ne tourne pas rend `failed`, avec la
 * raison, et le besoin manque (fermé par défaut).
 */
export async function probeReachablePrinters(
  opts: { readonly sandbox?: Sandbox; readonly platform?: NodeJS.Platform } = {},
): Promise<PrinterReach> {
  const platform = opts.platform ?? process.platform;
  const dir = mkdtempSync(join(tmpdir(), 'nodal-bench-printer-probe-'));
  const jobId = `bench-printer-probe:${randomUUID()}`;
  try {
    const { runCommandTool } = await import('@nodal-agents/tools');
    const { closeJobProcessScope, jobProcessScope } = await import('@nodal-agents/sandbox');
    // La portée du job, ouverte sous le bac à sable de l'instance : le vrai
    // `run_command` la reprend telle quelle.
    jobProcessScope(jobId, opts.sandbox);
    try {
      const out = await runCommandTool.execute(
        {
          purpose: 'Count the printers this machine can reach (lists them, prints nothing)',
          command: PRINTER_PROBE_COMMAND[platform === 'win32' ? 'windows' : 'unix'],
          timeout_seconds: 120,
        },
        {
          jobId,
          agentId: 'bench-printer-probe',
          entityId: 'bench-printer-probe',
          db: undefined as never,
          jobChatId: null,
          workspaces: [{ label: 'probe', path: dir }],
        },
      );
      return readProbeOutput(out);
    } finally {
      await closeJobProcessScope(jobId);
    }
  } catch (e) {
    return {
      kind: 'failed',
      reason: `the probe could not run: ${String(e instanceof Error ? e.message : e)}`,
    };
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}
