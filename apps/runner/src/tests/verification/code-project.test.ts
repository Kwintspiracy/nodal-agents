// code-project.test.ts — le vérificateur du livrable « projet de code ».
//
// Tout est prouvé sur de VRAIS processus et de VRAIES lignes : les commandes
// qui ne doivent pas tourner écrivent un fichier témoin qui doit rester
// absent, et les verdicts sont lus dans le résultat, jamais dans un compteur
// d'appels.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { eq, codeProjects } from '@nodal-agents/db';
import {
  ENV_ALLOWLIST_VERSION,
  SHELL_POLICY_VERSION,
  hashVerificationManifest,
  normalizePath,
  projectKey,
} from '@nodal-agents/shared';
import type { VerifyCommand } from '@nodal-agents/shared';
import {
  codeProjectVerifier,
  VERIFY_RUN_CALLBACK_FAILED,
} from '../../verification/code-project.ts';
import type { ProofCommandRecord, ReadyConfig } from '../../verification/registry.ts';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };
let dir: string;
let projectPath: string;
const node = process.execPath;

beforeAll(async () => {
  const spun = await spinUpTestDb();
  db = spun.db;
  seed = await seedMinimal(db);
  dir = await mkdtemp(join(tmpdir(), 'nodal-verif-cp-'));
  projectPath = normalizePath(dir);
});

