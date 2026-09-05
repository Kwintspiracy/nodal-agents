// verify-command-discovery.ts — les commandes de preuve qu'un projet porte
// DÉJÀ, trouvées dans ses manifestes (plan « Vérifier & Corriger », v7-C).
//
// LE DÉFAUT QUE CECI CORRIGE. L'écran disait « Add a command » devant un champ
// vide. Le propriétaire devait savoir, de tête, ce que son projet lance pour
// se prouver — et le premier utilisateur à l'essayer n'a pas su quoi taper.
// Or le projet le dit lui-même : `package.json` porte ses scripts, `Cargo.toml`
// et `go.mod` désignent leur outil. Il n'y a rien à demander, il y a à lire.
//
// FONCTION PURE, sans aucun import `node:` — ce module est bundlé côté client
// avec le reste de `@nodal-agents/shared`. La lecture du disque est faite par
// l'appelant, qui passe le TEXTE des manifestes. C'est la même discipline que
// `resolveProjectRoots` avec son `hasMarker` injecté, et pour la même raison :
// le runner, le web et un canal de discussion doivent tous obtenir la même
// liste, sans que chacun réimplémente la lecture.
//
// AUCUNE PHRASE ICI (inv. #2). Une proposition porte un CODE de provenance, et
// l'écran choisit ce qu'il en dit.
//
// CE QUE ÇA NE FAIT PAS : approuver. Une commande découverte est une
// PROPOSITION. Elle s'exécute sur la machine du propriétaire avec son compte,
// et un agent qui modifie `package.json` change ce que `pnpm test` lance —
// c'est exactement pourquoi l'approbation reste un geste humain distinct.

import { VERIFY_COMMANDS_MAX } from './types/verification';
import type { VerifyCommand } from './types/verification';

/** Le contenu BRUT des manifestes lus à la racine du projet. */
export interface ProjectManifests {
  /** Texte de `package.json`, si présent. */
  readonly packageJson?: string;
  /** Texte de `deno.json` ou `deno.jsonc`, si présent. */
  readonly denoJson?: string;
  /** Texte de `Cargo.toml`, si présent. */
  readonly cargoToml?: string;
  /** Texte de `pyproject.toml`, si présent. */
  readonly pyprojectToml?: string;
  /** `go.mod` est présent ? Son contenu n'apprend rien de plus. */
  readonly hasGoMod?: boolean;
  /** Les noms de fichiers de verrou présents — ils désignent le gestionnaire. */
  readonly lockfiles?: readonly string[];
}

/** D'où vient une proposition — un code, jamais une phrase (inv. #2). */
export type DiscoverySource =
  | 'package_json_script'
  | 'deno_task'
  | 'deno_check'
  | 'cargo'
  | 'go'
  | 'pytest';

export interface DiscoveredCommand extends VerifyCommand {
  readonly source: DiscoverySource;
  /**
   * Le rang de COÛT, pas d'importance : 0 est le contrôle le moins cher.
   *
   * La séquence de preuve s'arrête au premier rouge (§ « commandes graduées »
   * du plan) : mettre le typage avant les tests fait tomber une erreur de
   * compilation en deux secondes au lieu de huit minutes.
   */
  readonly rank: number;
}

/** Le timeout proposé, par rang de coût — un typage n'a pas besoin de 5 min. */
const TIMEOUT_BY_RANK: Readonly<Record<number, number>> = {
  0: 180,
  1: 180,
  2: 600,
  3: 900,
};

/**
 * Les scripts npm reconnus, et leur rang. La clé est le nom EXACT du script :
 * deviner par sous-chaîne attraperait `test:e2e:ci` (qui lance un navigateur)
 * ou `build:docs`, et une preuve qui démarre un serveur n'est pas une preuve.
 */
const SCRIPT_RANKS: ReadonlyMap<string, number> = new Map([
  ['typecheck', 0],
  ['type-check', 0],
  ['tsc', 0],
  ['check-types', 0],
  ['lint', 1],
  ['test', 2],
  ['test:unit', 2],
  ['unit', 2],
  ['build', 3],
]);

