// workspaces.ts — LA FUSION : le registre des projets et les dossiers où un
// agent a écrit, dans UNE liste (#143).
//
// Deux pages listaient des projets avec un dossier et une preuve : `/spaces`
// les projets DÉCLARÉS, `/code` les dossiers DÉRIVÉS des sessions de code. La
// différence était l'origine, et elle n'intéresse personne au moment de
// chercher son projet. Cette fusion garde les deux origines comme un ATTRIBUT
// de la ligne (`kind`), plus jamais comme deux écrans.
//
// Ce module est PUR. Il ne lit ni la base ni le disque : il reçoit le registre,
// les sessions de code et les préférences du propriétaire, et rend la liste
// telle qu'elle s'affiche. C'est ce qui permet de prouver la fusion elle-même —
// qu'un dossier détecté DÉJÀ au registre ne fasse pas deux lignes — sans
// monter une base.
//
// La DÉTECTION SURVIT, et c'est l'essentiel : un dossier où un agent a écrit
// sans être déclaré reste une ligne, marquée « Detected », avec les deux gestes
// de l'onglet Code (Register, Hide). Rien n'est perdu en la retirant du menu.

import { projectKey } from '@nodal-agents/shared';
import type { VerifyStatus } from './verification-display.ts';
import type { ProjectListRow } from './project-actions.ts';

/**
 * L'état de la preuve d'une ligne, tel que la pastille le dit.
 *
 * QUATRE états, pas trois : la planche en dessine trois (Verified, Unverified,
 * Approval pending) parce que ses trois lignes d'exemple n'en montrent pas
 * plus, mais une séquence de preuve qui a TOURNÉ ET ÉCHOUÉ n'est pas la même
 * chose qu'une preuve qui n'a jamais tourné. Les fondre en « Unverified »
 * effacerait un rouge sous un mot neutre (invariant #4).
 */
export type WorkspaceProof = 'verified' | 'failed' | 'approval_pending' | 'unverified';

/** Une ligne de la liste, registre et détection confondus. */
export type WorkspaceRow = {
  /** `registered` = au registre ; `detected` = un dossier où un agent a écrit. */
  kind: 'registered' | 'detected';
  /** L'id du projet au registre. `null` pour un détecté : il n'a pas de ligne. */
  id: string | null;
  /** `projectKey(path)` — l'identité, jamais l'égalité de texte sur le chemin. */
  key: string;
  name: string;
  path: string;
  /**
   * Ce que le projet produit. `null` pour un détecté : rien ne le dit encore,
   * et supposer « code » ferait afficher une étiquette que personne n'a posée.
   */
  produces: 'code' | 'documents' | null;
  agentName: string | null;
  agentAvatarUrl: string | null;
  /**
   * Les conversations du projet. `null` pour un détecté — un dossier hors
   * registre n'en porte aucune, et écrire « 0 conversations » laisserait
   * croire qu'on a compté.
   */
  conversations: number | null;
  /** Les sessions de code retombées sur ce dossier, dans la fenêtre du scan. */
  sessions: number;
  lastActivityAt: Date | null;
  proof: WorkspaceProof;
  /** Masqué par le propriétaire (`code_projects.hidden`). */
  hidden: boolean;
};

export type WorkspacesView = {
  /** Ce qui s'affiche, de la dernière activité à la plus ancienne. */
  rows: WorkspaceRow[];
  /** Les dossiers détectés que le propriétaire a masqués — derrière « Show ». */
  hiddenDetected: WorkspaceRow[];
  counts: {
    total: number;
    registered: number;
    detected: number;
    /** Les lignes dont la séquence de preuve attend une approbation. */
    waiting: number;
  };
};

/** Une session de code, réduite à ce que la fusion en lit. */
export type WorkspaceSession = {
  projectPath: string | null;
  projectName: string | null;
  agentName: string | null;
  activityAt: string | null;
};

