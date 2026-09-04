// shell-engine-sequence.test.ts — runCommandSequence (v5-A) : ordre, arrêt au
// premier non-vert, callback attendu, liste validée. Sur de vrais processus ;
// les commandes qui ne doivent PAS tourner écrivent un fichier témoin qui doit
// rester absent — un test qui n'assertait que `results.length` passerait avec
// une 3e commande lancée en arrière-plan.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommandSequence } from '../builtin/shell-engine';
import { buildChildEnv } from '../builtin/child-env';

let dir: string;
const node = process.execPath;
const env = buildChildEnv(process.env);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nodal-seq-'));
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

describe('runCommandSequence', () => {
  it('une seule commande verte ⇒ green, un résultat au rang 0, callback appelé une fois', async () => {
    const ok = await script('ok1.js', 'process.exit(0)');
    const seen: number[] = [];
    const r = await runCommandSequence([{ command: ok, timeoutSeconds: 20 }], {
      cwd: dir,
      env,
      onCommandDone: async (s) => {
        seen.push(s.rank);
      },
    });
    expect(r.verdict).toBe('green');
    expect(r.results.map((x) => x.rank)).toEqual([0]);
    expect(r.stoppedAtRank).toBeUndefined();
    expect(seen).toEqual([0]);
  });

  it('vert ssi toutes vertes : [ok, ok] ⇒ green, deux résultats dans l’ordre', async () => {
    const a = await script('a.js', "process.stdout.write('a')");
    const b = await script('b.js', "process.stdout.write('b')");
    const r = await runCommandSequence(
      [
        { command: a, timeoutSeconds: 20 },
        { command: b, timeoutSeconds: 20 },
      ],
      { cwd: dir, env, onCommandDone: async () => {} },
    );
    expect(r.verdict).toBe('green');
    expect(r.results.map((x) => x.stdout)).toEqual(['a', 'b']);
  });

  it('arrêt au premier rouge : [ok, exit 1, ok] ⇒ red, 2 résultats, la 3e n’a jamais tourné', async () => {
    const witness = join(dir, 'witness-red.txt');
    const ok = await script('ok2.js', 'process.exit(0)');
    const red = await script('red.js', "process.stderr.write('nope'); process.exit(1)");
    const third = await script(
      'third.js',
      `require('fs').writeFileSync(${JSON.stringify(witness)}, 'ran')`,
    );
    const r = await runCommandSequence(
      [
        { command: ok, timeoutSeconds: 20 },
        { command: red, timeoutSeconds: 20 },
        { command: third, timeoutSeconds: 20 },
      ],
      { cwd: dir, env, onCommandDone: async () => {} },
    );
    expect(r.verdict).toBe('red');
    expect(r.results.length).toBe(2);
    expect(r.stoppedAtRank).toBe(1);
    expect(r.results[1]?.outcome).toEqual({ kind: 'exit', exitCode: 1 });
    expect(r.results[1]?.stderr).toBe('nope');
    // Laisser le temps à un éventuel lancement fautif d'écrire le témoin.
    await new Promise((res) => setTimeout(res, 300));
    expect(await exists(witness)).toBe(false);
  });

  it('timeout ⇒ infra_error, stoppedAtRank sur la commande qui a dépassé', async () => {
    const ok = await script('ok3.js', 'process.exit(0)');
    const slow = await script('slow.js', 'setTimeout(() => {}, 60000)');
    const r = await runCommandSequence(
      [
        { command: ok, timeoutSeconds: 20 },
        { command: slow, timeoutSeconds: 1 },
      ],
      { cwd: dir, env, onCommandDone: async () => {} },
    );
    expect(r.verdict).toBe('infra_error');
    expect(r.stoppedAtRank).toBe(1);
    expect(r.results[1]?.outcome.kind).toBe('timeout');
  });

  it('le callback est ATTENDU avant la commande suivante — la persistance prime', async () => {
    // onCommandDone du rang 0 attend 300 ms et note l'heure de sa fin ; la
    // commande 1 écrit l'heure de son démarrage. Si le moteur n'attendait pas,
    // la commande 1 démarrerait AVANT la fin du callback.
    const stamp = join(dir, 'stamp.txt');
    const first = await script('first.js', 'process.exit(0)');
    const second = await script(
      'second.js',
      `require('fs').writeFileSync(${JSON.stringify(stamp)}, String(Date.now()))`,
    );
    let callbackEndedAt = 0;
    const r = await runCommandSequence(
      [
        { command: first, timeoutSeconds: 20 },
        { command: second, timeoutSeconds: 20 },
      ],
      {
        cwd: dir,
        env,
        onCommandDone: async (s) => {
          if (s.rank === 0) {
            await new Promise((res) => setTimeout(res, 300));
            callbackEndedAt = Date.now();
          }
        },
      },
    );
    expect(r.verdict).toBe('green');
    const secondStartedAt = Number(await readFile(stamp, 'utf8'));
    expect(callbackEndedAt).toBeGreaterThan(0);
    expect(secondStartedAt).toBeGreaterThanOrEqual(callbackEndedAt);
  });

  it('un callback qui rejette interrompt la séquence et propage — la 2e ne tourne pas', async () => {
    const witness = join(dir, 'witness-cb.txt');
    const first = await script('first-cb.js', 'process.exit(0)');
    const second = await script(
      'second-cb.js',
      `require('fs').writeFileSync(${JSON.stringify(witness)}, 'ran')`,
    );
    await expect(
      runCommandSequence(
        [
          { command: first, timeoutSeconds: 20 },
          { command: second, timeoutSeconds: 20 },
        ],
        {
          cwd: dir,
          env,
          onCommandDone: async () => {
            throw new Error('PERSIST_FAILED');
          },
        },
      ),
    ).rejects.toThrow('PERSIST_FAILED');
    await new Promise((res) => setTimeout(res, 300));
    expect(await exists(witness)).toBe(false);
  });

  it('liste vide ou trop longue ⇒ VERIFY_COMMANDS_INVALID, rien n’est lancé', async () => {
    await expect(
      runCommandSequence([], { cwd: dir, env, onCommandDone: async () => {} }),
    ).rejects.toThrow('VERIFY_COMMANDS_INVALID');
    const six = Array.from({ length: 6 }, (_, i) => ({ command: `echo ${i}`, timeoutSeconds: 5 }));
    await expect(
      runCommandSequence(six, { cwd: dir, env, onCommandDone: async () => {} }),
    ).rejects.toThrow('VERIFY_COMMANDS_INVALID');
  });
});