afterAll(async () => {
  for (let i = 0; i < 5; i++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
});

/** Écrit un script et rend la commande shell qui le lance (chemins quotés). */
async function script(name: string, body: string): Promise<string> {
  const p = join(dir, name);
  await writeFile(p, body, 'utf8');
  return `"${node}" "${p}"`;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

const manifestHashOf = (commands: VerifyCommand[], key: string): string =>
  hashVerificationManifest({
    verifierConfig: commands,
    invariants: [],
    canonicalKey: key,
    cwd: projectPath,
    shellPolicyVersion: SHELL_POLICY_VERSION,
    envAllowlistVersion: ENV_ALLOWLIST_VERSION,
  });

/**
 * (Re)pose la ligne `code_projects` du dossier de test. `approved` vaut la
 * révision approuvée par le propriétaire — `null` pour ne rien approuver,
 * `'current'` pour approuver exactement `commands`.
 */
async function setProject(
  commands: VerifyCommand[] | null,
  approved: 'current' | string | null,
): Promise<string> {
  const key = projectKey(projectPath);
  const hash =
    approved === 'current'
      ? manifestHashOf(commands ?? [], key)
      : approved === null
        ? null
        : approved;
  await db.delete(codeProjects).where(eq(codeProjects.projectKey, key));
  await db.insert(codeProjects).values({
    entityId: seed.entityId,
    projectPath,
    projectKey: key,
    verifyCommands: commands,
    verificationEpoch: 7,
    verifyApprovedManifestHash: hash,
  });
  return key;
}

describe('code-project — loadConfig', () => {
  it('verify_commands NULL ⇒ not_configured (rien à prouver, ce n’est pas un échec)', async () => {
    const key = await setProject(null, null);
    const config = await codeProjectVerifier.loadConfig(db, {
      entityId: seed.entityId,
      canonicalKey: key,
    });
    expect(config.kind).toBe('not_configured');
  });

  it('aucune ligne code_projects ⇒ not_configured', async () => {
    const config = await codeProjectVerifier.loadConfig(db, {
      entityId: seed.entityId,
      canonicalKey: '/srv/jamais-configure',
    });
    expect(config.kind).toBe('not_configured');
  });

  it('hash approuvé ≠ hash courant (un timeout modifié) ⇒ pending_approval, et RIEN n’est lancé', async () => {
    const witness = join(dir, 'temoin-pending.txt');
    const cmd = await script(
      'pending.js',
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'x'); process.exit(0)`,
    );
    const key = projectKey(projectPath);
    // Approuvé avec timeoutSeconds 5, la configuration courante en porte 6 :
    // le manifeste couvre le timeout, donc l'approbation ne vaut plus.
    const approuve = manifestHashOf([{ command: cmd, timeoutSeconds: 5 }], key);
    await setProject([{ command: cmd, timeoutSeconds: 6 }], approuve);

    const config = await codeProjectVerifier.loadConfig(db, {
      entityId: seed.entityId,
      canonicalKey: key,
    });
    expect(config.kind).toBe('pending_approval');
    expect(await exists(witness)).toBe(false);
  });

  it('hash approuvé = hash courant ⇒ ready, avec cwd = project_path et l’epoch lu', async () => {
    const cmd = await script('ready.js', 'process.exit(0)');
    const commands = [{ command: cmd, timeoutSeconds: 20 }];
    const key = await setProject(commands, 'current');
    const config = await codeProjectVerifier.loadConfig(db, {
      entityId: seed.entityId,
      canonicalKey: key,
    });
    expect(config.kind).toBe('ready');
    if (config.kind !== 'ready') return;
    expect(config.cwd).toBe(projectPath);
    expect(config.epoch).toBe(7);
    expect(config.commands).toEqual(commands);
    expect(config.manifestHash).toBe(manifestHashOf(commands, key));
  });
});

describe('code-project — runProof', () => {
  const readyOf = (commands: VerifyCommand[]): ReadyConfig => ({
    kind: 'ready',
    manifestHash: manifestHashOf(commands, projectKey(projectPath)),
    cwd: projectPath,
    commands,
    epoch: 7,
  });

  it('preuve verte : verdict green, onCommandDone appelé une fois au rang 0, exitCode 0', async () => {
    const cmd = await script('green.js', 'process.exit(0)');
    const seen: ProofCommandRecord[] = [];
    const proof = await codeProjectVerifier.runProof(
      readyOf([{ command: cmd, timeoutSeconds: 20 }]),
      async (record) => {
        seen.push(record);
      },
    );
    expect(proof.verdict).toBe('green');
    expect(seen).toHaveLength(1);
    expect(seen[0]?.rank).toBe(0);
    expect(seen[0]?.exitCode).toBe(0);
    expect(seen[0]?.outcomeKind).toBe('exit');
    expect(seen[0]?.verdict).toBe('green');
    expect(proof.records.map((r) => r.rank)).toEqual([0]);
  });

  it('séquence [ok, exit 1, ok] ⇒ rangs 0 et 1 seulement, verdict red, la 3e n’a jamais tourné', async () => {
    const witness = join(dir, 'temoin-troisieme.txt');
    const ok = await script('seq-ok.js', "process.stdout.write('ok')");
    const red = await script('seq-red.js', "process.stderr.write('nope'); process.exit(1)");
    const third = await script(
      'seq-third.js',
      `require('node:fs').writeFileSync(${JSON.stringify(witness)}, 'x')`,
    );
    const seen: number[] = [];
    const proof = await codeProjectVerifier.runProof(
      readyOf([
        { command: ok, timeoutSeconds: 20 },
        { command: red, timeoutSeconds: 20 },
        { command: third, timeoutSeconds: 20 },
      ]),
      async (record) => {
        seen.push(record.rank);
      },
    );
    expect(proof.verdict).toBe('red');
    expect(seen).toEqual([0, 1]);
    expect(proof.records.map((r) => r.verdict)).toEqual(['green', 'red']);
    expect(proof.records[1]?.exitCode).toBe(1);
    expect(proof.records[1]?.stderrTail).toContain('nope');
    expect(await exists(witness)).toBe(false);
  });

  it('la preuve tourne HORS transaction : une lecture de code_projects passe pendant une preuve de 3 s', async () => {
    // Preuve faible sur PGlite (une seule connexion) : ce qu'elle établit
    // vraiment, c'est que `runProof` ne reçoit aucun `tx` et n'ouvre aucune
    // transaction — une requête lancée PENDANT la preuve se résout avant elle.
    // L'interleaving réel à deux connexions est T14.
    const slow = await script('slow.js', 'setTimeout(() => process.exit(0), 3000)');
    const order: string[] = [];
    const proof = codeProjectVerifier
      .runProof(readyOf([{ command: slow, timeoutSeconds: 30 }]), async () => {})
      .then((r) => {
        order.push('preuve');
        return r;
      });
    await new Promise((r) => setTimeout(r, 300));
    await db.select().from(codeProjects).where(eq(codeProjects.entityId, seed.entityId));
    order.push('select');
    const result = await proof;
    expect(result.verdict).toBe('green');
    expect(order).toEqual(['select', 'preuve']);
  });

  it('écriture de run en panne ⇒ le verdict survit, un code est journalisé (best-effort)', async () => {
    const cmd = await script('survivor.js', 'process.exit(0)');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const proof = await codeProjectVerifier.runProof(
        readyOf([{ command: cmd, timeoutSeconds: 20 }]),
        async () => {
          throw new Error('disque plein');
        },
      );
      expect(proof.verdict).toBe('green');
      expect(proof.records).toHaveLength(1);
      const codes = warn.mock.calls.map((c) => String(c[0]));
      expect(codes.some((c) => c.includes(VERIFY_RUN_CALLBACK_FAILED))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('timeout ⇒ verdict infra_error, exitCode null (jamais confondu avec un rouge)', async () => {
    const cmd = await script('hang.js', 'setTimeout(() => {}, 60000)');
    const proof = await codeProjectVerifier.runProof(
      readyOf([{ command: cmd, timeoutSeconds: 1 }]),
      async () => {},
    );
    expect(proof.verdict).toBe('infra_error');
    expect(proof.records[0]?.outcomeKind).toBe('timeout');
    expect(proof.records[0]?.exitCode).toBeNull();
    expect(proof.records[0]?.verdict).toBe('infra_error');
  });
});
