// Le worker meurt sans que vitest l'ait demandé : tué de l'extérieur, comme par
// un `taskkill /F` (Windows) ou un SIGKILL (Unix).
import { it } from 'vitest';

it('the worker is killed while it runs', () => {
  process.kill(process.pid, 'SIGKILL');
});
