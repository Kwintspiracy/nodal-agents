// Le worker meurt pendant que vitest lui répond (#970) : il demande trente
// modules à vitest et se tue avant leurs réponses. La réponse qui arrive à un
// mort échoue (`write EPIPE`, ou `Channel closed` une fois le tuyau fermé), et
// vitest arrête le worker AVANT que son `exit` n'arrive. Mesuré sous Windows
// avant le correctif : la ligne manquait dans 16 runs sur 36.
//
// Les modules sont écrits dans WORKER_EXIT_SCRATCH, que le test crée et efface :
// le worker, tué, ne peut pas faire le ménage lui-même.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

it('the worker is killed with replies in flight', async () => {
  const dir = mkdtempSync(join(process.env['WORKER_EXIT_SCRATCH'] ?? tmpdir(), 'replies-'));
  for (let n = 1; n <= 30; n++) {
    const file = join(dir, `m${n}.ts`);
    writeFileSync(file, `export const n = ${n};\n`);
    void import(/* @vite-ignore */ file);
  }
  await new Promise((resolve) => setTimeout(resolve, 3));
  process.kill(process.pid, 'SIGKILL');
});
