// git-binary.test.ts — QUEL FICHIER la résolution retient, et lequel elle
// écarte.
//
// Le PATH du processus est remplacé par un PATH de test, fabriqué dans un
// dossier temporaire : jamais celui de la machine, dont le contenu change d'un
// poste à l'autre et ne prouverait rien de stable.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveGitBinary, _resetGitBinaryCache } from '../git-binary';

let racine = '';
let pathOrigine: string | undefined;

/** Le nom qu'un vrai git porte ici : `git.exe` sous Windows, `git` ailleurs. */
const NOM_BINAIRE = process.platform === 'win32' ? 'git.exe' : 'git';

beforeEach(async () => {
  racine = await mkdtemp(join(tmpdir(), 'nodal-git-binary-'));
  pathOrigine = process.env['PATH'];
});

afterEach(async () => {
  if (pathOrigine === undefined) delete process.env['PATH'];
  else process.env['PATH'] = pathOrigine;
  _resetGitBinaryCache();
  await rm(racine, { recursive: true, force: true });
});

/** Un dossier du PATH de test, avec les fichiers qu'on veut y poser. */
async function dossierDuPath(nom: string, fichiers: readonly string[]): Promise<string> {
  const d = join(racine, nom);
  await mkdir(d, { recursive: true });
  for (const f of fichiers) await writeFile(join(d, f), '');
  return d;
}

describe('resolveGitBinary @cap:travailler-sur-des-fichiers/moteur', () => {
  it('écarte un SHIM BATCH posé devant le vrai binaire', async () => {
    // Revue C de la PR #244, passe 2. `execFile` refuse un script batch sans
    // `shell: true` et rend `EINVAL` (correctif Node d'avril 2024). Retenir un
    // `git.cmd` l'aurait donc fait résoudre ici puis refuser au lancement, et
    // tout ce qui dépend de git serait tombé en silence sur son repli.
    const avecShim = await dossierDuPath('devant', ['git.cmd', 'git.bat']);
    const avecVrai = await dossierDuPath('derriere', [NOM_BINAIRE]);
    process.env['PATH'] = [avecShim, avecVrai].join(delimiter);
    _resetGitBinaryCache();

    const binaire = await resolveGitBinary();

    expect(binaire).toBe(`${avecVrai.replace(/\\/g, '/')}/${NOM_BINAIRE}`);
  });

  it('prend le PREMIER dossier du PATH qui porte le binaire', async () => {
    const premier = await dossierDuPath('un', [NOM_BINAIRE]);
    const second = await dossierDuPath('deux', [NOM_BINAIRE]);
    process.env['PATH'] = [premier, second].join(delimiter);
    _resetGitBinaryCache();

    expect(await resolveGitBinary()).toBe(`${premier.replace(/\\/g, '/')}/${NOM_BINAIRE}`);
  });

  it('sans git sur le PATH, rend null — l’appelant décline et le dit', async () => {
    process.env['PATH'] = await dossierDuPath('vide', []);
    _resetGitBinaryCache();

    expect(await resolveGitBinary()).toBeNull();
  });

  it('un DOSSIER nommé git n’est pas un binaire', async () => {
    // `stat().isFile()` et pas `existsSync` : un dossier `git.exe` existe sans
    // être lançable, et le retenir ferait échouer chaque appel ensuite.
    const d = join(racine, 'piege');
    await mkdir(join(d, NOM_BINAIRE), { recursive: true });
    process.env['PATH'] = d;
    _resetGitBinaryCache();

    expect(await resolveGitBinary()).toBeNull();
  });
});
