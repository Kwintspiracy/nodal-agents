// job-context.test.ts — le contexte qu'une session CLI reçoit réellement.
//
// Ce fichier existe à cause d'un trou trouvé par une review de la copie
// d'interface, pas par un test : la PR #7 a livré la conscience du dépôt, la #8
// a câblé `buildSystemPrompt` sur le chemin CLI, et NI l'un NI l'autre chemin ne
// passait `workspaceGit`. Le bloc git n'est rendu que si ce champ existe, donc
// l'agent qui en a le plus besoin — celui qui EST une CLI de code — ne l'a
// jamais reçu.
//
// La cause est structurelle : le contexte était construit en DEUX endroits
// (run-job, run-chat), qui ont dérivé. Il n'en existe plus qu'un, et c'est lui
// qu'on épingle ici.

import { describe, it, expect } from 'vitest';
import { buildCliRuntimeJobContext } from '../../cli-runtime/run-job.ts';

const GIT = { root: 'D:/repo', branch: 'main', dirtyCount: 3, head: 'abc1234' };

describe('buildCliRuntimeJobContext', () => {
  it('transmet la sonde git — LE champ oublié', () => {
    const ctx = buildCliRuntimeJobContext({ origin: 'api', workspaceGit: GIT });
    expect(ctx?.workspaceGit, "sans ce champ, aucun bloc git n'est rendu").toEqual(GIT);
  });

  it("omet le champ quand la sonde n'a rien répondu", () => {
    // `null` = pas un dépôt, ou git n'a pas su répondre. Rendre un bloc vide
    // dirait quelque chose de faux sur l'état du dépôt.
    const ctx = buildCliRuntimeJobContext({ origin: 'api', workspaceGit: null });
    expect(ctx && 'workspaceGit' in ctx).toBe(false);
  });

  it('marque toujours la surface cli-runtime', () => {
    // C'est ce drapeau qui retire les blocs décrivant un outillage que cette
    // session n'a pas. L'oublier redonnerait à l'agent 22 Ko d'ordres
    // inexécutables.
    expect(buildCliRuntimeJobContext({ origin: 'api' })?.surface).toBe('cli-runtime');
  });

  it('porte la tâche et le chat quand ils existent, et rien sinon', () => {
    const complet = buildCliRuntimeJobContext({
      origin: 'telegram',
      task: 'analyse le repo',
      chatId: '4242',
    });
    expect(complet?.task).toBe('analyse le repo');
    expect(complet?.telegramChatId).toBe('4242');

    const nu = buildCliRuntimeJobContext({ origin: 'api', task: null, chatId: null });
    expect(nu && 'task' in nu).toBe(false);
    expect(nu && 'telegramChatId' in nu).toBe(false);
  });
});
