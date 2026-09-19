// verification/git-binary.ts — QUEL `git` EST LANCÉ, décidé UNE FOIS, au même
// endroit pour tout le monde.
//
// ═══ UN DURCISSEMENT, PAS UN TROU REFERMÉ ═══
//
// Revue C de la PR #227, constat 3. La crainte : `execFile('git', …, { cwd:
// <le dossier du projet> })` laisse le système chercher le programme, et la
// recherche de `CreateProcess` a longtemps regardé le RÉPERTOIRE COURANT avant
// le PATH. Un `git.exe` déposé dans le dossier d'un projet — par une
// dépendance, par un dépôt cloné, par l'agent lui-même — aurait alors tourné à
// la place du git du système, et sa sortie fabriquée aurait alimenté la liste
// des fichiers livrés.
//
// CE N'EST PAS CE QUI SE PASSE SUR CE RUNTIME, et le dire autrement serait se
// vanter d'une réparation qu'on n'a pas faite. Mesuré : un vrai `git.exe` posé
// dans le dossier du projet, la résolution remise au nom nu, et le cas reste
// VERT sous Windows avec Node 26.4.0 — libuv ne cherche plus le répertoire
// courant pour le programme (CVE-2024-24806), et ce Node porte le correctif.
//
// Le mécanisme est gardé quand même : il ne coûte rien, il retire une
// recherche de programme par appel, et il tient sur un runtime — plus ancien,
// ou un autre — qui chercherait encore.
//
// ═══ POURQUOI CE FICHIER EXISTE À PART ═══
//
// Revue C de la PR #244, constat bloquant. `apps/web` pose git dans le dossier
// d'un projet quand le propriétaire le demande (issue #200) : c'est le MÊME
// `git`, lancé avec le MÊME `cwd`, donc la même question. Recopier la
// résolution aurait fait deux règles qui divergent au premier correctif porté
// d'un seul côté.
//
// Le module est donc servi par un chemin d'export à lui
// (`@nodal-agents/tools/git-binary`) plutôt que par l'index du paquet : il ne
// dépend que de `node:fs` et de `node:path`, et un écran n'a pas à tirer le
// registre des outils pour savoir où est git.

import { stat } from 'node:fs/promises';
import { delimiter as PATH_DELIMITER } from 'node:path';

/** Les extensions exécutables à essayer sous Windows, dans l'ordre. */
const EXTENSIONS_WINDOWS = ['.exe', '.cmd', '.bat', '.com'];

/** Un chemin en barres obliques, la forme que tout le dépôt manipule. */
function enBarresObliques(chemin: string): string {
  return chemin.replace(/\\/g, '/');
}

async function estFichier(chemin: string): Promise<boolean> {
  try {
    return (await stat(chemin)).isFile();
  } catch {
    return false;
  }
}

let gitBinaire: Promise<string | null> | null = null;

/**
 * Le chemin ABSOLU du `git` du système, cherché dans le PATH du processus et
 * dans lui seul.
 *
 * AUCUN SOUS-PROCESSUS N'EST LANCÉ pour le trouver : un `where git` ou un
 * `which git` reposerait la recherche exactement là où serait le trou. On lit
 * le PATH et on regarde les fichiers, c'est tout.
 *
 * Le résultat est mémoïsé : la question est posée à chaque appel qui touche
 * git, et sa réponse ne change pas pendant la vie du processus.
 *
 * `null` quand il n'y a pas de git sur le PATH. L'appelant décline alors ce
 * qu'il allait faire et le DIT — il ne retombe pas sur le nom nu.
 */
export async function resolveGitBinary(): Promise<string | null> {
  gitBinaire ??= (async () => {
    const chemins = (process.env['PATH'] ?? '').split(PATH_DELIMITER).filter((d) => d !== '');
    const windows = process.platform === 'win32';
    for (const dossier of chemins) {
      const base = `${enBarresObliques(dossier)}/git`;
      // Sous Windows, `git` nu n'est pas exécutable : ce sont les extensions
      // de PATHEXT qui le rendent lançable, et c'est `git.exe` qu'on veut.
      for (const ext of windows ? EXTENSIONS_WINDOWS : ['']) {
        if (await estFichier(base + ext)) return base + ext;
      }
    }
    console.warn('[git] GIT_NOT_ON_PATH');
    return null;
  })();
  return gitBinaire;
}

/** Pour les tests : oublier le binaire mémoïsé. */
export function _resetGitBinaryCache(): void {
  gitBinaire = null;
}
