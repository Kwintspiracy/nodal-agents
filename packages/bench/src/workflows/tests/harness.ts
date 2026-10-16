// harness.ts — jouer un scénario de bout en bout SANS modèle : préparer, faire le
// travail de l'agent à la main, observer, juger.
//
// Les scénarios de la v2 n'ont pas encore d'essai réel capturé (aucun essai
// n'a été joué sur la stack pour eux). Le harnais n'invente donc pas un
// livrable « vert » en mémoire : il appelle le VRAI `prepare` du scénario dans
// un dossier de travail temporaire (les fixtures y sont posées comme sur la
// stack), écrit le livrable sur le disque avec les mêmes bibliothèques qu'un
// agent utiliserait, puis appelle le VRAI `observe` et le VRAI `judge`. Seules
// les lignes de la base (statut, outils appelés, réponse) sont construites,
// dans la forme exacte que `readTreeFacts` rend (le schéma Zod les valide).

import { mkdtempSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { TreeFactsSchema, type TreeFacts } from '../facts';
import { scenarioById } from '../scenarios';
import type { ScenarioEnv } from '../types';

export const ROOT_ID = '00000000-0000-4000-8000-0000000000a1';
export const KID_ID = '00000000-0000-4000-8000-0000000000a2';
const T0 = 1_790_000_000_000;

export interface Run {
  /** La réponse finale du job de tête. */
  readonly result?: string;
  readonly status?: string;
  /** Appels d'outils de l'arbre : nom et entrée (JSON). */
  readonly tools?: ReadonlyArray<{ name: string; input?: unknown; output?: string; job?: string }>;
  /** Un délégué a travaillé (un job enfant). */
  readonly delegated?: boolean;
  readonly approvals?: number;
}

export function facts(run: Run): TreeFacts {
  const jobs = [
    {
      id: ROOT_ID,
      parentJobId: null,
      agentSlug: 'root',
      status: run.status ?? 'completed',
      channel: 'mcp',
      result: run.result ?? 'Fait.',
      error: null,
      createdMs: T0,
      updatedMs: T0 + 60_000,
    },
    ...(run.delegated
      ? [
          {
            id: KID_ID,
            parentJobId: ROOT_ID,
            agentSlug: 'helper',
            status: 'completed',
            channel: 'mcp',
            result: 'ok',
            error: null,
            createdMs: T0 + 1_000,
            updatedMs: T0 + 50_000,
          },
        ]
      : []),
  ];
  return TreeFactsSchema.parse({
    rootId: ROOT_ID,
    entityId: '00000000-0000-4000-8000-0000000000e1',
    jobs,
    toolCalls: (run.tools ?? []).map((t, i) => ({
      jobId: t.job ?? ROOT_ID,
      toolName: t.name,
      input: t.input === undefined ? null : JSON.stringify(t.input),
      output: t.output ?? null,
      createdMs: T0 + 2_000 + i,
    })),
    llmCalls: [],
    approvals: Array.from({ length: run.approvals ?? 0 }, (_, i) => ({
      id: `a${i}`,
      jobId: ROOT_ID,
      kind: 'approval',
      status: 'expired',
      toolName: 'run_command',
      resolvedBy: null,
      requestedMs: T0 + 3_000,
    })),
  });
}

/** Recule la date de tous les fichiers d'un dossier : ce que `prepare` a posé est d'AVANT l'essai. */
function ageAll(dir: string, ms: number): void {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) ageAll(p, ms);
    else if (e.isFile()) utimesSync(p, new Date(ms), new Date(ms));
  }
}

export interface Played {
  readonly root: string;
  readonly reasons: string[];
  readonly observed: unknown;
}

/**
 * Joue le scénario `id` : prepare → `work(root)` (le travail de l'agent) →
 * observe → judge. Rend les raisons du rouge (vide = vert).
 */
export async function play(
  id: string,
  run: Run,
  work: (root: string) => void | Promise<void> = () => undefined,
): Promise<Played> {
  const s = scenarioById(id);
  if (!s) throw new Error(`unknown scenario ${id}`);
  const root = mkdtempSync(join(tmpdir(), `wf-${id}-`));
  const env0: ScenarioEnv = {
    workspaceRoots: [root],
    teamTools: [],
    services: {},
    unlistedMcpServers: [],
    startedMs: 0,
  };
  s.prepare?.(env0);
  ageAll(root, Date.now() - 3_600_000);
  // Une seconde de marge : sous Windows, la date d'un fichier suit une horloge
  // plus grossière (≈ 16 ms) que Date.now(), et un fichier écrit juste après
  // le début pourrait sembler écrit avant. Un vrai essai dure des secondes.
  const startedMs = Date.now() - 1_000;
  await work(root);
  const env: ScenarioEnv = { ...env0, startedMs };
  const observed = await s.observe(facts(run), env);
  return { root, reasons: s.judge(facts(run), observed), observed };
}

/** Un PNG minimal mais valide (signature, IHDR, IDAT, IEND) : ce qu'un en-tête dit, il le dit vraiment. */
export function png(width: number, height: number, seed = 0): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profondeur
  ihdr[9] = 0; // niveaux de gris
  // Une seule ligne de pixels compressée suffit à rendre chaque fichier distinct par `seed`.
  const idat = deflateSync(Buffer.from([0, seed & 0xff]));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** La date de modification d'un fichier (pour vérifier qu'un test a bien écrit). */
export function mtime(p: string): number {
  return statSync(p).mtimeMs;
}
