// project-git-sandboxed.test.ts — le `git init` du web ne peut rien écrire hors
// du projet, même par un `.git` planté au dernier moment (#628, revue passe 6,
// P1).
//
// La course que la revue a nommée : `initGitRepository` regarde si `.git`
// existe, PUIS lance `git init`. Une commande confinée qui pose `.git` entre les
// deux, en jonction vers un dossier de l'hôte, y faisait écrire le squelette du
// dépôt par le serveur web. La course est jouée ici sans hasard : les
// programmes posent la jonction juste avant de lancer git.
//
// Le TÉMOIN (même jonction, git sur l'hôte) prouve que le piège est armé : le
// squelette arrive bien dans le dossier visé. Par les programmes de Nodal (le
// bac à sable), rien n'y arrive, et `git init` échoue — dit.
//
// Windows, là où le bac à sable des programmes de Nodal est disponible (MXC,
// palier base-container) : sur la machine du propriétaire, et dans le job CI
// `sandbox-windows`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  hostPrograms,
  nodalProgramsSandbox,
  withNodalPrograms,
  type ProgramRunner,
} from '@nodal-agents/sandbox';
import { initGitRepository } from '../project-git.ts';

const available =
  process.platform === 'win32' && (await nodalProgramsSandbox().status()).state === 'available';

let racine = '';
let projet = '';
let hote = '';

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-project-git-mxc-'));
  projet = join(racine, 'projet');
  hote = join(racine, 'dossier-de-l-hote');
  await mkdir(projet, { recursive: true });
  await mkdir(hote, { recursive: true });
});

afterEach(async () => {
  await rm(racine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Les programmes donnés, qui posent la jonction `.git` → `hote` juste avant git. */
function plantingFirst(programs: ProgramRunner): ProgramRunner {
  return {
    async execFile(file, args, opts) {
      await symlink(hote, join(projet, '.git'), 'junction');
      return programs.execFile(file, args, opts);
    },
    spawn: (file, args, opts) => programs.spawn(file, args, opts),
  };
}

describe.runIf(available)(
  'the web’s git init cannot write outside the project, even through a .git planted at the last moment @cap:travailler-sur-des-fichiers/moteur (Windows, MXC available)',
  () => {
    it('témoin : sur l’hôte, la jonction plantée fait écrire le squelette du dépôt hors du projet', async () => {
      const out = await initGitRepository(projet, plantingFirst(hostPrograms));
      expect(out.kind).toBe('initialised');
      expect(await readdir(hote)).toContain('HEAD');
    });

    it('par les programmes de Nodal : rien n’arrive hors du projet, et l’échec est rendu', async () => {
      const out = await withNodalPrograms((programs) =>
        initGitRepository(projet, plantingFirst(programs)),
      );
      expect(await readdir(hote), 'git init wrote outside the project').toEqual([]);
      expect(out.kind).toBe('failed');
    });
  },
);
