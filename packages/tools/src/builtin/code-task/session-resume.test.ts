// session-resume.test.ts — continuité de session pour code_task (manque 1).
//
// Avant ce lot, chaque appel `code_task` repartait de zéro : le CLI relisait le
// dépôt et reconstruisait son contexte, quand bien même l'appel précédent, dans
// le même job, venait de le faire. L'identifiant de session était capturé et
// écrit en base — jamais réinjecté.
//
// Ce qui est testé ici n'est pas « la reprise marche » (ça, seul un run live le
// dit) mais les propriétés qui la rendent SÛRE, et qui sont toutes des façons
// de reprendre la mauvaise session.

import { describe, it, expect, beforeAll } from 'vitest';
import { spinUpTestDb, seedMinimal } from '@nodal-agents/db/test-utils';
import type { TestDb } from '@nodal-agents/db/test-utils';
import { codeTaskSessionKey, findResumableSession, rememberSession } from './db';
import { buildProviderArgs } from './providers';

let db: TestDb;
let seed: { userId: string; entityId: string; agentId: string; jobId: string };

beforeAll(async () => {
  const res = await spinUpTestDb();
  db = res.db;
  seed = await seedMinimal(db);
});

describe('codeTaskSessionKey', () => {
  it('est préfixée, pour ne pas entrer en collision avec le runtime', () => {
    // `cli_sessions` est unique sur (agentId, conversationKey), et le runtime
    // y écrit déjà sous `conversationId ?? chatId` (run-job.ts). Une clé nue
    // ferait partager UNE ligne à deux sessions CLI différentes — le dernier
    // écrivain gagnant, l'autre reprenant un fil qui n'est pas le sien.
    const key = codeTaskSessionKey('job-1', 'C:/ws/repo');
    expect(key.startsWith('code_task:')).toBe(true);
    expect(key).not.toBe('job-1');
  });

  it('sépare deux jobs', () => {
    expect(codeTaskSessionKey('job-1', '/ws')).not.toBe(codeTaskSessionKey('job-2', '/ws'));
  });

  it('sépare deux répertoires du même job', () => {
    // Reprendre une session qui a exploré un AUTRE arbre est pire que repartir
    // à froid : le CLI répond avec assurance sur le mauvais dépôt.
    expect(codeTaskSessionKey('job-1', '/ws/a')).not.toBe(codeTaskSessionKey('job-1', '/ws/b'));
  });
});

describe('findResumableSession', () => {
  it('rend la session écrite pour cette clé', async () => {
    const key = codeTaskSessionKey(seed.jobId, '/ws/one');
    await rememberSession(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
      provider: 'claude',
      key,
      sessionId: 'sess-abc',
    });
    expect(await findResumableSession(db, seed.agentId, 'claude', key)).toBe('sess-abc');
  });

  it("refuse la session d'un AUTRE provider", async () => {
    // Une session claude reprise via codex (ou l'inverse) échoue côté CLI,
    // bruyamment mais inutilement : on a dépensé un run pour rien.
    const key = codeTaskSessionKey(seed.jobId, '/ws/two');
    await rememberSession(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
      provider: 'claude',
      key,
      sessionId: 'sess-claude',
    });
    expect(await findResumableSession(db, seed.agentId, 'codex', key)).toBeNull();
  });

  it('ne traverse pas les jobs', async () => {
    // LA propriété qui compte. Un job = un fil de travail ; le job suivant part
    // à froid, sinon un agent hérite des conclusions d'une tâche sans rapport.
    const key1 = codeTaskSessionKey('job-A', '/ws');
    await rememberSession(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
      provider: 'claude',
      key: key1,
      sessionId: 'sess-jobA',
    });
    const key2 = codeTaskSessionKey('job-B', '/ws');
    expect(await findResumableSession(db, seed.agentId, 'claude', key2)).toBeNull();
  });

  it('remplace au lieu de dupliquer quand le même fil rend une nouvelle session', async () => {
    const key = codeTaskSessionKey(seed.jobId, '/ws/three');
    await rememberSession(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
      provider: 'codex',
      key,
      sessionId: 'sess-1',
    });
    await rememberSession(db, {
      entityId: seed.entityId,
      agentId: seed.agentId,
      provider: 'codex',
      key,
      sessionId: 'sess-2',
    });
    expect(await findResumableSession(db, seed.agentId, 'codex', key)).toBe('sess-2');
  });
});

describe("buildProviderArgs — la reprise n'a pas la même forme selon le CLI", () => {
  it('claude : un drapeau', () => {
    const args = buildProviderArgs('claude', 'read', { resumeSessionId: 'S1' });
    expect(args[args.indexOf('--resume') + 1]).toBe('S1');
  });

  it('codex : une SOUS-COMMANDE, et le sandbox change de véhicule', () => {
    // `codex exec resume` n'accepte pas `--sandbox` : le confinement passe par
    // un override `-c`. Vérifié en conditions réelles avec
    // `--ignore-user-config` : un tour repris en lecture répond « le système de
    // fichiers est en lecture seule » et n'écrit rien.
    const args = buildProviderArgs('codex', 'read', { resumeSessionId: 'S1' });
    expect(args.slice(0, 3)).toEqual(['exec', 'resume', 'S1']);
    expect(args).not.toContain('--sandbox');
    expect(args.join(' ')).toContain('sandbox_mode="read-only"');
  });

  it("codex repris garde l'isolation de la config utilisateur", () => {
    // La régression à craindre : la branche `resume` est une seconde liste
    // d'arguments, donc elle peut diverger de la branche froide sans que rien
    // ne le signale. C'est exactement ce qui laissait `mcp_servers={}` en place.
    for (const mode of ['read', 'write'] as const) {
      const args = buildProviderArgs('codex', mode, { resumeSessionId: 'S1' });
      expect(args, `codex/${mode} repris charge la config utilisateur`).toContain(
        '--ignore-user-config',
      );
    }
  });

  it('sans reprise, la forme froide est inchangée', () => {
    const args = buildProviderArgs('codex', 'read');
    expect(args.slice(0, 2)).toEqual(['exec', '--json']);
    expect(args).toContain('--sandbox');
  });
});
