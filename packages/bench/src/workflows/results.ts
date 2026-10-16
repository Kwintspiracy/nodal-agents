// workflows/results.ts — ce que les essais enregistrés disent, calculé UNE fois.
//
// Le portail (apps/qa, page Workflows) et Bench Studio lisent les mêmes lignes
// (apps/qa/data/workflows.ndjson) et doivent dire la même chose : séries par
// version, matrice activités × modèles, résumé par modèle. Ces calculs vivent
// ici, et nulle part ailleurs (règle 11). Le portail est du JavaScript lancé
// par Node : ce module n'importe rien et n'emploie que des types effaçables,
// pour que Node puisse le charger tel quel (suppression des types).

/** Au-delà de ce rapport entre deux versions, un drapeau « plus lent » se lève. */
export const SEUIL_RALENTI = 1.5;
/** Combien d'essais récents une cellule, une carte ou un résumé regardent. */
export const DERNIERS = 5;

/** Une ligne de workflows.ndjson, telle que le fichier la rend (anciennes lignes comprises). */
export interface ResultLine {
  readonly scenario: string;
  readonly verdict: string;
  readonly scenarioVersion?: number;
  readonly startedAt?: string;
  readonly nodalVersion?: string;
  readonly title?: string;
  readonly green?: string;
  readonly set?: string;
  readonly activity?: string;
  readonly needs?: string[];
  readonly durationMs?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costUsd?: number | null;
  readonly modelUnderTest?: string | null;
  readonly rootModel?: string | null;
  readonly [field: string]: unknown;
}

/** Ce que les calculs lisent du catalogue (apps/qa/data/workflow-catalog.json). */
export interface CatalogLike {
  readonly activities: readonly string[];
  readonly scenarios: ReadonlyArray<{
    readonly id: string;
    readonly activity: string;
    readonly title: string;
    readonly version?: number;
    readonly green?: string;
    readonly needs?: readonly string[];
    readonly set?: string;
  }>;
}

/**
 * Lit le fichier ndjson. Une ligne illisible n'est pas ignorée en silence :
 * elle est comptée, et qui affiche le dit.
 */
export function lireWorkflows(texte: string | null | undefined): {
  lignes: ResultLine[];
  illisibles: number;
} {
  const lignes: ResultLine[] = [];
  let illisibles = 0;
  for (const brute of String(texte ?? '').split('\n')) {
    if (!brute.trim()) continue;
    try {
      const l = JSON.parse(brute) as Partial<ResultLine> | null;
      if (l && typeof l.scenario === 'string' && typeof l.verdict === 'string')
        lignes.push(l as ResultLine);
      else illisibles++;
    } catch {
      illisibles++;
    }
  }
  return { lignes, illisibles };
}

/**
 * Lit le catalogue écrit par `pnpm bench:workflows --catalog`. Un catalogue mal
 * formé est une erreur dite : une matrice rangée sur un catalogue faux
 * mentirait sur ce qui n'a jamais été joué.
 */