/** Les deux gestes du propriétaire et l'état de configuration de la preuve. */
export type WorkspacePrefs = {
  projectPath: string;
  displayName: string | null;
  hidden: boolean;
  verifyStatus: VerifyStatus;
};

/** Le dernier verdict d'une séquence de preuve, par clé d'identité. */
export type WorkspaceProofRun = { verdict: 'pass' | 'fail'; at: Date };

/**
 * La pastille d'une ligne, dérivée de DEUX faits distincts : la configuration
 * (approuvée, en attente, absente) et le dernier verdict.
 *
 * L'attente d'approbation passe AVANT le verdict : tant que le propriétaire
 * n'a pas re-validé le manifeste, la séquence ne s'exécute pas, et le dernier
 * vert qu'elle a produit décrit une autre révision que celle d'aujourd'hui.
 */
export function workspaceProof(
  status: VerifyStatus | null,
  lastRun: WorkspaceProofRun | null,
): WorkspaceProof {
  if (status === 'pending_approval') return 'approval_pending';
  if (lastRun?.verdict === 'pass') return 'verified';
  if (lastRun?.verdict === 'fail') return 'failed';
  return 'unverified';
}

/** Le nom du dossier, quand personne n'en a choisi un autre. */
function basenameOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** La plus récente des deux dates, `null` seulement si les deux le sont. */
function laterOf(a: Date | null, b: Date | null): Date | null {
  if (a === null) return b;
  if (b === null) return a;
  return a.getTime() >= b.getTime() ? a : b;
}

type Grouped = {
  path: string;
  name: string | null;
  agentName: string | null;
  sessions: number;
  lastActivityAt: Date | null;
};

/**
 * Les sessions de code, groupées par IDENTITÉ de dossier.
 *
 * Par `projectKey`, jamais par chemin brut : sous Windows, deux sessions du
 * même dossier remontent avec des casses différentes, et grouper sur le texte
 * en ferait deux projets — le désaccord que l'onglet Code corrigeait déjà.
 *
 * `sessions` est attendu de la plus récente à la plus ancienne (l'ordre de
 * `listCodingProcessesAction`) : l'agent retenu est donc celui de la DERNIÈRE
 * session, celui que la ligne nomme.
 */
export function groupSessionsByProject(
  sessions: readonly WorkspaceSession[],
): Map<string, Grouped> {
  const byKey = new Map<string, Grouped>();
  for (const s of sessions) {
    if (s.projectPath === null || s.projectPath === '') continue;
    const key = projectKey(s.projectPath);
    const at = s.activityAt ? new Date(s.activityAt) : null;
    const existing = byKey.get(key);
    if (existing) {
      existing.sessions += 1;
      existing.lastActivityAt = laterOf(existing.lastActivityAt, at);
      existing.agentName ??= s.agentName;
      continue;
    }
    byKey.set(key, {
      path: s.projectPath,
      name: s.projectName,
      agentName: s.agentName,
      sessions: 1,
      lastActivityAt: at,
    });
  }
  return byKey;
}

/**
 * Le registre et la détection, en UNE liste.
 *
 * LA RÈGLE DE FUSION : un dossier détecté dont la clé est DÉJÀ au registre
 * n'est pas une seconde ligne — ses sessions et sa dernière activité
 * enrichissent la ligne du projet. Sans cette règle, tout projet déclaré
 * apparaîtrait deux fois dès qu'un agent y écrit, ce qui est le cas normal.
 *
 * Les MASQUÉS : un dossier détecté masqué sort de la liste et se compte à part
 * (« N hidden folder · Show »). Un projet du REGISTRE masqué reste listé avec
 * son étiquette — c'est le comportement de `/spaces` depuis P8, et l'écran du
 * registre est justement celui où l'on doit retrouver ce qu'on a rangé.
 */
