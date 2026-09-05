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
   * Ce que le script LANCE VRAIMENT, quand la proposition passe par un script
   * de manifeste (`"test": "next dev"`).
   *
   * Un nom de script ne garantit rien (revue Codex PR #46, passe 8) : un
   * projet peut appeler `next dev` depuis `test`, et la commande ne rendrait
   * jamais la main. Le nom seul est donc une proposition AVEUGLE. L'écran
   * montre cette valeur à côté de la commande, pour que le propriétaire voie
   * ce qu'il approuve. `undefined` pour une commande conventionnelle
   * (`cargo check`), qui ne passe par aucun script.
   */
  readonly runs?: string;
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
        const runs = scripts[name];
        if (typeof runs !== 'string') continue;
        out.push(command(`${pm} run ${name}`, rank, 'package_json_script', runs));
      }
    }
  }

  const deno = parseJson(stripTrailingCommas(stripJsonComments(manifests.denoJson)));
  if (deno) {
    out.push(command('deno check .', 0, 'deno_check'));
    const tasks = deno['tasks'];
    if (isRecord(tasks)) {
      for (const [name, rank] of SCRIPT_RANKS) {
        const runs = tasks[name];
        if (typeof runs !== 'string') continue;
        out.push(command(`deno task ${name}`, rank, 'deno_task', runs));
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
  // `[tool.pytest...]` — une vraie SECTION de configuration. Chercher le mot
  // `pytest` n'importe où l'attrapait dans un commentaire ou une description,
  // et proposait une commande que la machine n'a peut-être pas (revue Codex
  // passe 8) : son « command not found » se lirait comme un rouge de code.
  if (
    manifests.pyprojectToml !== undefined &&
    /^\s*\[tool\.pytest[.\]]/m.test(manifests.pyprojectToml)
  ) {
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

function command(
  text: string,
  rank: number,
  source: DiscoverySource,
  runs?: string,
): DiscoveredCommand {
  const base = { command: text, timeoutSeconds: TIMEOUT_BY_RANK[rank] ?? 300, rank, source };
  return runs === undefined ? base : { ...base, runs };
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

/**
 * Retire les virgules finales, valides en JSONC et refusées par `JSON.parse`.
 *
 * Sans ça, un `deno.jsonc` parfaitement ordinaire — elles y sont usuelles —
 * était silencieusement ignoré et le projet ne proposait rien (revue Codex
 * PR #46, passe 8). Le retrait se fait HORS chaîne, sinon `"a,}"` perdrait sa
 * virgule.
 */
function stripTrailingCommas(text: string | undefined): string | undefined {
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
    if (c === ',') {
      // La virgule ne survit que si un vrai jeton suit, hors espaces.
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j] as string)) j++;
      const next = text[j];
      if (next === '}' || next === ']' || next === undefined) continue;
    }
    out += c;
  }
  return out;
}