export function lireCatalogue<C extends CatalogLike = CatalogLike>(texte: string): C {
  let c: unknown;
  try {
    c = JSON.parse(texte);
  } catch (e) {
    throw new Error(
      `data/workflow-catalog.json is not JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const o = c as { activities?: unknown; scenarios?: unknown } | null;
  const ok =
    o !== null &&
    typeof o === 'object' &&
    Array.isArray(o.activities) &&
    Array.isArray(o.scenarios) &&
    (o.scenarios as unknown[]).every((s) => {
      const x = s as { id?: unknown; activity?: unknown; title?: unknown } | null;
      return (
        x !== null &&
        typeof x.id === 'string' &&
        typeof x.activity === 'string' &&
        typeof x.title === 'string'
      );
    });
  if (!ok) throw new Error('data/workflow-catalog.json does not have the shape the bench writes');
  return c as C;
}

/** Compare deux versions « 0.9.10 » > « 0.9.4 », partie par partie. */
export function comparerVersions(a: string, b: string): number {
  const parts = (v: string): Array<number | string> =>
    String(v)
      .split(/[.-]/)
      .map((x) => (/^\d+$/.test(x) ? Number(x) : x));
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

export function mediane(nombres: ReadonlyArray<unknown>): number | null {
  const v = nombres
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

const jetons = (l: ResultLine): number | null =>
  typeof l.inputTokens === 'number' && typeof l.outputTokens === 'number'
    ? l.inputTokens + l.outputTokens
    : null;

const parDate = (a: ResultLine, b: ResultLine): number =>
  String(a.startedAt).localeCompare(String(b.startedAt));

export interface ParVersion {
  version: string;
  essais: number;
  sautes: number;
  verts: number;
  rouges: number;
  dureeMs: number | null;
  jetons: number | null;
  coutUsd: number | null;
}

export interface Ralenti {
  de: string;
  a: string;
  motifs: Array<{ quoi: 'time' | 'tokens'; rapport: number; avant: number; apres: number }>;
}

/**
 * Le résumé d'une série (un scénario à une version donnée) : les derniers
 * verdicts, les médianes par version de Nodal, et le drapeau de ralentissement.
 *
 * Les médianes ne comptent que les essais VERTS : un essai rouge peut avoir été
 * coupé au bout de dix secondes (une approbation), et le compter ferait passer
 * une panne pour une accélération.
 */
export function resumerSerie(lignes: readonly ResultLine[]) {
  const tri = [...lignes].sort(parDate);
  const derniere = tri[tri.length - 1]!;
  const versions = [...new Set(tri.map((l) => l.nodalVersion ?? 'unknown'))].sort(comparerVersions);
  const parVersion: ParVersion[] = versions.map((v) => {
    const de = tri.filter((l) => (l.nodalVersion ?? 'unknown') === v);
    const verts = de.filter((l) => l.verdict === 'green');
    return {
      version: v,
      // Un essai sauté n'a rien tenté : hors du dénominateur, dit à part (`sautes`).
      essais: de.filter((l) => l.verdict !== 'skipped').length,
      sautes: de.filter((l) => l.verdict === 'skipped').length,
      verts: verts.length,
      rouges: de.filter((l) => l.verdict === 'red').length,
      dureeMs: mediane(verts.map((l) => l.durationMs)),
      jetons: mediane(verts.map(jetons)),
      coutUsd: mediane(verts.map((l) => l.costUsd)),
    };
  });

  // Le drapeau : les DERNIERS essais verts de la version courante contre la
  // version précédente qui a au moins un vert.
  let ralenti: Ralenti | null = null;
  const courante = parVersion[parVersion.length - 1];
  const avant = [...parVersion.slice(0, -1)].reverse().find((p) => p.verts > 0);
  if (courante && avant) {
    const recents = tri
      .filter((l) => (l.nodalVersion ?? 'unknown') === courante.version && l.verdict === 'green')
      .slice(-DERNIERS);
    const d = mediane(recents.map((l) => l.durationMs));
    const t = mediane(recents.map(jetons));
    const motifs: Ralenti['motifs'] = [];
    if (d !== null && avant.dureeMs && d > SEUIL_RALENTI * avant.dureeMs) {
      motifs.push({ quoi: 'time', rapport: d / avant.dureeMs, avant: avant.dureeMs, apres: d });
    }
    if (t !== null && avant.jetons && t > SEUIL_RALENTI * avant.jetons) {
      motifs.push({ quoi: 'tokens', rapport: t / avant.jetons, avant: avant.jetons, apres: t });
    }
    if (motifs.length > 0) ralenti = { de: avant.version, a: courante.version, motifs };
  }

  return {
    scenario: derniere.scenario,
    version: derniere.scenarioVersion ?? null,
    titre: derniere.title ?? derniere.scenario,
    vert: derniere.green ?? null,
    jeu: derniere.set ?? null,
    derniers: tri.slice(-DERNIERS),
    parVersion,
    ralenti,
  };
}

/**
 * Toutes les séries, dans l'ordre d'apparition des scénarios. Une nouvelle
 * version d'un scénario ouvre une nouvelle série ; seule la plus récente est
 * détaillée, les anciennes sont dites (leur nombre d'essais).
 */
export function resumerWorkflows(lignes: readonly ResultLine[]) {
  const ordre: string[] = [];
  const parScenario = new Map<string, ResultLine[]>();
  for (const l of lignes) {
    if (!parScenario.has(l.scenario)) {
      parScenario.set(l.scenario, []);
      ordre.push(l.scenario);
    }
    parScenario.get(l.scenario)!.push(l);
  }
  return ordre.map((id) => {
    const toutes = parScenario.get(id)!;
    const versions = [...new Set(toutes.map((l) => l.scenarioVersion ?? 0))].sort((a, b) => a - b);
    const actuelle = versions[versions.length - 1];
    const serie = resumerSerie(toutes.filter((l) => (l.scenarioVersion ?? 0) === actuelle));
    const anciennes = versions.slice(0, -1).map((v) => ({
      version: v,
      essais: toutes.filter((l) => (l.scenarioVersion ?? 0) === v).length,
    }));
    return { ...serie, anciennes };
  });
}

/** Un dernier essai à regarder : rouge, ou une erreur du banc. Un essai SAUTÉ n'a rien essayé. */
export const aRegarder = (verdict: string | undefined): boolean =>
  verdict === 'red' || verdict === 'error';

/**
 * Les workflows à regarder (rouges ou en erreur au dernier essai, ou ralentis).
 * Un dernier essai sauté (un besoin absent, la stack occupée) n'y entre pas :
 * il est gris, jamais rouge.
 */
export function workflowsARegarder({ lignes }: { lignes: readonly ResultLine[] }): number {
  return resumerWorkflows(lignes).filter(
    (x) => aRegarder(x.derniers[x.derniers.length - 1]?.verdict) || x.ralenti !== null,
  ).length;
}

// ─── La matrice : activités × modèles ────────────────────────────────────────

/** La colonne des essais dont on ne sait pas sur quel modèle ils étaient RÉGLÉS. */
export const AVANT_LA_MATRICE = 'before the matrix';

/**
 * La colonne d'un essai : le modèle sur lequel il était RÉGLÉ, jamais
 * l'ensemble des modèles qui ont répondu (un secours, un délégué sur un autre
 * modèle mêleraient les colonnes). C'est le modèle que la matrice a imposé,
 * sinon le modèle configuré de l'agent racine. Une ligne écrite avant le banc
 * v2 ne porte ni l'un ni l'autre : `models` dit qui a RÉPONDU, pas ce qui était
 * demandé. Elle va dans une seule colonne, « before the matrix ».
 */
export function colonneDe(l: Partial<ResultLine>): string {
  if (typeof l.modelUnderTest === 'string' && l.modelUnderTest) return l.modelUnderTest;
  if (typeof l.rootModel === 'string' && l.rootModel) return l.rootModel;
  return AVANT_LA_MATRICE;
}

export interface Cellule {
  derniers: ResultLine[];
  essais: number;
  sautes: number;
  verts: number;
  dureeMs: number | null;
  coutUsd: number | null;
}

/**
 * Ce qu'une cellule (un scénario, un modèle) montre : ses derniers essais, et
 * ce qu'elle compte porte sur CES essais-là, comme le résumé de colonne. Un
 * essai sauté n'a rien tenté : hors du dénominateur, dit à part (`sautes`).
 */
function resumerCellule(lignes: readonly ResultLine[]): Cellule {
  const derniers = [...lignes].sort(parDate).slice(-DERNIERS);
  const verts = derniers.filter((l) => l.verdict === 'green');
  return {
    derniers,
    essais: derniers.filter((l) => l.verdict !== 'skipped').length,
    sautes: derniers.filter((l) => l.verdict === 'skipped').length,
    verts: verts.length,
    dureeMs: mediane(verts.map((l) => l.durationMs)),
    coutUsd: mediane(verts.map((l) => l.costUsd)),
  };
}

export interface ResumeColonne {
  tentes: number;
  sautes: number;
  verts: number;
  dureeMs: number | null;
  coutMedianUsd: number | null;
  coutTotalUsd: number;
  coutInconnu: number;
}

/**
 * Le résumé d'une colonne, sur les essais MONTRÉS (les cinq derniers de chaque
 * scénario dans cette colonne) : la part de verts parmi les essais tentés (un
 * essai sauté n'a rien tenté : ni au numérateur ni au dénominateur), les
 * médianes de temps et de coût des verts, et le coût total des essais tentés.
 * Un coût que des essais n'ont pas rapporté est DIT (`coutInconnu`), jamais
 * compté zéro.
 */
export function resumerColonne(essais: readonly ResultLine[]): ResumeColonne {
  const tentes = essais.filter((l) => l.verdict !== 'skipped');
  const verts = tentes.filter((l) => l.verdict === 'green');
  const couts = tentes.map((l) => l.costUsd);
  return {
    tentes: tentes.length,
    sautes: essais.length - tentes.length,
    verts: verts.length,
    dureeMs: mediane(verts.map((l) => l.durationMs)),
    coutMedianUsd: mediane(verts.map((l) => l.costUsd)),
    coutTotalUsd: couts
      .filter((c): c is number => typeof c === 'number')
      .reduce((a, b) => a + b, 0),
    coutInconnu: couts.filter((c) => typeof c !== 'number').length,
  };
}

export interface ScenarioDeMatrice {
  id: string;
  version: number | null;
  activite: string;
  titre: string;
  vert: string | null;
  besoins: readonly string[];
  jeu: string | null;
  anciens: number;
  cellules: Map<string, Cellule>;
}

export interface Matrice {
  colonnes: string[];
  resumes: Map<string, ResumeColonne>;
  periode: { de: string; a: string } | null;
  activites: Array<{ activite: string; scenarios: ScenarioDeMatrice[] }>;
}

/**
 * La matrice. Les lignes sont les activités (dans l'ordre du catalogue), puis
 * leurs scénarios ; les colonnes, les modèles. Seule la série COURANTE d'un
 * scénario (sa dernière version) remplit les cellules.
 *
 * `catalogue` apporte l'ordre des activités, les scénarios jamais joués et
 * l'activité des lignes écrites avant la v2. Sans lui, la matrice ne montre
 * que ce qui a été joué.
 */
export function construireMatrice(
  lignes: readonly ResultLine[],
  catalogue: CatalogLike | null = null,
): Matrice {
  const parScenario = new Map<string, ResultLine[]>();
  for (const l of lignes) {
    if (!parScenario.has(l.scenario)) parScenario.set(l.scenario, []);
    parScenario.get(l.scenario)!.push(l);
  }
  const duCatalogue = new Map((catalogue?.scenarios ?? []).map((s) => [s.id, s]));
  const ids = [
    ...(catalogue?.scenarios ?? []).map((s) => s.id),
    ...[...parScenario.keys()].filter((id) => !duCatalogue.has(id)),
  ];

  // Les colonnes : les modèles réglés, les plus joués d'abord ; « before the matrix » en dernier.
  const compte = new Map<string, number>();
  for (const l of lignes) {
    const c = colonneDe(l);
    compte.set(c, (compte.get(c) ?? 0) + 1);
  }
  const avantEnDernier = (c: string): number => (c === AVANT_LA_MATRICE ? 1 : 0);
  const colonnes = [...compte.entries()]
    .sort((a, b) => avantEnDernier(a[0]) - avantEnDernier(b[0]) || b[1] - a[1])
    .map(([c]) => c);

  const scenarios: ScenarioDeMatrice[] = ids.map((id) => {
    const cat = duCatalogue.get(id) ?? null;
    const toutes = parScenario.get(id) ?? [];
    const versions = [...new Set(toutes.map((l) => l.scenarioVersion ?? 0))];
    const version = cat?.version ?? (versions.length > 0 ? Math.max(...versions) : null);
    const serie = toutes.filter((l) => (l.scenarioVersion ?? 0) === version);
    const derniere = [...serie].sort(parDate).pop();
    const parColonne = new Map<string, ResultLine[]>();
    for (const l of serie) {
      const c = colonneDe(l);
      if (!parColonne.has(c)) parColonne.set(c, []);
      parColonne.get(c)!.push(l);
    }
    return {
      id,
      version,
      activite:
        cat?.activity ??
        derniere?.activity ??
        toutes[toutes.length - 1]?.activity ??
        'unclassified',
      titre: cat?.title ?? derniere?.title ?? id,
      vert: cat?.green ?? derniere?.green ?? null,
      besoins: cat?.needs ?? derniere?.needs ?? [],
      jeu: cat?.set ?? derniere?.set ?? null,
      anciens: toutes.length - serie.length,
      cellules: new Map([...parColonne.entries()].map(([c, ls]) => [c, resumerCellule(ls)])),
    };
  });

  const ordre = [
    ...(catalogue?.activities ?? []),
    ...[...new Set(scenarios.map((s) => s.activite))].filter(
      (a) => !(catalogue?.activities ?? []).includes(a),
    ),
  ];
  // Le résumé de chaque colonne : ce que Quentin compare d'un modèle à l'autre.
  const montres = (col: string): ResultLine[] =>
    scenarios.flatMap((s) => s.cellules.get(col)?.derniers ?? []);
  const resumes = new Map(colonnes.map((c) => [c, resumerColonne(montres(c))]));
  const dates = colonnes
    .flatMap(montres)
    .map((l) => String(l.startedAt ?? '').slice(0, 10))
    .filter(Boolean)
    .sort();
  return {
    colonnes,
    resumes,
    periode: dates.length > 0 ? { de: dates[0]!, a: dates[dates.length - 1]! } : null,
    activites: ordre.map((a) => ({
      activite: a,
      scenarios: scenarios.filter((s) => s.activite === a),
    })),
  };
}

// ─── Mise en forme ───────────────────────────────────────────────────────────

export function duree(ms: unknown): string {
  if (typeof ms !== 'number') return 'not measured';
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  const min = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s === 0 ? `${min} min` : `${min} min ${s} s`;
}

export function nombreJetons(n: unknown): string {
  if (typeof n !== 'number') return 'not measured';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}