export function mergeWorkspaces(input: {
  projects: readonly ProjectListRow[];
  sessions: readonly WorkspaceSession[];
  prefs: readonly WorkspacePrefs[];
  /** Le dernier verdict par clé, pour les dossiers détectés comme pour le registre. */
  proofRuns?: ReadonlyMap<string, WorkspaceProofRun>;
}): WorkspacesView {
  const grouped = groupSessionsByProject(input.sessions);
  const prefsByKey = new Map(input.prefs.map((p) => [projectKey(p.projectPath), p]));
  const proofRuns = input.proofRuns ?? new Map<string, WorkspaceProofRun>();

  const registered: WorkspaceRow[] = input.projects.map((p) => {
    const key = projectKey(p.path);
    const g = grouped.get(key);
    return {
      kind: 'registered' as const,
      id: p.id,
      key,
      name: p.name,
      path: p.path,
      produces: p.kind,
      agentName: p.agentName ?? g?.agentName ?? null,
      agentAvatarUrl: p.agentAvatarUrl,
      conversations: p.conversationsCount,
      sessions: g?.sessions ?? 0,
      lastActivityAt: laterOf(p.lastActivityAt, g?.lastActivityAt ?? null),
      // Un projet de DOCUMENTS n'a rien à prouver : il n'exécute aucune
      // commande, et lui coller « Unverified » lui reprocherait une preuve
      // qui n'existe pas pour lui. `listProjectsAction` rend déjà `lastProof`
      // à `null` dans ce cas ; on garde la même retenue sur la pastille.
      proof: workspaceProof(prefsByKey.get(key)?.verifyStatus ?? null, p.lastProof),
      hidden: p.hidden,
    };
  });

  const registeredKeys = new Set(registered.map((r) => r.key));

  const detected: WorkspaceRow[] = [];
  for (const [key, g] of grouped) {
    if (registeredKeys.has(key)) continue;
    const prefs = prefsByKey.get(key);
    detected.push({
      kind: 'detected',
      id: null,
      key,
      name: prefs?.displayName?.trim() || g.name || basenameOf(g.path),
      path: g.path,
      produces: null,
      agentName: g.agentName,
      agentAvatarUrl: null,
      conversations: null,
      sessions: g.sessions,
      lastActivityAt: g.lastActivityAt,
      proof: workspaceProof(prefs?.verifyStatus ?? null, proofRuns.get(key) ?? null),
      hidden: prefs?.hidden ?? false,
    });
  }

  const byActivity = (a: WorkspaceRow, b: WorkspaceRow): number => {
    const at = a.lastActivityAt?.getTime() ?? 0;
    const bt = b.lastActivityAt?.getTime() ?? 0;
    if (at !== bt) return bt - at;
    // À activité égale, l'ordre est celui du NOM : sans départage, deux lignes
    // sans activité s'échangeaient d'un rendu à l'autre.
    return a.name.localeCompare(b.name);
  };

  const visible = [...registered, ...detected.filter((d) => !d.hidden)].sort(byActivity);
  const hiddenDetected = detected.filter((d) => d.hidden).sort(byActivity);

  return {
    rows: visible,
    hiddenDetected,
    counts: {
      total: visible.length,
      registered: registered.length,
      detected: visible.filter((r) => r.kind === 'detected').length,
      waiting: visible.filter((r) => r.proof === 'approval_pending').length,
    },
  };
}

/** « 1 project », « 3 projects » — jamais « 1 projects ». */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Le sous-titre de la page : ce que la liste contient, et ce qui attend.
 *
 * « N waiting for you » ne s'écrit PAS à zéro : une phrase qui dit « rien ne
 * t'attend » à chaque chargement finit par ne plus se lire, et la planche ne la
 * dessine que quand il y a quelque chose.
 */
export function workspacesSubtitle(counts: WorkspacesView['counts']): string {
  const parts = [
    plural(counts.total, 'project', 'projects'),
    `${counts.registered} registered, ${counts.detected} detected`,
  ];
  if (counts.waiting > 0) parts.push(`${counts.waiting} waiting for you`);
  return parts.join(' · ');
}