/** `packageManager: "pnpm@9.1.0"` → `pnpm`. Corepack fait foi quand il parle. */
function packageManagerFromField(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.split('@')[0]?.trim();
  return name === 'pnpm' || name === 'yarn' || name === 'npm' || name === 'bun' ? name : null;
}

/** Le gestionnaire déduit des verrous. `npm` en dernier ressort, jamais deviné autrement. */
function packageManagerFromLockfiles(lockfiles: readonly string[]): string {
  const names = new Set(lockfiles.map((f) => f.toLowerCase()));
  if (names.has('pnpm-lock.yaml')) return 'pnpm';
  if (names.has('bun.lockb') || names.has('bun.lock')) return 'bun';
  if (names.has('yarn.lock')) return 'yarn';
  return 'npm';
}

/**
 * Les commandes de preuve qu'un projet propose de lui-même, TRIÉES du moins
 * cher au plus cher, plafonnées au même maximum que la liste approuvable.
 *
 * Rendre une liste VIDE est un résultat, pas une panne : un dossier sans
 * manifeste reconnu n'a rien à proposer, et l'écran le dit plutôt que
 * d'inventer `npm test` sur un projet qui n'a pas de `package.json`.
 *
 * Un manifeste ILLISIBLE (JSON cassé) ne fait pas échouer la découverte : on
 * ne propose simplement rien pour lui. Un `package.json` à moitié écrit par un
 * agent est un cas courant, et refuser toute la liste pour ça priverait le
 * propriétaire des propositions des autres manifestes.
 */
export function discoverVerifyCommands(manifests: ProjectManifests): readonly DiscoveredCommand[] {
  const out: DiscoveredCommand[] = [];

  const pkg = parseJson(manifests.packageJson);
  if (pkg) {
    const scripts = pkg['scripts'];
    if (isRecord(scripts)) {
      const pm =
        packageManagerFromField(pkg['packageManager']) ??
        packageManagerFromLockfiles(manifests.lockfiles ?? []);
      for (const [name, rank] of SCRIPT_RANKS) {
        if (typeof scripts[name] !== 'string') continue;
        out.push(command(`${pm} run ${name}`, rank, 'package_json_script'));
      }
    }
  }

  const deno = parseJson(stripJsonComments(manifests.denoJson));
  if (deno) {
    out.push(command('deno check .', 0, 'deno_check'));
    const tasks = deno['tasks'];
    if (isRecord(tasks)) {
      for (const [name, rank] of SCRIPT_RANKS) {
        if (typeof tasks[name] !== 'string') continue;
        out.push(command(`deno task ${name}`, rank, 'deno_task'));
      }
    }
  }

  if (manifests.cargoToml !== undefined) {
    out.push(command('cargo check', 0, 'cargo'));
    out.push(command('cargo test', 2, 'cargo'));
  }

  if (manifests.hasGoMod === true) {
    out.push(command('go vet ./...', 0, 'go'));
    out.push(command('go test ./...', 2, 'go'));
  }

  // Python n'a pas de convention de script. `pytest` n'est proposé que si le
  // projet le NOMME lui-même : sinon la commande échouerait « command not
  // found », et un rouge d'outillage passerait pour un rouge de code.
  if (manifests.pyprojectToml !== undefined && /pytest/i.test(manifests.pyprojectToml)) {
    out.push(command('pytest', 2, 'pytest'));
  }

  // Tri STABLE par rang : deux propositions de même coût gardent l'ordre de
  // découverte, qui est celui des manifestes puis celui de SCRIPT_RANKS.
  return out
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.rank - b.c.rank || a.i - b.i)
    .map(({ c }) => c)
    .slice(0, VERIFY_COMMANDS_MAX);
}

function command(text: string, rank: number, source: DiscoverySource): DiscoveredCommand {
  return { command: text, timeoutSeconds: TIMEOUT_BY_RANK[rank] ?? 300, rank, source };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (text === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * `deno.jsonc` autorise les commentaires. Retrait des `//` et des `/* *\/` hors
 * chaînes — assez pour un manifeste, et un échec de parsing rend simplement
 * `null` (aucune proposition Deno), jamais une exception.
 */
function stripJsonComments(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}
