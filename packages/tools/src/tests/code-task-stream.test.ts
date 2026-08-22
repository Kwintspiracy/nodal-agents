// code-task-stream.test.ts — runCli livre-t-il les lignes PENDANT l'exécution ?
//
// C'est la propriété qui compte, et la seule que le parseur d'événements ne
// prouve pas. Un test qui vérifierait seulement « toutes les lignes ont fini par
// arriver » passerait aussi sur l'ancien code, qui les rendait toutes d'un coup
// à la fin — donc il ne prouverait rien.
//
// Vrai processus enfant, pas de bouchon : `node -e` est présent partout où ces
// tests tournent.

import { describe, it, expect } from 'vitest';
import { runCli } from '../builtin/code-task/process';

const nodeCli = { path: process.execPath, isBatch: false };

describe('runCli — flux ligne par ligne', () => {
  it('livre chaque ligne AVANT la fin du processus', async () => {
    // L'enfant écrit trois lignes espacées, puis dort. Si les lignes n'arrivaient
    // qu'à la terminaison, les trois porteraient un horodatage collé à la fin.
    const script =
      "const s=(m)=>{process.stdout.write(JSON.stringify({n:m})+'\\n')};" +
      's(1);setTimeout(()=>s(2),120);setTimeout(()=>s(3),240);setTimeout(()=>{},400);';

    const recu: Array<{ line: string; at: number }> = [];
    const t0 = Date.now();
    const run = await runCli(nodeCli, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: process.env as Record<string, string | undefined>,
      onStdoutLine: (line) => recu.push({ line, at: Date.now() - t0 }),
    });

    expect(run.exitCode, 'le processus a échoué').toBe(0);
    expect(recu.map((r) => r.line)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);

    // LA propriété : la première ligne est arrivée nettement avant la dernière.
    // Sur l'ancien code (tout rendu à la fin) cet écart serait ~0.
    const ecart = recu[2]!.at - recu[0]!.at;
    expect(ecart, `les lignes sont arrivées groupées (écart ${ecart} ms)`).toBeGreaterThan(80);
  });

  it('livre la DERNIÈRE ligne même sans retour à la ligne final', async () => {
    // C'est précisément la ligne qui compte : le résultat pour claude,
    // `turn.completed` pour codex. La perdre viderait le run de son sens.
    const script = 'process.stdout.write(\'{"type":"result"}\')';
    const recu: string[] = [];
    await runCli(nodeCli, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: process.env as Record<string, string | undefined>,
      onStdoutLine: (line) => recu.push(line),
    });
    expect(recu, 'la dernière ligne sans \\n a été perdue').toEqual(['{"type":"result"}']);
  });

  it('un crochet qui lève ne tue pas la session observée', async () => {
    const script = "process.stdout.write('a\\nb\\n')";
    const run = await runCli(nodeCli, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: process.env as Record<string, string | undefined>,
      onStdoutLine: () => {
        throw new Error('crochet fautif');
      },
    });
    expect(run.exitCode, "l'observation a fait tomber la course").toBe(0);
    expect(run.stdout).toContain('a');
  });

  it('sans crochet, le comportement est inchangé', async () => {
    const script = "process.stdout.write('x\\n')";
    const run = await runCli(nodeCli, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 15_000,
      env: process.env as Record<string, string | undefined>,
    });
    expect(run.stdout).toBe('x\n');
    expect(run.truncated).toBe(false);
  });
});

describe('une ligne géante n’emporte pas ses voisines', () => {
  it('livre les lignes complètes qui SUIVENT une ligne surdimensionnée', async () => {
    // Constat de la passe 3, et un défaut de mon propre correctif : le plafond
    // s'appliquait au tampon ENTIER et cherchait le DERNIER saut de ligne, donc
    // tout ce qui précédait était jeté — y compris des lignes complètes du même
    // chunk, dont pouvait faire partie l'événement de résultat. Mon commentaire
    // affirmait que « seule la ligne courante » se perdait ; c'était faux.
    const script =
      'process.stdout.write(\'{"a":1}\\n\');' +
      "process.stdout.write('{\"big\":\"' + 'x'.repeat(300000) + '\"}\\n');" +
      'process.stdout.write(\'{"type":"result"}\\n\');';

    const recu: string[] = [];
    const run = await runCli(nodeCli, ['-e', script], {
      cwd: process.cwd(),
      timeoutMs: 30_000,
      env: process.env as Record<string, string | undefined>,
      onStdoutLine: (line) => recu.push(line),
    });

    expect(run.exitCode, `stderr: ${run.stderr.slice(0, 300)}`).toBe(0);
    expect(recu, "la ligne d'AVANT a été perdue").toContain('{"a":1}');
    expect(recu, "la ligne d'APRÈS a été perdue — c'est le résultat").toContain(
      '{"type":"result"}',
    );
    expect(
      recu.some((l) => l.length > 200_000),
      'la ligne géante a quand même été livrée',
    ).toBe(false);
  }, 30_000);
});
